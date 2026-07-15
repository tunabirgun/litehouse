from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path

from litehouse.domain import canonical_json, sha256_text

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def require_sha256(value: str, *, field_name: str = "sha256") -> str:
    normalized = value.strip().lower()
    if not _SHA256_PATTERN.fullmatch(normalized):
        raise ValueError(f"{field_name} must be a lowercase SHA-256 digest.")
    return normalized


def utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


class LibraryItemKind(StrEnum):
    WORK = "work"
    REPORT = "report"
    NOTEBOOK = "notebook"
    COLLECTION = "collection"
    IMPORT = "import"
    OTHER = "other"


class ArtifactKind(StrEnum):
    ARTICLE_PDF = "article_pdf"
    REPORT_PDF = "report_pdf"
    REPORT_MARKDOWN = "report_markdown"
    REPORT_TEXT = "report_text"
    REPORT_LATEX = "report_latex"
    NOTE_EXPORT = "note_export"
    HIGHLIGHT_EXPORT = "highlight_export"
    REFERENCE_EXPORT = "reference_export"
    SUPPLEMENTARY = "supplementary"
    DATASET = "dataset"
    CODE = "code"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    OTHER = "other"


class AnnotationKind(StrEnum):
    NOTE = "note"
    HIGHLIGHT = "highlight"


class BlobVerificationStatus(StrEnum):
    INTACT = "intact"
    CHANGED = "changed"
    MISSING = "missing"


class ManifestVerificationStatus(StrEnum):
    INTACT = "intact"
    CHANGED = "changed"
    MISSING = "missing"
    UNVERIFIABLE = "unverifiable"


@dataclass(frozen=True, slots=True)
class VaultBlobRef:
    sha256: str
    size: int
    relative_path: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "sha256", require_sha256(self.sha256))
        if self.size < 0:
            raise ValueError("Blob size cannot be negative.")
        relative = Path(self.relative_path)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("Blob path must remain relative to the vault.")


@dataclass(frozen=True, slots=True)
class BlobVerification:
    status: BlobVerificationStatus
    expected_sha256: str
    actual_sha256: str | None = None


@dataclass(frozen=True, slots=True)
class ArtifactSource:
    name: str | None = None
    url: str | None = None
    license_expression: str | None = None
    license_url: str | None = None
    receipt_sha256: str | None = None

    def __post_init__(self) -> None:
        for field_name in ("name", "url", "license_expression", "license_url"):
            value = getattr(self, field_name)
            if value is not None:
                stripped = value.strip()
                object.__setattr__(self, field_name, stripped or None)
        if self.receipt_sha256 is not None:
            object.__setattr__(
                self,
                "receipt_sha256",
                require_sha256(self.receipt_sha256, field_name="receipt_sha256"),
            )

    @property
    def provenance_sha256(self) -> str:
        return sha256_text(
            canonical_json(
                {
                    "license_expression": self.license_expression,
                    "license_url": self.license_url,
                    "name": self.name,
                    "receipt_sha256": self.receipt_sha256,
                    "url": self.url,
                }
            )
        )


@dataclass(frozen=True, slots=True)
class LibraryItem:
    id: str
    title: str
    kind: LibraryItemKind
    identity_sha256: str
    added_at: datetime
    work_id: str | None = None


@dataclass(frozen=True, slots=True)
class VaultArtifact:
    id: str
    library_item_id: str
    kind: ArtifactKind
    media_type: str
    blob: VaultBlobRef
    source: ArtifactSource
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ReadingProgress:
    artifact_id: str
    position_fraction: float
    locator_json: str
    updated_at: datetime
    page_number: int | None = None
    page_count: int | None = None


@dataclass(frozen=True, slots=True)
class Annotation:
    id: str
    library_item_id: str
    kind: AnnotationKind
    body: str
    anchor_json: str
    content_sha256: str
    idempotency_key: str
    created_at: datetime
    updated_at: datetime
    artifact_id: str | None = None
    quote_text: str | None = None
    page_number: int | None = None


@dataclass(frozen=True, slots=True)
class ReportIntegrityManifest:
    report_artifact_sha256: str
    input_sha256: tuple[str, ...]
    evidence_sha256: tuple[str, ...]
    source_receipt_sha256: tuple[str, ...]
    template_sha256: str | None = None
    logo_sha256: str | None = None
    generator_version_sha256: str | None = None
    generation_settings_sha256: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "report_artifact_sha256",
            require_sha256(self.report_artifact_sha256, field_name="report_artifact_sha256"),
        )
        for field_name in ("input_sha256", "evidence_sha256", "source_receipt_sha256"):
            values = tuple(
                sorted(
                    {
                        require_sha256(value, field_name=field_name)
                        for value in getattr(self, field_name)
                    }
                )
            )
            object.__setattr__(self, field_name, values)
        for field_name in (
            "template_sha256",
            "logo_sha256",
            "generator_version_sha256",
            "generation_settings_sha256",
        ):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(self, field_name, require_sha256(value, field_name=field_name))

    @property
    def payload(self) -> dict[str, object]:
        result: dict[str, object] = {
            "schema_version": 1,
            "report_artifact_sha256": self.report_artifact_sha256,
            "input_sha256": list(self.input_sha256),
            "evidence_sha256": list(self.evidence_sha256),
            "source_receipt_sha256": list(self.source_receipt_sha256),
        }
        for field_name in (
            "template_sha256",
            "logo_sha256",
            "generator_version_sha256",
            "generation_settings_sha256",
        ):
            value = getattr(self, field_name)
            if value is not None:
                result[field_name] = value
        return result

    @property
    def canonical_json(self) -> str:
        return canonical_json(self.payload)

    @property
    def sha256(self) -> str:
        return sha256_text(self.canonical_json)

    @property
    def external_sha256(self) -> tuple[str, ...]:
        values = {
            *self.input_sha256,
            *self.evidence_sha256,
            *self.source_receipt_sha256,
        }
        values.update(
            value
            for value in (
                self.template_sha256,
                self.logo_sha256,
                self.generator_version_sha256,
                self.generation_settings_sha256,
            )
            if value is not None
        )
        return tuple(sorted(values))


@dataclass(frozen=True, slots=True)
class StoredReportManifest:
    id: str
    report_artifact_id: str
    manifest: ReportIntegrityManifest
    manifest_sha256: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ManifestVerification:
    status: ManifestVerificationStatus
    reasons: tuple[str, ...]
    report_artifact_sha256: str | None
    manifest_sha256: str | None
    scientific_validity_assessed: bool = False
    scope_statement: str = (
        "Hash verification checks file identity only; it does not establish scientific truth."
    )
