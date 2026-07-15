from __future__ import annotations

import html
import re
from collections.abc import Iterable
from typing import Protocol
from urllib.parse import urlsplit

from litehouse.domain import (
    Claim,
    ClaimEvidenceLink,
    ClaimEvidenceRelation,
    ClaimKind,
    EvidenceSegment,
    sha256_text,
)
from litehouse.infrastructure.exports import (
    CitationRenderer,
    ProvenanceRecord,
    ReferenceRecord,
    citation_style_label,
    citation_warnings,
    format_reference_citation,
)
from litehouse.infrastructure.reports.models import (
    ReadingRecommendation,
    ReportDocument,
    ReportIntegrityError,
    UnsupportedClaimError,
    UnsupportedClaimPolicy,
)

_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MARKDOWN_SPECIAL = re.compile(r"([`*_[\]{}#|])")


class _Identified(Protocol):
    @property
    def id(self) -> str: ...


def _plain(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL_PATTERN.sub("", normalized)


def _markdown(value: str) -> str:
    escaped = html.escape(_plain(value).replace("\\", "\\\\"), quote=False)
    return _MARKDOWN_SPECIAL.sub(r"\\\1", escaped)


def _markdown_url(value: str) -> str:
    cleaned = _plain(value).strip()
    try:
        parsed = urlsplit(cleaned)
    except ValueError:
        return _markdown(cleaned)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return _markdown(cleaned)
    return f"<{html.escape(cleaned, quote=True)}>"


def _unique_ids(items: Iterable[_Identified], *, label: str) -> None:
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ReportIntegrityError(f"{label} IDs must be unique.")


def _validate(document: ReportDocument) -> tuple[str, ...]:
    _unique_ids((record.work for record in document.references), label="Work")
    _unique_ids(document.claims, label="Claim")
    _unique_ids(document.evidence_segments, label="Evidence segment")
    work_ids = {record.work.id for record in document.references}
    claims = {claim.id: claim for claim in document.claims}
    evidence = {segment.id: segment for segment in document.evidence_segments}
    if len(document.recommendations) > 10:
        raise ReportIntegrityError("A bounded reading list can contain at most ten works.")
    recommendation_work_ids = [item.work_id for item in document.recommendations]
    if len(recommendation_work_ids) != len(set(recommendation_work_ids)):
        raise ReportIntegrityError("Recommendation Work IDs must be unique.")
    recommendation_ranks = [item.rank for item in document.recommendations]
    if len(recommendation_ranks) != len(set(recommendation_ranks)):
        raise ReportIntegrityError("Recommendation ranks must be unique.")
    linked_evidence_ids = {link.evidence_segment_id for link in document.evidence_links}
    for recommendation in document.recommendations:
        if recommendation.work_id not in work_ids:
            raise ReportIntegrityError(
                f"Recommendation refers to unknown Work {recommendation.work_id}."
            )
        for segment_id in recommendation.evidence_segment_ids:
            segment = evidence.get(segment_id)
            if segment is None:
                raise ReportIntegrityError(
                    f"Recommendation refers to unknown evidence segment {segment_id}."
                )
            if segment.work_id != recommendation.work_id:
                raise ReportIntegrityError(
                    "Recommendation evidence must belong to the recommended Work."
                )
            if segment_id not in linked_evidence_ids:
                raise ReportIntegrityError(
                    "Recommendation evidence must appear in the report evidence ledger."
                )
    for claim in document.claims:
        if claim.report_id != document.id:
            raise ReportIntegrityError(f"Claim {claim.id} belongs to another report.")
    for segment in document.evidence_segments:
        if segment.work_id not in work_ids:
            raise ReportIntegrityError(
                f"Evidence segment {segment.id} refers to an unknown Work."
            )
        if sha256_text(segment.text) != segment.sha256:
            raise ReportIntegrityError(f"Evidence segment {segment.id} failed its SHA-256 check.")
    link_pairs: set[tuple[str, str]] = set()
    supported_claim_ids: set[str] = set()
    for link in document.evidence_links:
        if link.claim_id not in claims:
            raise ReportIntegrityError(f"Evidence link refers to unknown claim {link.claim_id}.")
        if link.evidence_segment_id not in evidence:
            raise ReportIntegrityError(
                f"Evidence link refers to unknown segment {link.evidence_segment_id}."
            )
        pair = (link.claim_id, link.evidence_segment_id)
        if pair in link_pairs:
            raise ReportIntegrityError("Claim-to-evidence links must be unique.")
        link_pairs.add(pair)
        if link.relation is ClaimEvidenceRelation.SUPPORTS:
            supported_claim_ids.add(link.claim_id)
    return tuple(
        sorted(
            claim.id
            for claim in document.claims
            if claim.kind is ClaimKind.SOURCED and claim.id not in supported_claim_ids
        )
    )


def _ordered_references(document: ReportDocument) -> tuple[ReferenceRecord, ...]:
    return tuple(sorted(document.references, key=lambda record: record.work.id))


def _ordered_claims(document: ReportDocument) -> tuple[Claim, ...]:
    return tuple(sorted(document.claims, key=lambda claim: claim.id))


def _ordered_recommendations(
    document: ReportDocument,
) -> tuple[ReadingRecommendation, ...]:
    return tuple(sorted(document.recommendations, key=lambda item: (item.rank, item.work_id)))


def _anchor(kind: str, identifier: str) -> str:
    return f"litehouse-{kind}-{sha256_text(identifier)[:16]}"


def _links_by_claim(
    document: ReportDocument,
) -> dict[str, tuple[tuple[ClaimEvidenceLink, EvidenceSegment], ...]]:
    evidence = {segment.id: segment for segment in document.evidence_segments}
    links: dict[str, list[tuple[ClaimEvidenceLink, EvidenceSegment]]] = {}
    for link in sorted(
        document.evidence_links,
        key=lambda item: (item.claim_id, item.evidence_segment_id, item.relation.value),
    ):
        links.setdefault(link.claim_id, []).append((link, evidence[link.evidence_segment_id]))
    return {claim_id: tuple(items) for claim_id, items in links.items()}


def _provenance(provenance: ProvenanceRecord) -> str:
    parts = [
        provenance.source,
        f"record {provenance.record_id}",
        f"retrieved {provenance.retrieved_at.isoformat()}",
    ]
    if provenance.url is not None:
        parts.append(provenance.url)
    if provenance.sha256 is not None:
        parts.append(f"SHA-256 {provenance.sha256}")
    return "; ".join(parts)


def _source_facts(record: ReferenceRecord) -> tuple[str, ...]:
    metadata = record.metadata
    facts: list[str] = [record.work.kind.value]
    if metadata.issued is not None:
        facts.append(metadata.issued.isoformat)
    if record.work.contributors:
        facts.append(
            ", ".join(
                f"{contributor.name} ({contributor.role})"
                for contributor in record.work.contributors
            )
        )
    if metadata.container_title is not None:
        facts.append(metadata.container_title)
    if metadata.publisher is not None:
        facts.append(metadata.publisher)
    facts.extend(
        f"{identifier.namespace}:{identifier.value}"
        for identifier in sorted(
            record.work.identifiers, key=lambda item: (item.namespace, item.value)
        )
    )
    if metadata.url is not None:
        facts.append(metadata.url)
    if metadata.license_name is not None or metadata.license_url is not None:
        license_text = metadata.license_name or "unspecified license"
        if metadata.license_url is not None:
            license_text = f"{license_text} ({metadata.license_url})"
        facts.append(f"License: {license_text}")
    facts.extend(f"Provenance: {_provenance(item)}" for item in metadata.provenance)
    facts.extend(f"Attachment warning: {warning}" for warning in metadata.attachment_warnings)
    return tuple(facts)


def _missing_citation_warnings(record: ReferenceRecord) -> tuple[str, ...]:
    return tuple(
        warning for warning in citation_warnings(record) if "unavailable" in warning.casefold()
    )


def _prepare(
    document: ReportDocument, policy: UnsupportedClaimPolicy
) -> tuple[
    tuple[str, ...],
    dict[str, str],
    dict[str, tuple[tuple[ClaimEvidenceLink, EvidenceSegment], ...]],
]:
    unsupported = _validate(document)
    if unsupported and policy is UnsupportedClaimPolicy.REFUSE:
        raise UnsupportedClaimError(unsupported)
    source_labels = {
        record.work.id: f"W{index}"
        for index, record in enumerate(_ordered_references(document), start=1)
    }
    return unsupported, source_labels, _links_by_claim(document)


def render_markdown(
    document: ReportDocument,
    *,
    unsupported_policy: UnsupportedClaimPolicy = UnsupportedClaimPolicy.REFUSE,
) -> str:
    unsupported, source_labels, links_by_claim = _prepare(document, unsupported_policy)
    unsupported_set = set(unsupported)
    lines = [
        f"# {_markdown(document.title)}",
        "",
        f"Generated: `{document.generated_at.isoformat()}`",
        f"Citation style: {_markdown(citation_style_label(document.citation_style))} "
        f"(`{document.citation_style.value}`)",
        "",
        "Source entries apply the requested citation style only to available metadata. "
        "Missing fields are visibly marked; contributor name parts are never inferred.",
        "",
        "## Supported findings",
        "",
    ]
    supported = [
        claim
        for claim in _ordered_claims(document)
        if claim.kind is ClaimKind.SOURCED and claim.id not in unsupported_set
    ]
    if not supported:
        lines.append("No evidence-supported findings were supplied.")
    for claim in supported:
        linked = links_by_claim.get(claim.id, ())
        citations = sorted(
            {
                source_labels[segment.work_id]
                for link, segment in linked
                if link.relation is ClaimEvidenceRelation.SUPPORTS
            }
        )
        lines.append(f"- {_markdown(claim.text)} [{'; '.join(citations)}]")
    system_claims = [claim for claim in _ordered_claims(document) if claim.kind is ClaimKind.SYSTEM]
    if system_claims:
        lines.extend(["", "## System notes", ""])
        lines.extend(f"- {_markdown(claim.text)}" for claim in system_claims)
    if unsupported:
        lines.extend(["", "## Unsupported claims", ""])
        lines.append("These claims are excluded from the supported findings above.")
        lines.append("")
        lines.extend(
            f"- **UNSUPPORTED:** {_markdown(claim.text)}"
            for claim in _ordered_claims(document)
            if claim.id in unsupported_set
        )
    if document.recommendations:
        evidence = {segment.id: segment for segment in document.evidence_segments}
        references = {record.work.id: record for record in document.references}
        lines.extend(
            [
                "",
                "## Bounded reading list",
                "",
                "These recommendations prioritize closer reading using the visible retrieval "
                "and ranking signals below. They do not establish scientific truth, study "
                "quality, or fitness for a particular use.",
                "",
            ]
        )
        for recommendation in _ordered_recommendations(document):
            record = references[recommendation.work_id]
            source_label = source_labels[recommendation.work_id]
            rationale = "; ".join(_markdown(item) for item in recommendation.rationale)
            evidence_links = ", ".join(
                (
                    f"[evidence `{_markdown(segment_id)}`]"
                    f"(#{_anchor('evidence', segment_id)})"
                    f" ({_markdown(evidence[segment_id].scope.value)})"
                )
                for segment_id in recommendation.evidence_segment_ids
            )
            if not evidence_links:
                evidence_links = "No report evidence excerpt was available for this work."
            lines.extend(
                [
                    f"{recommendation.rank}. [{source_label}]"
                    f"(#{_anchor('source', recommendation.work_id)}) "
                    f"**{_markdown(record.work.title)}**",
                    f"   - Ranking rationale: {rationale}",
                    f"   - Evidence links: {evidence_links}",
                ]
            )
    lines.extend(["", "## Sources", ""])
    for record in _ordered_references(document):
        lines.append(f'<a id="{_anchor("source", record.work.id)}"></a>')
        citation = format_reference_citation(
            record,
            document.citation_style,
            renderer=CitationRenderer(
                escape=_markdown,
                italic=lambda value: f"*{value}*",
                url=_markdown_url,
            ),
        )
        facts = "; ".join(_markdown(fact) for fact in _source_facts(record))
        lines.append(f"- [{source_labels[record.work.id]}] {citation}")
        lines.append(f"  - Verified metadata and provenance: {facts}")
        lines.extend(
            f"  - Citation warning: {_markdown(warning)}"
            for warning in _missing_citation_warnings(record)
        )
    lines.extend(["", "## Evidence ledger", ""])
    if not document.evidence_links:
        lines.append("No claim-to-evidence links were supplied.")
    evidence = {segment.id: segment for segment in document.evidence_segments}
    anchored_evidence: set[str] = set()
    for link in sorted(
        document.evidence_links,
        key=lambda item: (item.claim_id, item.evidence_segment_id, item.relation.value),
    ):
        segment = evidence[link.evidence_segment_id]
        anchor_line = ""
        if segment.id not in anchored_evidence:
            anchor_line = f'<a id="{_anchor("evidence", segment.id)}"></a>'
            anchored_evidence.add(segment.id)
        lines.extend(
            [
                anchor_line,
                f"### Claim `{_markdown(link.claim_id)}` / evidence `{_markdown(segment.id)}`",
                "",
                f"- Relation: `{link.relation.value}`",
                f"- Work: `[{source_labels[segment.work_id]}]`",
                f"- Scope: `{segment.scope.value}`",
                f"- Locator: {_markdown(segment.locator)}",
                f"- SHA-256: `{segment.sha256}`",
                "",
            ]
        )
        lines.extend(f"> {_markdown(line)}" if line else ">" for line in segment.text.split("\n"))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_plain_text(
    document: ReportDocument,
    *,
    unsupported_policy: UnsupportedClaimPolicy = UnsupportedClaimPolicy.REFUSE,
) -> str:
    unsupported, source_labels, links_by_claim = _prepare(document, unsupported_policy)
    unsupported_set = set(unsupported)
    lines = [
        _plain(document.title),
        "=" * len(_plain(document.title)),
        f"Generated: {document.generated_at.isoformat()}",
        f"Citation style: {citation_style_label(document.citation_style)} "
        f"({document.citation_style.value})",
        "Source entries apply the requested citation style only to available metadata. "
        "Missing fields are visibly marked; contributor name parts are never inferred.",
        "",
        "SUPPORTED FINDINGS",
    ]
    supported = [
        claim
        for claim in _ordered_claims(document)
        if claim.kind is ClaimKind.SOURCED and claim.id not in unsupported_set
    ]
    if not supported:
        lines.append("No evidence-supported findings were supplied.")
    for claim in supported:
        linked = links_by_claim.get(claim.id, ())
        citations = sorted(
            {
                source_labels[segment.work_id]
                for link, segment in linked
                if link.relation is ClaimEvidenceRelation.SUPPORTS
            }
        )
        lines.append(f"- {_plain(claim.text)} [{'; '.join(citations)}]")
    system_claims = [claim for claim in _ordered_claims(document) if claim.kind is ClaimKind.SYSTEM]
    if system_claims:
        lines.extend(["", "SYSTEM NOTES"])
        lines.extend(f"- {_plain(claim.text)}" for claim in system_claims)
    if unsupported:
        lines.extend(
            [
                "",
                "UNSUPPORTED CLAIMS",
                "These claims are excluded from the supported findings above.",
            ]
        )
        lines.extend(
            f"- UNSUPPORTED: {_plain(claim.text)}"
            for claim in _ordered_claims(document)
            if claim.id in unsupported_set
        )
    if document.recommendations:
        evidence = {segment.id: segment for segment in document.evidence_segments}
        references = {record.work.id: record for record in document.references}
        lines.extend(
            [
                "",
                "BOUNDED READING LIST",
                "These recommendations prioritize closer reading using the visible retrieval "
                "and ranking signals below. They do not establish scientific truth, study "
                "quality, or fitness for a particular use.",
            ]
        )
        for recommendation in _ordered_recommendations(document):
            record = references[recommendation.work_id]
            source_label = source_labels[recommendation.work_id]
            lines.extend(
                [
                    f"{recommendation.rank}. [{source_label}] {_plain(record.work.title)}",
                    "   Ranking rationale: "
                    + "; ".join(_plain(item) for item in recommendation.rationale),
                ]
            )
            if recommendation.evidence_segment_ids:
                lines.append(
                    "   Evidence cross-references: "
                    + ", ".join(
                        f"{segment_id} ({evidence[segment_id].scope.value})"
                        for segment_id in recommendation.evidence_segment_ids
                    )
                )
            else:
                lines.append(
                    "   Evidence cross-references: No report evidence excerpt was available "
                    "for this work."
                )
    lines.extend(["", "SOURCES"])
    for record in _ordered_references(document):
        citation = format_reference_citation(record, document.citation_style)
        facts = "; ".join(_plain(fact) for fact in _source_facts(record))
        lines.append(f"- [{source_labels[record.work.id]}] {citation}")
        lines.append(f"  Verified metadata and provenance: {facts}")
        lines.extend(
            f"  Citation warning: {_plain(warning)}"
            for warning in _missing_citation_warnings(record)
        )
    lines.extend(["", "EVIDENCE LEDGER"])
    if not document.evidence_links:
        lines.append("No claim-to-evidence links were supplied.")
    evidence = {segment.id: segment for segment in document.evidence_segments}
    for link in sorted(
        document.evidence_links,
        key=lambda item: (item.claim_id, item.evidence_segment_id, item.relation.value),
    ):
        segment = evidence[link.evidence_segment_id]
        lines.extend(
            [
                f"Claim {link.claim_id} / evidence {segment.id}",
                f"Relation: {link.relation.value}",
                f"Work: [{source_labels[segment.work_id]}]",
                f"Scope: {segment.scope.value}",
                f"Locator: {_plain(segment.locator)}",
                f"SHA-256: {segment.sha256}",
                _plain(segment.text),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"
