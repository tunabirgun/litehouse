from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

from litehouse.domain import Work

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class CitationStyle(StrEnum):
    APA = "apa-7"
    IEEE = "ieee"
    CHICAGO_AUTHOR_DATE = "chicago-author-date"
    MLA = "mla-9"
    VANCOUVER = "vancouver"
    HARVARD_CITE_THEM_RIGHT = "harvard-cite-them-right"


@dataclass(frozen=True, slots=True)
class PartialDate:
    year: int
    month: int | None = None
    day: int | None = None

    def __post_init__(self) -> None:
        if not 1 <= self.year <= 9999:
            raise ValueError("Year must be between 1 and 9999.")
        if self.month is not None and not 1 <= self.month <= 12:
            raise ValueError("Month must be between 1 and 12.")
        if self.day is not None:
            if self.month is None:
                raise ValueError("A day requires a month.")
            try:
                datetime(self.year, self.month, self.day)
            except ValueError as error:
                raise ValueError("Publication date is invalid.") from error

    @property
    def date_parts(self) -> list[int]:
        parts = [self.year]
        if self.month is not None:
            parts.append(self.month)
        if self.day is not None:
            parts.append(self.day)
        return parts

    @property
    def isoformat(self) -> str:
        return "-".join(
            [f"{self.year:04d}"]
            + ([] if self.month is None else [f"{self.month:02d}"])
            + ([] if self.day is None else [f"{self.day:02d}"])
        )


@dataclass(frozen=True, slots=True)
class ProvenanceRecord:
    source: str
    record_id: str
    retrieved_at: datetime
    url: str | None = None
    sha256: str | None = None

    def __post_init__(self) -> None:
        source = self.source.strip()
        record_id = self.record_id.strip()
        if not source or not record_id:
            raise ValueError("Provenance source and record ID cannot be empty.")
        if self.retrieved_at.tzinfo is None or self.retrieved_at.utcoffset() is None:
            raise ValueError("Provenance retrieval time must include a UTC offset.")
        url = self.url.strip() if self.url is not None else None
        sha256 = self.sha256.lower() if self.sha256 is not None else None
        if url == "":
            raise ValueError("Provenance URL cannot be empty.")
        if sha256 is not None and _SHA256_PATTERN.fullmatch(sha256) is None:
            raise ValueError("Provenance SHA-256 must contain 64 lowercase hexadecimal digits.")
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "record_id", record_id)
        object.__setattr__(self, "retrieved_at", self.retrieved_at.astimezone(UTC))
        object.__setattr__(self, "url", url)
        object.__setattr__(self, "sha256", sha256)


@dataclass(frozen=True, slots=True, kw_only=True)
class ReferenceMetadata:
    issued: PartialDate | None = None
    container_title: str | None = None
    publisher: str | None = None
    publisher_place: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    edition: str | None = None
    language: str | None = None
    url: str | None = None
    license_name: str | None = None
    license_url: str | None = None
    provenance: tuple[ProvenanceRecord, ...] = ()
    attachment_warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        optional_fields = (
            "container_title",
            "publisher",
            "publisher_place",
            "volume",
            "issue",
            "pages",
            "edition",
            "language",
            "url",
            "license_name",
            "license_url",
        )
        for field_name in optional_fields:
            value = getattr(self, field_name)
            if value is not None:
                normalized = value.strip()
                if not normalized:
                    raise ValueError(f"{field_name} cannot be empty.")
                object.__setattr__(self, field_name, normalized)
        normalized_warnings = tuple(warning.strip() for warning in self.attachment_warnings)
        if any(not warning for warning in normalized_warnings):
            raise ValueError("Attachment warnings cannot be empty.")
        object.__setattr__(self, "attachment_warnings", normalized_warnings)


@dataclass(frozen=True, slots=True)
class ReferenceRecord:
    work: Work
    metadata: ReferenceMetadata = field(default_factory=ReferenceMetadata)


@dataclass(frozen=True, slots=True)
class ExportArtifact:
    content: str
    media_type: str
    file_extension: str
    citation_style: CitationStyle
    warnings: tuple[str, ...] = ()
