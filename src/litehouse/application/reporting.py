from __future__ import annotations

import asyncio
import re
import uuid
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast

from litehouse import __version__
from litehouse.application.reviews import ReviewPreparationService
from litehouse.application.schemas import ReportOutputFormat, WatchSpecification
from litehouse.domain import (
    Claim,
    ClaimEvidenceLink,
    ClaimKind,
    EvidenceSegment,
    canonical_json,
    sha256_text,
)
from litehouse.infrastructure.exports import (
    CitationStyle,
    ExportArtifact,
    PartialDate,
    ProvenanceRecord,
    ReferenceMetadata,
    ReferenceRecord,
    serialize_biblatex,
    serialize_bibtex,
    serialize_csl_json,
    serialize_endnote_xml,
    serialize_ris,
)
from litehouse.infrastructure.literature import (
    AccessLevel,
    GroundingError,
    build_evidence_prompt,
    validate_grounded_generation,
)
from litehouse.infrastructure.literature.ranking import RankedLiteratureWork
from litehouse.infrastructure.reports import (
    ReadingRecommendation,
    ReportDocument,
    render_markdown,
    render_plain_text,
)
from litehouse.infrastructure.reports.latex import (
    LatexBuildResult,
    LatexCompilationError,
    LatexCompilerUnavailableError,
    LatexReportError,
    LatexVerificationError,
    build_latex_report,
)
from litehouse.infrastructure.vault.models import (
    ArtifactKind,
    ArtifactSource,
    LibraryItemKind,
    VaultArtifact,
)
from litehouse.infrastructure.vault.repository import VaultRepository

_REPORT_NAMESPACE = uuid.UUID("82fc254a-83b2-4e08-a037-02663d1b9ddf")
_SENTENCE_END = re.compile(r"(?<=[.!?])(?:\s|$)")
_RESPONSE_SHA_LOCATOR = re.compile(r"; response SHA-256 [0-9a-f]{64}")
_MAX_EVIDENCE_SEGMENTS = 50
_MAX_SEGMENT_CHARACTERS = 6000
_MAX_TOTAL_EVIDENCE_CHARACTERS = 60_000
_MAX_EXTRACTIVE_CLAIM_CHARACTERS = 700


class EvidenceSynthesisClient(Protocol):
    async def synthesize(self, prompt: str) -> str | dict[str, object]: ...


class LatexBuilder(Protocol):
    def __call__(self, document: ReportDocument, output_dir: Path) -> LatexBuildResult: ...


class ReportGenerationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class GeneratedArtifactReceipt:
    output_format: str
    artifact_id: str
    artifact_sha256: str
    size: int
    manifest_id: str | None
    manifest_sha256: str | None


@dataclass(frozen=True, slots=True)
class ReportSourceFailure:
    source: str
    code: str
    retryable: bool


@dataclass(frozen=True, slots=True)
class ReportGenerationReceipt:
    report_id: str
    report_document_sha256: str
    preparation_sha256: str
    specification_sha256: str
    generated_at: datetime
    partial: bool
    synthesis_status: str
    requested_citation_style: str
    applied_citation_style: str
    work_count: int
    claim_count: int
    recommendation_count: int
    abstract_evidence_count: int
    full_text_evidence_count: int
    source_receipt_sha256: tuple[str, ...]
    source_evidence_sha256: tuple[str, ...]
    evidence_excerpt_sha256: tuple[str, ...]
    artifacts: tuple[GeneratedArtifactReceipt, ...]
    source_errors: tuple[ReportSourceFailure, ...]
    format_errors: tuple[str, ...]

    @property
    def result_sha256(self) -> str:
        return sha256_text(
            canonical_json(
                {
                    "artifact_sha256": [artifact.artifact_sha256 for artifact in self.artifacts],
                    "format_errors": list(self.format_errors),
                    "partial": self.partial,
                    "preparation_sha256": self.preparation_sha256,
                    "report_document_sha256": self.report_document_sha256,
                    "report_id": self.report_id,
                    "recommendation_count": self.recommendation_count,
                    "source_errors": [
                        {"code": error.code, "source": error.source}
                        for error in self.source_errors
                    ],
                    "synthesis_status": self.synthesis_status,
                }
            )
        )


class ReportGenerationService:
    def __init__(
        self,
        reviews: ReviewPreparationService,
        vault: VaultRepository,
        reports_dir: Path,
        *,
        synthesis_client: EvidenceSynthesisClient | None = None,
        latex_builder: LatexBuilder = build_latex_report,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._reviews = reviews
        self._vault = vault
        self._reports_dir = reports_dir.expanduser().resolve()
        self._synthesis_client = synthesis_client
        self._latex_builder = latex_builder
        self._clock = clock or (lambda: datetime.now(UTC))

    async def generate(
        self,
        specification: WatchSpecification,
        *,
        max_results: int,
        generated_at: datetime | None = None,
        idempotency_key: str | None = None,
    ) -> ReportGenerationReceipt:
        if max_results < 1 or max_results > 100:
            raise ValueError("Report result limits must be between 1 and 100.")
        instant = self._utc(generated_at or self._clock())
        bundle = await self._reviews.prepare_internal(specification)
        prepared = bundle.prepared
        selected = prepared.ranked_works[:max_results]
        specification_sha256 = sha256_text(canonical_json(specification.canonical_payload()))
        report_id = str(
            uuid.uuid5(
                _REPORT_NAMESPACE,
                ":".join(
                    (
                        specification_sha256,
                        prepared.preparation_sha256,
                        instant.isoformat(),
                        (idempotency_key or "").strip(),
                    )
                ),
            )
        )
        evidence, source_evidence_sha256 = self._bounded_evidence(selected)
        references = tuple(self._reference(item, evidence) for item in selected)
        claims, links, synthesis_status = await self._claims(
            report_id=report_id,
            specification=specification,
            evidence=evidence,
        )
        system_claims = self._system_claims(
            report_id,
            synthesis_status=synthesis_status,
            evidence=evidence,
        )
        recommendations = self._recommendations(
            selected,
            evidence=evidence,
            links=links,
            included=specification.include_recommendations,
        )
        citation_style = self._citation_style(specification.citation_style)
        document = ReportDocument(
            id=report_id,
            title=self._title(specification),
            generated_at=instant,
            citation_style=citation_style,
            references=references,
            claims=(*claims, *system_claims),
            evidence_segments=evidence,
            evidence_links=links,
            recommendations=recommendations,
        )
        document_sha256 = self._document_sha256(document)
        source_receipt_sha256 = tuple(
            sorted(
                {
                    value
                    for receipt in bundle.source_receipts
                    for value in (receipt.request_sha256, receipt.content_sha256)
                }
            )
        )
        settings_sha256 = sha256_text(
            canonical_json(
                {
                    "applied_citation_style": citation_style.value,
                    "max_results": max_results,
                    "output_formats": [value.value for value in specification.output_formats],
                    "requested_citation_style": specification.citation_style,
                    "synthesis_status": synthesis_status,
                }
            )
        )
        artifacts, format_errors = await self._render_and_store(
            document=document,
            specification=specification,
            preparation_sha256=prepared.preparation_sha256,
            specification_sha256=specification_sha256,
            source_receipt_sha256=source_receipt_sha256,
            source_evidence_sha256=source_evidence_sha256,
            settings_sha256=settings_sha256,
        )
        if not artifacts:
            raise ReportGenerationError("No requested report artifact could be generated.")
        source_errors = tuple(
            ReportSourceFailure(error.source, error.code, error.retryable)
            for error in prepared.source_errors
        )
        counts = Counter(segment.scope.value for segment in evidence)
        synthesis_partial = synthesis_status in {"rejected_fallback", "error_fallback"}
        return ReportGenerationReceipt(
            report_id=report_id,
            report_document_sha256=document_sha256,
            preparation_sha256=prepared.preparation_sha256,
            specification_sha256=specification_sha256,
            generated_at=instant,
            partial=bool(source_errors or format_errors or synthesis_partial),
            synthesis_status=synthesis_status,
            requested_citation_style=specification.citation_style,
            applied_citation_style=citation_style.value,
            work_count=len(references),
            claim_count=len(claims),
            recommendation_count=len(recommendations),
            abstract_evidence_count=counts["abstract"],
            full_text_evidence_count=counts["full_text"],
            source_receipt_sha256=source_receipt_sha256,
            source_evidence_sha256=source_evidence_sha256,
            evidence_excerpt_sha256=tuple(segment.sha256 for segment in evidence),
            artifacts=artifacts,
            source_errors=source_errors,
            format_errors=format_errors,
        )

    @staticmethod
    def _utc(value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Report timestamps must include a UTC offset.")
        return value.astimezone(UTC)

    @staticmethod
    def _title(specification: WatchSpecification) -> str:
        topic = specification.query or (specification.topics[0] if specification.topics else "")
        return f"Literature review: {topic.strip()}"[:240]

    @staticmethod
    def _citation_style(value: str) -> CitationStyle:
        normalized = value.strip().casefold()
        aliases = {
            "apa": CitationStyle.APA,
            "apa-7": CitationStyle.APA,
            "apa-7th-edition": CitationStyle.APA,
            "ieee": CitationStyle.IEEE,
            "chicago": CitationStyle.CHICAGO_AUTHOR_DATE,
            "chicago-author-date": CitationStyle.CHICAGO_AUTHOR_DATE,
            "mla": CitationStyle.MLA,
            "mla-9": CitationStyle.MLA,
            "vancouver": CitationStyle.VANCOUVER,
            "harvard": CitationStyle.HARVARD_CITE_THEM_RIGHT,
            "harvard-cite-them-right": CitationStyle.HARVARD_CITE_THEM_RIGHT,
        }
        try:
            return aliases[normalized]
        except KeyError:
            raise ValueError(f"Unsupported citation style: {value}") from None

    @staticmethod
    def _recommendations(
        ranked: tuple[RankedLiteratureWork, ...],
        *,
        evidence: tuple[EvidenceSegment, ...],
        links: tuple[ClaimEvidenceLink, ...],
        included: bool,
    ) -> tuple[ReadingRecommendation, ...]:
        if not included:
            return ()
        linked_evidence = {link.evidence_segment_id for link in links}
        return tuple(
            ReadingRecommendation(
                work_id=item.work.work.id,
                rank=item.rank,
                rationale=item.explanation,
                evidence_segment_ids=tuple(
                    segment.id
                    for segment in evidence
                    if segment.work_id == item.work.work.id
                    and segment.id in linked_evidence
                )[:3],
            )
            for item in ranked[:10]
        )

    @staticmethod
    def _bounded_evidence(
        ranked: tuple[RankedLiteratureWork, ...],
    ) -> tuple[tuple[EvidenceSegment, ...], tuple[str, ...]]:
        bounded: list[EvidenceSegment] = []
        original_sha256: list[str] = []
        remaining = _MAX_TOTAL_EVIDENCE_CHARACTERS
        for ranked_work in ranked:
            for source_segment in ranked_work.work.evidence_segments:
                if len(bounded) >= _MAX_EVIDENCE_SEGMENTS or remaining <= 0:
                    break
                maximum = min(_MAX_SEGMENT_CHARACTERS, remaining)
                excerpt = source_segment.text[:maximum]
                if not excerpt:
                    continue
                evidence_id = str(
                    uuid.uuid5(
                        _REPORT_NAMESPACE,
                        f"excerpt:{source_segment.id}:{source_segment.sha256}:{len(excerpt)}",
                    )
                )
                bounded.append(
                    EvidenceSegment(
                        id=evidence_id,
                        work_id=source_segment.work_id,
                        text=excerpt,
                        locator=(
                            _RESPONSE_SHA_LOCATOR.sub(
                                "; source response SHA-256 recorded in manifest",
                                source_segment.locator,
                            )
                            + "; bounded excerpt"
                        ),
                        scope=source_segment.scope,
                    )
                )
                original_sha256.append(source_segment.sha256)
                remaining -= len(excerpt)
        return tuple(bounded), tuple(sorted(set(original_sha256)))

    @staticmethod
    def _reference(
        item: RankedLiteratureWork,
        selected_evidence: tuple[EvidenceSegment, ...],
    ) -> ReferenceRecord:
        work = item.work
        issued = (
            PartialDate(
                work.publication_date.year,
                work.publication_date.month,
                work.publication_date.day,
            )
            if work.publication_date
            else None
        )
        scopes = {
            segment.scope.value
            for segment in selected_evidence
            if segment.work_id == work.work.id
        }
        warnings: list[str] = []
        if "abstract" in scopes:
            if work.access_level is AccessLevel.ABSTRACT_ONLY:
                warnings.append("Evidence is abstract-only; paid full text was not accessed.")
            else:
                warnings.append(
                    "An open full-text link was identified, but this report used abstract "
                    "evidence; full text was not inspected."
                )
        if "full_text" in scopes:
            warnings.append("Full-text evidence is explicitly marked in the evidence ledger.")
        return ReferenceRecord(
            work=work.work,
            metadata=ReferenceMetadata(
                issued=issued,
                container_title=work.venue,
                language=work.language,
                url=work.landing_url or work.open_full_text_url,
                license_url=work.license_url,
                provenance=tuple(
                    ProvenanceRecord(
                        source=record.source,
                        record_id=record.source_record_id,
                        retrieved_at=record.retrieved_at,
                        url=record.landing_url,
                        sha256=record.content_sha256,
                    )
                    for record in work.records
                ),
                attachment_warnings=tuple(warnings),
            ),
        )

    async def _claims(
        self,
        *,
        report_id: str,
        specification: WatchSpecification,
        evidence: tuple[EvidenceSegment, ...],
    ) -> tuple[tuple[Claim, ...], tuple[ClaimEvidenceLink, ...], str]:
        if not evidence:
            return (), (), "no_findings"
        if self._synthesis_client is not None:
            try:
                payload = await self._synthesis_client.synthesize(
                    build_evidence_prompt(
                        topic=specification.query or " ".join(specification.topics),
                        expertise=specification.expertise.ordered_levels[0].value,
                        prior_knowledge=specification.expertise.prior_knowledge,
                        evidence=evidence,
                        maximum_segment_characters=_MAX_SEGMENT_CHARACTERS,
                    )
                )
                grounded = validate_grounded_generation(payload, evidence=evidence)
                if grounded:
                    synthesized_claims: list[Claim] = []
                    synthesized_links: list[ClaimEvidenceLink] = []
                    for item in grounded:
                        claim_id = str(
                            uuid.uuid5(
                                _REPORT_NAMESPACE,
                                f"claim:{report_id}:{item.candidate.claim_id}",
                            )
                        )
                        synthesized_claims.append(
                            Claim(id=claim_id, report_id=report_id, text=item.candidate.text)
                        )
                        synthesized_links.extend(
                            ClaimEvidenceLink(claim_id, evidence_id)
                            for evidence_id in item.candidate.evidence_ids
                        )
                    return (
                        tuple(synthesized_claims),
                        tuple(synthesized_links),
                        "validated",
                    )
                status = "rejected_fallback"
            except (GroundingError, ValueError, TypeError, KeyError):
                status = "rejected_fallback"
            except Exception:
                status = "error_fallback"
            fallback_claims, fallback_links = self._extractive_claims(report_id, evidence)
            return fallback_claims, fallback_links, status
        extractive_claims, extractive_links = self._extractive_claims(report_id, evidence)
        return extractive_claims, extractive_links, "extractive"

    @staticmethod
    def _extractive_claims(
        report_id: str,
        evidence: tuple[EvidenceSegment, ...],
    ) -> tuple[tuple[Claim, ...], tuple[ClaimEvidenceLink, ...]]:
        claims: list[Claim] = []
        links: list[ClaimEvidenceLink] = []
        used_work_ids: set[str] = set()
        for segment in evidence:
            if segment.work_id in used_work_ids:
                continue
            sentence = _SENTENCE_END.split(segment.text.strip(), maxsplit=1)[0]
            text = sentence[:_MAX_EXTRACTIVE_CLAIM_CHARACTERS].strip()
            if not text:
                continue
            claim_id = str(
                uuid.uuid5(
                    _REPORT_NAMESPACE,
                    f"extractive:{report_id}:{segment.id}:{sha256_text(text)}",
                )
            )
            claims.append(Claim(id=claim_id, report_id=report_id, text=text))
            links.append(ClaimEvidenceLink(claim_id, segment.id))
            used_work_ids.add(segment.work_id)
        return tuple(claims), tuple(links)

    @staticmethod
    def _system_claims(
        report_id: str,
        *,
        synthesis_status: str,
        evidence: tuple[EvidenceSegment, ...],
    ) -> tuple[Claim, ...]:
        notes = [
            "Evidence scope is recorded per excerpt; an open full-text link does not mean "
            "Litehouse inspected the full text.",
        ]
        if not evidence:
            notes.append("No evidence-supported finding met the retrieval contract.")
        if synthesis_status in {"rejected_fallback", "error_fallback"}:
            notes.append(
                "Optional synthesis did not pass the evidence lock; the report uses bounded "
                "extractive findings instead."
            )
        return tuple(
            Claim(
                id=str(uuid.uuid5(_REPORT_NAMESPACE, f"system:{report_id}:{index}:{text}")),
                report_id=report_id,
                text=text,
                kind=ClaimKind.SYSTEM,
            )
            for index, text in enumerate(notes)
        )

    @staticmethod
    def _document_sha256(document: ReportDocument) -> str:
        return sha256_text(
            canonical_json(
                {
                    "claims": [
                        {"id": claim.id, "kind": claim.kind.value, "text": claim.text}
                        for claim in document.claims
                    ],
                    "evidence": [
                        {
                            "id": segment.id,
                            "scope": segment.scope.value,
                            "sha256": segment.sha256,
                            "work_id": segment.work_id,
                        }
                        for segment in document.evidence_segments
                    ],
                    "generated_at": document.generated_at.isoformat(),
                    "links": [
                        {
                            "claim_id": link.claim_id,
                            "evidence_id": link.evidence_segment_id,
                            "relation": link.relation.value,
                        }
                        for link in document.evidence_links
                    ],
                    "references": [record.work.id for record in document.references],
                    "citation_style": document.citation_style.value,
                    "recommendations": [
                        {
                            "evidence_segment_ids": list(item.evidence_segment_ids),
                            "rank": item.rank,
                            "rationale": list(item.rationale),
                            "work_id": item.work_id,
                        }
                        for item in document.recommendations
                    ],
                    "report_id": document.id,
                }
            )
        )

    async def _render_and_store(
        self,
        *,
        document: ReportDocument,
        specification: WatchSpecification,
        preparation_sha256: str,
        specification_sha256: str,
        source_receipt_sha256: tuple[str, ...],
        source_evidence_sha256: tuple[str, ...],
        settings_sha256: str,
    ) -> tuple[tuple[GeneratedArtifactReceipt, ...], tuple[str, ...]]:
        item = await self._vault.add_library_item(
            title=f"{document.title} [{document.id[:8]}]",
            kind=LibraryItemKind.REPORT,
        )
        artifacts: list[GeneratedArtifactReceipt] = []
        format_errors: list[str] = []
        common: dict[str, object] = {
            "library_item_id": item.id,
            "input_sha256": (specification_sha256, preparation_sha256),
            "evidence_sha256": (
                *source_evidence_sha256,
                *(segment.sha256 for segment in document.evidence_segments),
            ),
            "source_receipt_sha256": source_receipt_sha256,
            "generator_version_sha256": sha256_text(__version__),
            "generation_settings_sha256": settings_sha256,
        }
        source = ArtifactSource(
            name="Litehouse evidence-locked report generator",
            receipt_sha256=preparation_sha256,
        )
        if ReportOutputFormat.MARKDOWN in specification.output_formats:
            artifact = await self._vault.add_artifact_bytes(
                library_item_id=item.id,
                kind=ArtifactKind.REPORT_MARKDOWN,
                media_type="text/markdown",
                content=render_markdown(document).encode(),
                source=source,
            )
            artifacts.append(
                await self._artifact_receipt("markdown", artifact, common=common)
            )
        if ReportOutputFormat.PLAIN_TEXT in specification.output_formats:
            artifact = await self._vault.add_artifact_bytes(
                library_item_id=item.id,
                kind=ArtifactKind.REPORT_TEXT,
                media_type="text/plain",
                content=render_plain_text(document).encode(),
                source=source,
            )
            artifacts.append(
                await self._artifact_receipt("plain_text", artifact, common=common)
            )
        if ReportOutputFormat.LATEX_PDF in specification.output_formats:
            output_dir = self._reports_dir / document.id
            try:
                latex = await asyncio.to_thread(self._latex_builder, document, output_dir)
            except LatexCompilerUnavailableError:
                format_errors.append("latex_compiler_unavailable")
            except LatexCompilationError:
                format_errors.append("latex_compilation_failed")
            except LatexVerificationError:
                format_errors.append("latex_verification_failed")
            except (LatexReportError, OSError):
                format_errors.append("latex_output_failed")
            else:
                latex_common = {
                    **common,
                    "template_sha256": latex.manifest.template_sha256,
                    "logo_sha256": latex.manifest.logo_sha256,
                }
                tex = await self._vault.add_artifact_file(
                    library_item_id=item.id,
                    kind=ArtifactKind.REPORT_LATEX,
                    media_type="application/x-tex",
                    path=latex.tex_path,
                    source=source,
                )
                pdf = await self._vault.add_artifact_file(
                    library_item_id=item.id,
                    kind=ArtifactKind.REPORT_PDF,
                    media_type="application/pdf",
                    path=latex.pdf_path,
                    source=source,
                )
                await self._vault.add_artifact_file(
                    library_item_id=item.id,
                    kind=ArtifactKind.SUPPLEMENTARY,
                    media_type="application/json",
                    path=latex.manifest_path,
                    source=source,
                )
                artifacts.extend(
                    (
                        await self._artifact_receipt(
                            "latex_source", tex, common=latex_common
                        ),
                        await self._artifact_receipt("latex_pdf", pdf, common=latex_common),
                    )
                )
        try:
            await self._store_reference_exports(
                library_item_id=item.id,
                references=document.references,
                citation_style=document.citation_style,
                source=source,
            )
        except ValueError:
            format_errors.append("reference_exports_unavailable")
        return tuple(artifacts), tuple(format_errors)

    async def _store_reference_exports(
        self,
        *,
        library_item_id: str,
        references: tuple[ReferenceRecord, ...],
        citation_style: CitationStyle,
        source: ArtifactSource,
    ) -> None:
        serializers = (
            serialize_csl_json,
            serialize_ris,
            serialize_bibtex,
            serialize_biblatex,
            serialize_endnote_xml,
        )
        rendered: tuple[ExportArtifact, ...] = tuple(
            serializer(references, style=citation_style) for serializer in serializers
        )
        for export in rendered:
            await self._vault.add_artifact_bytes(
                library_item_id=library_item_id,
                kind=ArtifactKind.REFERENCE_EXPORT,
                media_type=export.media_type,
                content=export.content.encode("utf-8"),
                source=source,
            )

    async def _artifact_receipt(
        self,
        output_format: str,
        artifact: VaultArtifact,
        *,
        common: Mapping[str, object],
    ) -> GeneratedArtifactReceipt:
        manifest = await self._vault.create_report_manifest(
            report_artifact_id=artifact.id,
            input_sha256=cast(Sequence[str], common["input_sha256"]),
            evidence_sha256=cast(Sequence[str], common["evidence_sha256"]),
            source_receipt_sha256=cast(
                Sequence[str], common["source_receipt_sha256"]
            ),
            template_sha256=cast(str | None, common.get("template_sha256")),
            logo_sha256=cast(str | None, common.get("logo_sha256")),
            generator_version_sha256=cast(str, common["generator_version_sha256"]),
            generation_settings_sha256=cast(
                str, common["generation_settings_sha256"]
            ),
        )
        return GeneratedArtifactReceipt(
            output_format=output_format,
            artifact_id=artifact.id,
            artifact_sha256=artifact.blob.sha256,
            size=artifact.blob.size,
            manifest_id=manifest.id,
            manifest_sha256=manifest.manifest_sha256,
        )
