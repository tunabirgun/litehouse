from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from litehouse.domain import EvidenceSegment, MetadataAssertion, Work

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class AccessLevel(StrEnum):
    OPEN_FULL_TEXT = "open_full_text"
    ABSTRACT_ONLY = "abstract_only"
    METADATA_ONLY = "metadata_only"


class PublicationDatePrecision(StrEnum):
    DAY = "day"
    MONTH = "month"
    YEAR = "year"


@dataclass(frozen=True, slots=True)
class LiteratureRecord:
    source: str
    source_record_id: str
    title: str
    kind: str
    identifiers: tuple[tuple[str, str], ...]
    contributors: tuple[str, ...]
    publication_date: date | None
    publication_date_precision: PublicationDatePrecision | None
    language: str | None
    venue: str | None
    abstract: str | None
    landing_url: str | None
    open_full_text_url: str | None
    license_url: str | None
    citation_count: int | None
    content_sha256: str
    retrieved_at: datetime

    def __post_init__(self) -> None:
        source = self.source.strip()
        record_id = self.source_record_id.strip()
        title = self.title.strip()
        if not source or not record_id or not title:
            raise ValueError("Source, source record ID, and title are required.")
        if len(set(self.identifiers)) != len(self.identifiers):
            raise ValueError("Literature record identifiers must be unique.")
        if self.citation_count is not None and self.citation_count < 0:
            raise ValueError("Citation count cannot be negative.")
        if not _SHA256.fullmatch(self.content_sha256):
            raise ValueError("Source content SHA-256 must contain 64 lowercase hex characters.")
        if self.retrieved_at.tzinfo is None or self.retrieved_at.utcoffset() is None:
            raise ValueError("Retrieval time must include a UTC offset.")
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "source_record_id", record_id)
        object.__setattr__(self, "title", title)
        object.__setattr__(self, "retrieved_at", self.retrieved_at.astimezone(UTC))

    @property
    def access_level(self) -> AccessLevel:
        if self.open_full_text_url:
            return AccessLevel.OPEN_FULL_TEXT
        if self.abstract:
            return AccessLevel.ABSTRACT_ONLY
        return AccessLevel.METADATA_ONLY

    @property
    def identifier_map(self) -> dict[str, str]:
        return dict(self.identifiers)


@dataclass(frozen=True, slots=True)
class MetadataConflict:
    field_name: str
    values: tuple[str, ...]
    sources: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CanonicalLiteratureWork:
    identity_key: str
    work: Work
    records: tuple[LiteratureRecord, ...]
    assertions: tuple[MetadataAssertion, ...]
    evidence_segments: tuple[EvidenceSegment, ...]
    publication_date: date | None
    language: str | None
    venue: str | None
    abstract: str | None
    landing_url: str | None
    open_full_text_url: str | None
    license_url: str | None
    citation_count: int | None
    conflicts: tuple[MetadataConflict, ...]
    matched_fields: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.identity_key.strip() or not self.records:
            raise ValueError("A canonical work requires an identity and at least one record.")
        if self.citation_count is not None and (
            self.citation_count < 0 or not math.isfinite(float(self.citation_count))
        ):
            raise ValueError("Canonical citation count is invalid.")

    @property
    def access_level(self) -> AccessLevel:
        if self.open_full_text_url:
            return AccessLevel.OPEN_FULL_TEXT
        if self.abstract:
            return AccessLevel.ABSTRACT_ONLY
        return AccessLevel.METADATA_ONLY

    @property
    def sources(self) -> tuple[str, ...]:
        return tuple(record.source for record in self.records)
