from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol

from litehouse.domain import canonical_json
from litehouse.infrastructure.blobs import BlobIntegrityError, BlobRef
from litehouse.infrastructure.documents.client import OpenAccessDocumentDownloader
from litehouse.infrastructure.documents.models import (
    AccessAssertion,
    DocumentProvider,
    DocumentRequest,
    DocumentResult,
    OpenAccessEvidence,
)
from litehouse.infrastructure.documents.policy import DOCUMENT_POLICY, DocumentPolicyError
from litehouse.infrastructure.vault.models import (
    Annotation,
    AnnotationKind,
    ArtifactKind,
    ArtifactSource,
    BlobVerification,
    LibraryItem,
    LibraryItemKind,
    ManifestVerification,
    ReadingProgress,
    VaultArtifact,
    VaultBlobRef,
)
from litehouse.infrastructure.vault.repository import VaultRepository
from litehouse.infrastructure.vault.store import VaultBlobStore, VaultIntegrityError

_MAX_EXPORT_BYTES = 8 * 1024 * 1024
MAX_READER_PDF_BYTES = 100 * 1024 * 1024
_PDF_ARTIFACT_KINDS = frozenset({ArtifactKind.ARTICLE_PDF, ArtifactKind.REPORT_PDF})
_EXPORTABLE_ARTIFACT_MEDIA_TYPES = {
    ArtifactKind.ARTICLE_PDF: frozenset({"application/pdf"}),
    ArtifactKind.REPORT_PDF: frozenset({"application/pdf"}),
    ArtifactKind.REPORT_MARKDOWN: frozenset({"text/markdown"}),
    ArtifactKind.REPORT_TEXT: frozenset({"text/plain"}),
    ArtifactKind.REPORT_LATEX: frozenset({"application/x-tex"}),
    ArtifactKind.REFERENCE_EXPORT: frozenset(
        {
            "application/vnd.citationstyles.csl+json",
            "application/x-research-info-systems",
            "application/x-bibtex",
            "application/x-biblatex",
            "application/xml",
        }
    ),
}
_OPEN_ACCESS_EVIDENCE_URLS = {
    DocumentProvider.ARXIV: "https://info.arxiv.org/help/license/index.html",
    DocumentProvider.PMC: "https://pmc.ncbi.nlm.nih.gov/tools/openftlist/",
}
_PROVIDER_LABELS = {
    DocumentProvider.ARXIV: "arXiv",
    DocumentProvider.PMC: "PubMed Central",
}


class LibraryExportTooLargeError(ValueError):
    pass


class LibraryArtifactNotPdfError(ValueError):
    pass


class LibraryPdfTooLargeError(ValueError):
    pass


class LibraryArtifactNotExportableError(ValueError):
    pass


class LibraryAcquisitionError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class DocumentAcquirer(Protocol):
    async def acquire(self, request: DocumentRequest) -> DocumentResult: ...


class VaultDocumentBlobStore:
    def __init__(self, blobs: VaultBlobStore) -> None:
        self._blobs = blobs

    def put_verified_file(
        self,
        source: Path,
        *,
        expected_sha256: str,
        size: int,
    ) -> BlobRef:
        try:
            reference = self._blobs.put_file(source)
        except (OSError, VaultIntegrityError) as error:
            raise BlobIntegrityError("Vault rejected the downloaded document.") from error
        if reference.sha256 != expected_sha256 or reference.size != size:
            raise BlobIntegrityError("Downloaded document does not match its vault receipt.")
        return BlobRef(
            sha256=reference.sha256,
            size=reference.size,
            relative_path=reference.relative_path,
        )


@dataclass(frozen=True, slots=True)
class NoteExport:
    content: bytes
    media_type: str
    sha256: str


@dataclass(frozen=True, slots=True)
class ReaderArtifact:
    item: LibraryItem
    artifact: VaultArtifact


@dataclass(frozen=True, slots=True)
class ReaderPdfContent:
    artifact: VaultArtifact
    content: bytes


@dataclass(frozen=True, slots=True)
class ExportableArtifactContent:
    artifact: VaultArtifact
    content: bytes


@dataclass(frozen=True, slots=True)
class OpenAccessAcquisition:
    item: LibraryItem
    pdf_artifact: VaultArtifact
    receipt_artifact: VaultArtifact
    access_assertion: AccessAssertion
    reuse_license_verified: bool


class LibraryHttpService:
    def __init__(
        self,
        repository: VaultRepository,
        blobs: VaultBlobStore,
        *,
        document_acquirer: DocumentAcquirer | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._repository = repository
        self._blobs = blobs
        self._clock = clock or (lambda: datetime.now(UTC))
        self._document_acquirer = document_acquirer or OpenAccessDocumentDownloader(
            VaultDocumentBlobStore(blobs)
        )

    async def list_items(self, *, offset: int, limit: int) -> Sequence[LibraryItem]:
        items = await self._repository.list_library_items()
        return items[offset : offset + limit]

    async def list_artifacts(
        self,
        library_item_id: str,
        *,
        offset: int,
        limit: int,
    ) -> Sequence[VaultArtifact]:
        await self._repository.get_library_item(library_item_id)
        artifacts = await self._repository.list_artifacts(library_item_id)
        return artifacts[offset : offset + limit]

    async def get_reader_artifact(self, library_item_id: str) -> ReaderArtifact:
        item = await self._repository.get_library_item(library_item_id)
        artifacts = await self._repository.list_artifacts(library_item_id)
        candidates = [artifact for artifact in artifacts if self._is_reader_pdf(artifact)]
        if not candidates:
            raise LibraryArtifactNotPdfError(library_item_id)
        artifact = min(
            candidates,
            key=lambda value: (
                value.kind is not ArtifactKind.ARTICLE_PDF,
                value.created_at,
                value.id,
            ),
        )
        return ReaderArtifact(item=item, artifact=artifact)

    async def read_reader_pdf(self, artifact_id: str) -> ReaderPdfContent:
        artifact = await self._repository.get_artifact(artifact_id)
        if not self._is_reader_pdf(artifact):
            raise LibraryArtifactNotPdfError(artifact_id)
        if artifact.blob.size > MAX_READER_PDF_BYTES:
            raise LibraryPdfTooLargeError(artifact_id)
        content = await asyncio.to_thread(self._blobs.read, artifact.blob)
        if not content.startswith(b"%PDF-"):
            raise LibraryArtifactNotPdfError(artifact_id)
        return ReaderPdfContent(artifact=artifact, content=content)

    async def read_exportable_artifact(self, artifact_id: str) -> ExportableArtifactContent:
        artifact = await self._repository.get_artifact(artifact_id)
        allowed_media_types = _EXPORTABLE_ARTIFACT_MEDIA_TYPES.get(artifact.kind)
        if allowed_media_types is None or artifact.media_type not in allowed_media_types:
            raise LibraryArtifactNotExportableError(artifact_id)
        if artifact.blob.size > MAX_READER_PDF_BYTES:
            raise LibraryExportTooLargeError(artifact_id)
        content = await asyncio.to_thread(self._blobs.read, artifact.blob)
        return ExportableArtifactContent(artifact=artifact, content=content)

    async def acquire_open_access_pdf(
        self,
        *,
        provider: DocumentProvider,
        repository_id: str,
        exact_pdf_path: str | None,
        title: str,
    ) -> OpenAccessAcquisition:
        normalized_title = " ".join(title.split())
        if not normalized_title or len(normalized_title) > 1_000:
            raise LibraryAcquisitionError(
                "document_request_rejected",
                "The library title is invalid.",
            )
        if provider is DocumentProvider.ARXIV:
            if exact_pdf_path is not None:
                raise LibraryAcquisitionError(
                    "document_request_rejected",
                    "arXiv PDF paths are derived from the identifier.",
                )
            path = f"/pdf/{repository_id}"
        else:
            if exact_pdf_path is None:
                raise LibraryAcquisitionError(
                    "document_request_rejected",
                    "A canonical PMC open-access PDF path is required.",
                )
            path = exact_pdf_path
        created_at = self._clock()
        if created_at.tzinfo is None or created_at.utcoffset() is None:
            raise RuntimeError("The acquisition clock must return a timezone-aware value.")
        source_record = {
            "access_evidence_url": _OPEN_ACCESS_EVIDENCE_URLS[provider],
            "exact_pdf_path": path,
            "origin": "policy_bound_identifier_request",
            "provider": provider.value,
            "repository_id": repository_id,
            "schema": "litehouse.open-access-source.v1",
            "title": normalized_title,
        }
        source_record_json = canonical_json(source_record)
        request = DocumentRequest(
            provider=provider,
            repository_id=repository_id,
            exact_pdf_path=path,
            evidence=OpenAccessEvidence(
                provider=provider,
                source_record_id=repository_id,
                source_record_sha256=hashlib.sha256(
                    source_record_json.encode("utf-8")
                ).hexdigest(),
                source_record_retrieved_at=created_at,
                access_assertion=AccessAssertion.OPEN_ACCESS,
                license_url=_OPEN_ACCESS_EVIDENCE_URLS[provider],
            ),
        )
        try:
            DOCUMENT_POLICY.validate_evidence(request.evidence, request)
            target = DOCUMENT_POLICY.build_target(request)
            DOCUMENT_POLICY.validate_constructed_url(target)
        except DocumentPolicyError:
            raise LibraryAcquisitionError(
                "document_request_rejected",
                "The open-access document request was rejected by policy.",
            ) from None

        result = await self._document_acquirer.acquire(request)
        if result.error is not None:
            raise LibraryAcquisitionError(
                result.error.code,
                result.error.message,
                retryable=result.error.retryable,
            )
        if result.blob is None or result.receipt is None:
            raise RuntimeError("The document acquirer returned an incomplete result.")
        receipt = result.receipt
        receipt_document = {
            "download": {
                "content_sha256": receipt.content_sha256,
                "content_type": receipt.content_type,
                "peer_ip": receipt.peer_ip,
                "request_sha256": receipt.request_sha256,
                "resolved_addresses": list(receipt.resolved_addresses),
                "retrieved_at": receipt.retrieved_at.isoformat(),
                "size": receipt.size,
            },
            "license": {
                "access_assertion": receipt.access_assertion.value,
                "evidence_url": receipt.license_url,
                "reuse_license_expression": None,
                "reuse_license_verified": False,
            },
            "request": {
                "exact_pdf_path": path,
                "provider": provider.value,
                "repository_id": repository_id,
                "target_url": target.url,
            },
            "schema": "litehouse.open-access-acquisition.v1",
            "source_record": {
                **source_record,
                "retrieved_at": receipt.source_record_retrieved_at.isoformat(),
                "sha256": receipt.source_record_sha256,
            },
        }
        item = await self._repository.add_library_item(
            title=normalized_title,
            kind=LibraryItemKind.IMPORT,
        )
        receipt_artifact = await self._repository.add_artifact_bytes(
            library_item_id=item.id,
            kind=ArtifactKind.SUPPLEMENTARY,
            media_type="application/vnd.litehouse.open-access-receipt+json",
            content=canonical_json(receipt_document).encode("utf-8"),
            source=ArtifactSource(
                name="Litehouse open-access acquisition receipt",
                url=target.url,
                license_url=receipt.license_url,
            ),
        )
        pdf_artifact = await self._repository.register_verified_artifact(
            library_item_id=item.id,
            kind=ArtifactKind.ARTICLE_PDF,
            media_type="application/pdf",
            reference=VaultBlobRef(
                sha256=result.blob.sha256,
                size=result.blob.size,
                relative_path=result.blob.relative_path,
            ),
            source=ArtifactSource(
                name=_PROVIDER_LABELS[provider],
                url=target.url,
                license_url=receipt.license_url,
                receipt_sha256=receipt_artifact.blob.sha256,
            ),
        )
        return OpenAccessAcquisition(
            item=item,
            pdf_artifact=pdf_artifact,
            receipt_artifact=receipt_artifact,
            access_assertion=receipt.access_assertion,
            reuse_license_verified=False,
        )

    async def verify_artifact(self, artifact_id: str) -> BlobVerification:
        artifact = await self._repository.get_artifact(artifact_id)
        return await asyncio.to_thread(self._blobs.verify, artifact.blob)

    async def verify_manifest(
        self,
        manifest_id: str,
        material_artifact_ids: Sequence[str],
    ) -> ManifestVerification:
        material: dict[str, Path] = {}
        for artifact_id in material_artifact_ids:
            artifact = await self._repository.get_artifact(artifact_id)
            material[artifact.blob.sha256] = self._blobs.path_for(artifact.blob)
        return await self._repository.verify_report_manifest(
            manifest_id,
            material=material,
        )

    async def save_progress(
        self,
        *,
        artifact_id: str,
        position_fraction: float,
        locator: Mapping[str, object],
        page_number: int | None,
        page_count: int | None,
    ) -> ReadingProgress:
        return await self._repository.save_reading_progress(
            artifact_id=artifact_id,
            position_fraction=position_fraction,
            locator=locator,
            page_number=page_number,
            page_count=page_count,
        )

    async def get_progress(self, artifact_id: str) -> ReadingProgress | None:
        await self._repository.get_artifact(artifact_id)
        return await self._repository.get_reading_progress(artifact_id)

    async def add_annotation(
        self,
        *,
        library_item_id: str,
        kind: AnnotationKind,
        body: str,
        anchor: Mapping[str, object],
        artifact_id: str | None,
        quote_text: str | None,
        page_number: int | None,
        idempotency_key: str | None,
    ) -> Annotation:
        return await self._repository.add_annotation(
            library_item_id=library_item_id,
            kind=kind,
            body=body,
            anchor=anchor,
            artifact_id=artifact_id,
            quote_text=quote_text,
            page_number=page_number,
            idempotency_key=idempotency_key,
        )

    async def list_annotations(
        self,
        library_item_id: str,
        *,
        offset: int,
        limit: int,
    ) -> Sequence[Annotation]:
        await self._repository.get_library_item(library_item_id)
        annotations = await self._repository.list_annotations(library_item_id)
        return annotations[offset : offset + limit]

    async def export_notes(
        self,
        library_item_id: str,
        export_format: Literal["markdown", "json"],
    ) -> NoteExport:
        content = await self._repository.export_annotations(library_item_id, export_format)
        if len(content) > _MAX_EXPORT_BYTES:
            raise LibraryExportTooLargeError("The note export exceeds the safe response limit.")
        return NoteExport(
            content=content,
            media_type="text/markdown" if export_format == "markdown" else "application/json",
            sha256=hashlib.sha256(content).hexdigest(),
        )

    @staticmethod
    def _is_reader_pdf(artifact: VaultArtifact) -> bool:
        return (
            artifact.kind in _PDF_ARTIFACT_KINDS
            and artifact.media_type.strip().casefold() == "application/pdf"
        )
