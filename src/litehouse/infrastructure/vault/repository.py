from __future__ import annotations

import asyncio
import hashlib
import json
import unicodedata
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from litehouse.domain import canonical_json, sha256_text
from litehouse.domain.entities import new_id, utc_now
from litehouse.infrastructure.db.models import (
    AnnotationModel,
    CollectionItemModel,
    CollectionModel,
    LibraryItemModel,
    LibraryItemTagModel,
    ReadingProgressModel,
    ReportIntegrityManifestModel,
    TagModel,
    VaultArtifactModel,
    WorkIdentifierModel,
    WorkModel,
)
from litehouse.infrastructure.db.session import SessionFactory
from litehouse.infrastructure.vault.exports import AnnotationExportBundle, AnnotationExportRecord
from litehouse.infrastructure.vault.models import (
    Annotation,
    AnnotationKind,
    ArtifactKind,
    ArtifactSource,
    BlobVerificationStatus,
    LibraryItem,
    LibraryItemKind,
    ManifestVerification,
    ManifestVerificationStatus,
    ReadingProgress,
    ReportIntegrityManifest,
    StoredReportManifest,
    VaultArtifact,
    VaultBlobRef,
)
from litehouse.infrastructure.vault.store import VaultBlobStore, VaultIntegrityError

_REPORT_KINDS = frozenset(
    {
        ArtifactKind.REPORT_PDF,
        ArtifactKind.REPORT_MARKDOWN,
        ArtifactKind.REPORT_TEXT,
        ArtifactKind.REPORT_LATEX,
    }
)
_CHUNK_SIZE = 1024 * 1024


class LibraryItemNotFoundError(LookupError):
    pass


class ArtifactNotFoundError(LookupError):
    pass


class ManifestNotFoundError(LookupError):
    pass


class IdempotencyConflictError(RuntimeError):
    pass


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _normalized_name(value: str) -> tuple[str, str]:
    display = " ".join(unicodedata.normalize("NFKC", value).split())
    if not display:
        raise ValueError("Name cannot be empty.")
    return display, display.casefold()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _json_hashes(value: str, *, field_name: str) -> tuple[str, ...]:
    parsed = json.loads(value)
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise VaultIntegrityError(f"Stored {field_name} is not a hash list.")
    return tuple(parsed)


class VaultRepository:
    def __init__(self, sessions: SessionFactory, blobs: VaultBlobStore) -> None:
        self._sessions = sessions
        self._blobs = blobs

    async def add_library_item(
        self,
        *,
        title: str,
        kind: LibraryItemKind,
        work_id: str | None = None,
    ) -> LibraryItem:
        normalized_title = " ".join(title.split())
        if not normalized_title:
            raise ValueError("Library item title cannot be empty.")
        if (kind is LibraryItemKind.WORK) != (work_id is not None):
            raise ValueError(
                "Work library items require a work ID, and other items cannot use one."
            )
        identity_sha256 = sha256_text(
            canonical_json(
                {
                    "item_kind": kind.value,
                    "title": None if work_id is not None else normalized_title,
                    "work_id": work_id,
                }
            )
        )
        candidate_id = new_id()
        now = utc_now()
        async with self._sessions() as session, session.begin():
            await session.execute(
                sqlite_insert(LibraryItemModel)
                .values(
                    id=candidate_id,
                    work_id=work_id,
                    title=normalized_title,
                    item_kind=kind.value,
                    identity_sha256=identity_sha256,
                    added_at=now,
                )
                .on_conflict_do_nothing()
            )
            row = await session.scalar(
                select(LibraryItemModel).where(
                    (LibraryItemModel.identity_sha256 == identity_sha256)
                    | (LibraryItemModel.work_id == work_id if work_id is not None else False)
                )
            )
            if row is None:
                raise RuntimeError("Library item idempotency did not return a row.")
            return self._library_item(row)

    async def list_library_items(self) -> Sequence[LibraryItem]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(LibraryItemModel).order_by(
                        LibraryItemModel.added_at, LibraryItemModel.id
                    )
                )
            ).scalars()
            return [self._library_item(row) for row in rows]

    async def get_library_item(self, library_item_id: str) -> LibraryItem:
        async with self._sessions() as session:
            row = await session.get(LibraryItemModel, library_item_id)
            if row is None:
                raise LibraryItemNotFoundError(library_item_id)
            return self._library_item(row)

    async def add_artifact_bytes(
        self,
        *,
        library_item_id: str,
        kind: ArtifactKind,
        media_type: str,
        content: bytes,
        source: ArtifactSource | None = None,
    ) -> VaultArtifact:
        reference = self._blobs.put_bytes(content)
        return await self._register_artifact(
            library_item_id=library_item_id,
            kind=kind,
            media_type=media_type,
            reference=reference,
            source=source or ArtifactSource(),
        )

    async def add_artifact_file(
        self,
        *,
        library_item_id: str,
        kind: ArtifactKind,
        media_type: str,
        path: Path,
        source: ArtifactSource | None = None,
    ) -> VaultArtifact:
        reference = self._blobs.put_file(path)
        return await self._register_artifact(
            library_item_id=library_item_id,
            kind=kind,
            media_type=media_type,
            reference=reference,
            source=source or ArtifactSource(),
        )

    async def register_verified_artifact(
        self,
        *,
        library_item_id: str,
        kind: ArtifactKind,
        media_type: str,
        reference: VaultBlobRef,
        source: ArtifactSource | None = None,
    ) -> VaultArtifact:
        verification = await asyncio.to_thread(self._blobs.verify, reference)
        if verification.status is not BlobVerificationStatus.INTACT:
            raise VaultIntegrityError("Artifact failed verification before registration.")
        return await self._register_artifact(
            library_item_id=library_item_id,
            kind=kind,
            media_type=media_type,
            reference=reference,
            source=source or ArtifactSource(),
        )

    async def get_artifact(self, artifact_id: str) -> VaultArtifact:
        async with self._sessions() as session:
            row = await session.get(VaultArtifactModel, artifact_id)
            if row is None:
                raise ArtifactNotFoundError(artifact_id)
            return self._artifact(row)

    async def list_artifacts(self, library_item_id: str) -> Sequence[VaultArtifact]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(VaultArtifactModel)
                    .where(VaultArtifactModel.library_item_id == library_item_id)
                    .order_by(VaultArtifactModel.created_at, VaultArtifactModel.id)
                )
            ).scalars()
            return [self._artifact(row) for row in rows]

    async def save_reading_progress(
        self,
        *,
        artifact_id: str,
        position_fraction: float,
        locator: Mapping[str, object],
        page_number: int | None = None,
        page_count: int | None = None,
    ) -> ReadingProgress:
        if not 0 <= position_fraction <= 1:
            raise ValueError("Reading position must be between zero and one.")
        if page_number is not None and page_number < 1:
            raise ValueError("Page numbers start at one.")
        if page_count is not None and page_count < 1:
            raise ValueError("Page count must be positive.")
        if page_number is not None and page_count is not None and page_number > page_count:
            raise ValueError("Page number cannot exceed page count.")
        locator_json = canonical_json(locator)
        now = utc_now()
        async with self._sessions() as session, session.begin():
            if await session.get(VaultArtifactModel, artifact_id) is None:
                raise ArtifactNotFoundError(artifact_id)
            await session.execute(
                sqlite_insert(ReadingProgressModel)
                .values(
                    artifact_id=artifact_id,
                    position_fraction=position_fraction,
                    page_number=page_number,
                    page_count=page_count,
                    locator_json=locator_json,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["artifact_id"],
                    set_={
                        "position_fraction": position_fraction,
                        "page_number": page_number,
                        "page_count": page_count,
                        "locator_json": locator_json,
                        "updated_at": now,
                    },
                )
            )
        return ReadingProgress(
            artifact_id=artifact_id,
            position_fraction=position_fraction,
            page_number=page_number,
            page_count=page_count,
            locator_json=locator_json,
            updated_at=now,
        )

    async def get_reading_progress(self, artifact_id: str) -> ReadingProgress | None:
        async with self._sessions() as session:
            row = await session.get(ReadingProgressModel, artifact_id)
            if row is None:
                return None
            return ReadingProgress(
                artifact_id=row.artifact_id,
                position_fraction=row.position_fraction,
                page_number=row.page_number,
                page_count=row.page_count,
                locator_json=row.locator_json,
                updated_at=_utc(row.updated_at),
            )

    async def add_annotation(
        self,
        *,
        library_item_id: str,
        kind: AnnotationKind,
        body: str,
        anchor: Mapping[str, object],
        artifact_id: str | None = None,
        quote_text: str | None = None,
        page_number: int | None = None,
        idempotency_key: str | None = None,
    ) -> Annotation:
        if not body.strip() and not (quote_text and quote_text.strip()):
            raise ValueError("A note or highlight must contain text or a quotation.")
        if page_number is not None and page_number < 1:
            raise ValueError("Annotation page numbers start at one.")
        anchor_json = canonical_json(anchor)
        content_sha256 = sha256_text(
            canonical_json(
                {
                    "anchor": json.loads(anchor_json),
                    "artifact_id": artifact_id,
                    "body": body,
                    "kind": kind.value,
                    "library_item_id": library_item_id,
                    "page_number": page_number,
                    "quote_text": quote_text,
                }
            )
        )
        key = (idempotency_key or content_sha256).strip()
        if not key or len(key) > 128:
            raise ValueError("Annotation idempotency keys must contain 1 to 128 characters.")
        candidate_id = new_id()
        now = utc_now()
        async with self._sessions() as session, session.begin():
            if await session.get(LibraryItemModel, library_item_id) is None:
                raise LibraryItemNotFoundError(library_item_id)
            if artifact_id is not None:
                artifact = await session.get(VaultArtifactModel, artifact_id)
                if artifact is None or artifact.library_item_id != library_item_id:
                    raise ArtifactNotFoundError(artifact_id)
            await session.execute(
                sqlite_insert(AnnotationModel)
                .values(
                    id=candidate_id,
                    library_item_id=library_item_id,
                    artifact_id=artifact_id,
                    annotation_kind=kind.value,
                    body=body,
                    quote_text=quote_text,
                    anchor_json=anchor_json,
                    page_number=page_number,
                    content_sha256=content_sha256,
                    idempotency_key=key,
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_nothing(index_elements=["idempotency_key"])
            )
            row = await session.scalar(
                select(AnnotationModel).where(AnnotationModel.idempotency_key == key)
            )
            if row is None:
                raise RuntimeError("Annotation idempotency did not return a row.")
            if row.content_sha256 != content_sha256:
                raise IdempotencyConflictError("Annotation idempotency key has different content.")
            return self._annotation(row)

    async def list_annotations(self, library_item_id: str) -> Sequence[Annotation]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(AnnotationModel)
                    .where(AnnotationModel.library_item_id == library_item_id)
                    .order_by(AnnotationModel.created_at, AnnotationModel.id)
                )
            ).scalars()
            return [self._annotation(row) for row in rows]

    async def add_tag(self, library_item_id: str, name: str) -> str:
        display, normalized = _normalized_name(name)
        tag_id = new_id()
        async with self._sessions() as session, session.begin():
            if await session.get(LibraryItemModel, library_item_id) is None:
                raise LibraryItemNotFoundError(library_item_id)
            await session.execute(
                sqlite_insert(TagModel)
                .values(id=tag_id, name=display, normalized_name=normalized)
                .on_conflict_do_nothing(index_elements=["normalized_name"])
            )
            tag = await session.scalar(
                select(TagModel).where(TagModel.normalized_name == normalized)
            )
            if tag is None:
                raise RuntimeError("Tag idempotency did not return a row.")
            await session.execute(
                sqlite_insert(LibraryItemTagModel)
                .values(library_item_id=library_item_id, tag_id=tag.id)
                .on_conflict_do_nothing()
            )
            return tag.id

    async def list_tags(self, library_item_id: str) -> Sequence[str]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(TagModel.name)
                    .join(LibraryItemTagModel, TagModel.id == LibraryItemTagModel.tag_id)
                    .where(LibraryItemTagModel.library_item_id == library_item_id)
                    .order_by(TagModel.normalized_name, TagModel.id)
                )
            ).scalars()
            return list(rows)

    async def create_collection(self, name: str) -> str:
        display, normalized = _normalized_name(name)
        collection_id = new_id()
        now = utc_now()
        async with self._sessions() as session, session.begin():
            await session.execute(
                sqlite_insert(CollectionModel)
                .values(
                    id=collection_id,
                    name=display,
                    normalized_name=normalized,
                    created_at=now,
                )
                .on_conflict_do_nothing(index_elements=["normalized_name"])
            )
            collection = await session.scalar(
                select(CollectionModel).where(CollectionModel.normalized_name == normalized)
            )
            if collection is None:
                raise RuntimeError("Collection idempotency did not return a row.")
            return collection.id

    async def add_to_collection(self, collection_id: str, library_item_id: str) -> None:
        async with self._sessions() as session, session.begin():
            if await session.get(CollectionModel, collection_id) is None:
                raise LookupError(collection_id)
            if await session.get(LibraryItemModel, library_item_id) is None:
                raise LibraryItemNotFoundError(library_item_id)
            await session.execute(
                sqlite_insert(CollectionItemModel)
                .values(collection_id=collection_id, library_item_id=library_item_id)
                .on_conflict_do_nothing()
            )

    async def list_collection_items(self, collection_id: str) -> Sequence[LibraryItem]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(LibraryItemModel)
                    .join(
                        CollectionItemModel,
                        LibraryItemModel.id == CollectionItemModel.library_item_id,
                    )
                    .where(CollectionItemModel.collection_id == collection_id)
                    .order_by(LibraryItemModel.added_at, LibraryItemModel.id)
                )
            ).scalars()
            return [self._library_item(row) for row in rows]

    async def export_annotations(
        self,
        library_item_id: str,
        export_format: Literal["markdown", "json"],
    ) -> bytes:
        bundle = await self._annotation_export_bundle(library_item_id)
        return bundle.to_markdown() if export_format == "markdown" else bundle.to_json()

    async def save_annotation_export(
        self,
        library_item_id: str,
        export_format: Literal["markdown", "json"],
    ) -> VaultArtifact:
        content = await self.export_annotations(library_item_id, export_format)
        media_type = "text/markdown" if export_format == "markdown" else "application/json"
        return await self.add_artifact_bytes(
            library_item_id=library_item_id,
            kind=ArtifactKind.NOTE_EXPORT,
            media_type=media_type,
            content=content,
            source=ArtifactSource(name="Litehouse local annotation export"),
        )

    async def create_report_manifest(
        self,
        *,
        report_artifact_id: str,
        input_sha256: Sequence[str],
        evidence_sha256: Sequence[str],
        source_receipt_sha256: Sequence[str],
        template_sha256: str | None = None,
        logo_sha256: str | None = None,
        generator_version_sha256: str | None = None,
        generation_settings_sha256: str | None = None,
    ) -> StoredReportManifest:
        artifact = await self.get_artifact(report_artifact_id)
        if artifact.kind not in _REPORT_KINDS:
            raise ValueError("Integrity manifests can only describe report artifacts.")
        manifest = ReportIntegrityManifest(
            report_artifact_sha256=artifact.blob.sha256,
            input_sha256=tuple(input_sha256),
            evidence_sha256=tuple(evidence_sha256),
            source_receipt_sha256=tuple(source_receipt_sha256),
            template_sha256=template_sha256,
            logo_sha256=logo_sha256,
            generator_version_sha256=generator_version_sha256,
            generation_settings_sha256=generation_settings_sha256,
        )
        manifest_id = new_id()
        now = utc_now()
        async with self._sessions() as session, session.begin():
            await session.execute(
                sqlite_insert(ReportIntegrityManifestModel)
                .values(
                    id=manifest_id,
                    report_artifact_id=report_artifact_id,
                    artifact_sha256=manifest.report_artifact_sha256,
                    input_hashes_json=canonical_json(list(manifest.input_sha256)),
                    evidence_hashes_json=canonical_json(list(manifest.evidence_sha256)),
                    source_receipt_hashes_json=canonical_json(
                        list(manifest.source_receipt_sha256)
                    ),
                    template_sha256=manifest.template_sha256,
                    logo_sha256=manifest.logo_sha256,
                    generator_version_sha256=manifest.generator_version_sha256,
                    generation_settings_sha256=manifest.generation_settings_sha256,
                    manifest_json=manifest.canonical_json,
                    manifest_sha256=manifest.sha256,
                    created_at=now,
                )
                .on_conflict_do_nothing(index_elements=["report_artifact_id"])
            )
            row = await session.scalar(
                select(ReportIntegrityManifestModel).where(
                    ReportIntegrityManifestModel.report_artifact_id == report_artifact_id
                )
            )
            if row is None:
                raise RuntimeError("Manifest idempotency did not return a row.")
            if row.manifest_sha256 != manifest.sha256:
                raise IdempotencyConflictError("Report artifact already has a different manifest.")
            return self._stored_manifest(row)

    async def verify_report_manifest(
        self,
        manifest_id: str,
        *,
        material: Mapping[str, bytes | Path] | None = None,
    ) -> ManifestVerification:
        async with self._sessions() as session:
            row = await session.get(ReportIntegrityManifestModel, manifest_id)
            if row is None:
                return ManifestVerification(
                    status=ManifestVerificationStatus.MISSING,
                    reasons=("The report integrity manifest is missing.",),
                    report_artifact_sha256=None,
                    manifest_sha256=None,
                )
            artifact_row = await session.get(VaultArtifactModel, row.report_artifact_id)
        try:
            stored = self._stored_manifest(row)
        except (ValueError, TypeError, json.JSONDecodeError, VaultIntegrityError):
            return ManifestVerification(
                status=ManifestVerificationStatus.CHANGED,
                reasons=("The stored integrity manifest no longer matches its hash.",),
                report_artifact_sha256=row.artifact_sha256,
                manifest_sha256=row.manifest_sha256,
            )
        reasons: list[str] = []
        statuses: set[ManifestVerificationStatus] = set()
        if artifact_row is None:
            statuses.add(ManifestVerificationStatus.MISSING)
            reasons.append("The indexed report artifact is missing.")
        else:
            artifact = self._artifact(artifact_row)
            if artifact.blob.sha256 != stored.manifest.report_artifact_sha256:
                statuses.add(ManifestVerificationStatus.CHANGED)
                reasons.append("The report artifact receipt differs from the manifest.")
            blob_check = self._blobs.verify(artifact.blob)
            if blob_check.status is BlobVerificationStatus.MISSING:
                statuses.add(ManifestVerificationStatus.MISSING)
                reasons.append("The report artifact file is missing from the vault.")
            elif blob_check.status is BlobVerificationStatus.CHANGED:
                statuses.add(ManifestVerificationStatus.CHANGED)
                reasons.append("The report artifact file differs from its SHA-256 receipt.")
        supplied = material or {}
        for expected in stored.manifest.external_sha256:
            candidate = supplied.get(expected)
            if candidate is None:
                statuses.add(ManifestVerificationStatus.UNVERIFIABLE)
                reasons.append(f"Verification material was not supplied for SHA-256 {expected}.")
                continue
            if isinstance(candidate, bytes):
                actual = hashlib.sha256(candidate).hexdigest()
            else:
                if candidate.is_symlink() or (candidate.exists() and not candidate.is_file()):
                    statuses.add(ManifestVerificationStatus.UNVERIFIABLE)
                    reasons.append(f"Verification material is not a regular file: {expected}.")
                    continue
                if not candidate.exists():
                    statuses.add(ManifestVerificationStatus.MISSING)
                    reasons.append(f"Verification material is missing for SHA-256 {expected}.")
                    continue
                actual = _hash_file(candidate)
            if actual != expected:
                statuses.add(ManifestVerificationStatus.CHANGED)
                reasons.append(f"Verification material differs from SHA-256 {expected}.")
        if ManifestVerificationStatus.CHANGED in statuses:
            status = ManifestVerificationStatus.CHANGED
        elif ManifestVerificationStatus.MISSING in statuses:
            status = ManifestVerificationStatus.MISSING
        elif ManifestVerificationStatus.UNVERIFIABLE in statuses:
            status = ManifestVerificationStatus.UNVERIFIABLE
        else:
            status = ManifestVerificationStatus.INTACT
            reasons.append("All supplied files match their declared SHA-256 values.")
        return ManifestVerification(
            status=status,
            reasons=tuple(reasons),
            report_artifact_sha256=stored.manifest.report_artifact_sha256,
            manifest_sha256=stored.manifest_sha256,
        )

    async def _register_artifact(
        self,
        *,
        library_item_id: str,
        kind: ArtifactKind,
        media_type: str,
        reference: VaultBlobRef,
        source: ArtifactSource,
    ) -> VaultArtifact:
        normalized_media_type = media_type.strip().lower()
        if not normalized_media_type:
            raise ValueError("Artifact media type cannot be empty.")
        artifact_id = new_id()
        now = utc_now()
        async with self._sessions() as session, session.begin():
            if await session.get(LibraryItemModel, library_item_id) is None:
                raise LibraryItemNotFoundError(library_item_id)
            await session.execute(
                sqlite_insert(VaultArtifactModel)
                .values(
                    id=artifact_id,
                    library_item_id=library_item_id,
                    artifact_kind=kind.value,
                    media_type=normalized_media_type,
                    sha256=reference.sha256,
                    size=reference.size,
                    relative_path=reference.relative_path,
                    source_name=source.name,
                    source_url=source.url,
                    license_expression=source.license_expression,
                    license_url=source.license_url,
                    source_receipt_sha256=source.receipt_sha256,
                    provenance_sha256=source.provenance_sha256,
                    created_at=now,
                )
                .on_conflict_do_nothing(
                    index_elements=[
                        "library_item_id",
                        "artifact_kind",
                        "sha256",
                        "provenance_sha256",
                    ]
                )
            )
            row = await session.scalar(
                select(VaultArtifactModel).where(
                    VaultArtifactModel.library_item_id == library_item_id,
                    VaultArtifactModel.artifact_kind == kind.value,
                    VaultArtifactModel.sha256 == reference.sha256,
                    VaultArtifactModel.provenance_sha256 == source.provenance_sha256,
                )
            )
            if row is None:
                raise RuntimeError("Artifact idempotency did not return a row.")
            return self._artifact(row)

    async def _annotation_export_bundle(self, library_item_id: str) -> AnnotationExportBundle:
        async with self._sessions() as session:
            item = await session.get(LibraryItemModel, library_item_id)
            if item is None:
                raise LibraryItemNotFoundError(library_item_id)
            work = await session.get(WorkModel, item.work_id) if item.work_id else None
            identifier_rows = []
            if item.work_id:
                identifier_rows = list(
                    (
                        await session.execute(
                            select(WorkIdentifierModel)
                            .where(WorkIdentifierModel.work_id == item.work_id)
                            .order_by(
                                WorkIdentifierModel.namespace, WorkIdentifierModel.value
                            )
                        )
                    ).scalars()
                )
            annotation_rows = list(
                (
                    await session.execute(
                        select(AnnotationModel)
                        .where(AnnotationModel.library_item_id == library_item_id)
                        .order_by(AnnotationModel.created_at, AnnotationModel.id)
                    )
                ).scalars()
            )
            artifact_ids = {
                row.artifact_id for row in annotation_rows if row.artifact_id is not None
            }
            artifacts: dict[str, VaultArtifactModel] = {}
            if artifact_ids:
                artifact_rows = (
                    await session.execute(
                        select(VaultArtifactModel).where(VaultArtifactModel.id.in_(artifact_ids))
                    )
                ).scalars()
                artifacts = {row.id: row for row in artifact_rows}
        records: list[AnnotationExportRecord] = []
        for row in annotation_rows:
            artifact = artifacts.get(row.artifact_id) if row.artifact_id else None
            records.append(
                AnnotationExportRecord(
                    annotation_id=row.id,
                    kind=AnnotationKind(row.annotation_kind),
                    body=row.body,
                    quote_text=row.quote_text,
                    anchor_json=row.anchor_json,
                    page_number=row.page_number,
                    content_sha256=row.content_sha256,
                    created_at=_utc(row.created_at),
                    artifact_sha256=artifact.sha256 if artifact else None,
                    source_name=artifact.source_name if artifact else None,
                    source_url=artifact.source_url if artifact else None,
                    license_expression=artifact.license_expression if artifact else None,
                    license_url=artifact.license_url if artifact else None,
                )
            )
        return AnnotationExportBundle(
            library_item_id=item.id,
            title=item.title,
            item_kind=item.item_kind,
            work_id=item.work_id,
            work_kind=work.kind if work else None,
            work_identifiers=tuple((row.namespace, row.value) for row in identifier_rows),
            annotations=tuple(records),
        )

    @staticmethod
    def _library_item(row: LibraryItemModel) -> LibraryItem:
        return LibraryItem(
            id=row.id,
            work_id=row.work_id,
            title=row.title,
            kind=LibraryItemKind(row.item_kind),
            identity_sha256=row.identity_sha256,
            added_at=_utc(row.added_at),
        )

    @staticmethod
    def _artifact(row: VaultArtifactModel) -> VaultArtifact:
        return VaultArtifact(
            id=row.id,
            library_item_id=row.library_item_id,
            kind=ArtifactKind(row.artifact_kind),
            media_type=row.media_type,
            blob=VaultBlobRef(row.sha256, row.size, row.relative_path),
            source=ArtifactSource(
                name=row.source_name,
                url=row.source_url,
                license_expression=row.license_expression,
                license_url=row.license_url,
                receipt_sha256=row.source_receipt_sha256,
            ),
            created_at=_utc(row.created_at),
        )

    @staticmethod
    def _annotation(row: AnnotationModel) -> Annotation:
        return Annotation(
            id=row.id,
            library_item_id=row.library_item_id,
            artifact_id=row.artifact_id,
            kind=AnnotationKind(row.annotation_kind),
            body=row.body,
            quote_text=row.quote_text,
            anchor_json=row.anchor_json,
            page_number=row.page_number,
            content_sha256=row.content_sha256,
            idempotency_key=row.idempotency_key,
            created_at=_utc(row.created_at),
            updated_at=_utc(row.updated_at),
        )

    @staticmethod
    def _stored_manifest(row: ReportIntegrityManifestModel) -> StoredReportManifest:
        manifest = ReportIntegrityManifest(
            report_artifact_sha256=row.artifact_sha256,
            input_sha256=_json_hashes(row.input_hashes_json, field_name="input hashes"),
            evidence_sha256=_json_hashes(row.evidence_hashes_json, field_name="evidence hashes"),
            source_receipt_sha256=_json_hashes(
                row.source_receipt_hashes_json, field_name="source receipt hashes"
            ),
            template_sha256=row.template_sha256,
            logo_sha256=row.logo_sha256,
            generator_version_sha256=row.generator_version_sha256,
            generation_settings_sha256=row.generation_settings_sha256,
        )
        if row.manifest_json != manifest.canonical_json or row.manifest_sha256 != manifest.sha256:
            raise VaultIntegrityError("Stored report manifest is not canonical or has changed.")
        return StoredReportManifest(
            id=row.id,
            report_artifact_id=row.report_artifact_id,
            manifest=manifest,
            manifest_sha256=row.manifest_sha256,
            created_at=_utc(row.created_at),
        )
