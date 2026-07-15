from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import StrEnum

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]

_NAMESPACE_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Datetime values must include a UTC offset.")
    return value.astimezone(UTC)


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, str | bool | int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite.")
        return value
    if isinstance(value, Mapping):
        normalized: dict[str, JsonValue] = {}
        for key, nested in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object keys must be strings.")
            normalized[key] = _json_value(nested)
        return normalized
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [_json_value(item) for item in value]
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}.")


def canonical_json(value: object) -> str:
    return json.dumps(
        _json_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class WorkKind(StrEnum):
    ARTICLE = "article"
    PREPRINT = "preprint"
    BOOK = "book"
    CHAPTER = "chapter"
    THESIS = "thesis"
    PROCEEDINGS_PAPER = "proceedings_paper"
    ARCHIVAL_DOCUMENT = "archival_document"
    ARTWORK = "artwork"
    EXHIBITION_CATALOGUE = "exhibition_catalogue"
    PERFORMANCE = "performance"
    SCORE = "score"
    DATASET = "dataset"
    SOFTWARE = "software"
    PROTOCOL = "protocol"
    TRIAL = "trial"
    POLICY_DOCUMENT = "policy_document"
    STANDARD = "standard"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class WorkIdentifier:
    namespace: str
    value: str

    def __post_init__(self) -> None:
        namespace = self.namespace.strip().lower()
        value = self.value.strip()
        if not _NAMESPACE_PATTERN.fullmatch(namespace):
            raise ValueError("Identifier namespace is invalid.")
        if not value:
            raise ValueError("Identifier value cannot be empty.")
        if namespace == "doi":
            value = value.removeprefix("https://doi.org/").removeprefix("http://doi.org/").lower()
        object.__setattr__(self, "namespace", namespace)
        object.__setattr__(self, "value", value)


@dataclass(frozen=True, slots=True)
class Contributor:
    name: str
    position: int
    role: str = "author"

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("Contributor name cannot be empty.")
        if self.position < 0:
            raise ValueError("Contributor position cannot be negative.")
        if not self.role.strip():
            raise ValueError("Contributor role cannot be empty.")
        object.__setattr__(self, "name", self.name.strip())
        object.__setattr__(self, "role", self.role.strip())


@dataclass(frozen=True, slots=True, kw_only=True)
class Work:
    title: str
    kind: WorkKind
    id: str = field(default_factory=new_id)
    identifiers: tuple[WorkIdentifier, ...] = ()
    contributors: tuple[Contributor, ...] = ()

    def __post_init__(self) -> None:
        title = self.title.strip()
        if not title:
            raise ValueError("Work title cannot be empty.")
        if len(set(self.identifiers)) != len(self.identifiers):
            raise ValueError("Work identifiers must be unique.")
        positions = [contributor.position for contributor in self.contributors]
        if positions != list(range(len(self.contributors))):
            raise ValueError("Contributors must be ordered at contiguous positions from zero.")
        object.__setattr__(self, "title", title)


@dataclass(frozen=True, slots=True, init=False)
class WatchRevision:
    id: str
    watch_id: str
    revision_number: int
    specification_json: str
    specification_sha256: str
    created_at: datetime

    def __init__(
        self,
        *,
        watch_id: str,
        revision_number: int,
        specification: Mapping[str, object],
        id: str | None = None,
        created_at: datetime | None = None,
    ) -> None:
        if revision_number < 1:
            raise ValueError("Watch revision numbers start at one.")
        encoded = canonical_json(specification)
        parsed = json.loads(encoded)
        if not isinstance(parsed, dict):
            raise TypeError("Watch specification must be a JSON object.")
        object.__setattr__(self, "id", id or new_id())
        object.__setattr__(self, "watch_id", watch_id)
        object.__setattr__(self, "revision_number", revision_number)
        object.__setattr__(self, "specification_json", encoded)
        object.__setattr__(self, "specification_sha256", sha256_text(encoded))
        object.__setattr__(self, "created_at", _aware_utc(created_at or utc_now()))

    @classmethod
    def restore(
        cls,
        *,
        id: str,
        watch_id: str,
        revision_number: int,
        specification_json: str,
        specification_sha256: str,
        created_at: datetime,
    ) -> WatchRevision:
        parsed = json.loads(specification_json)
        if not isinstance(parsed, dict):
            raise ValueError("Stored watch specification is not an object.")
        revision = cls(
            id=id,
            watch_id=watch_id,
            revision_number=revision_number,
            specification=parsed,
            created_at=created_at,
        )
        if revision.specification_json != specification_json:
            raise ValueError("Stored watch specification is not canonical JSON.")
        if revision.specification_sha256 != specification_sha256:
            raise ValueError("Stored watch specification hash is invalid.")
        return revision

    @property
    def specification(self) -> dict[str, JsonValue]:
        parsed = json.loads(self.specification_json)
        if not isinstance(parsed, dict):
            raise ValueError("Stored watch specification is not an object.")
        return {str(key): _json_value(value) for key, value in parsed.items()}


@dataclass(frozen=True, slots=True, kw_only=True)
class Watch:
    name: str
    active_revision: WatchRevision
    id: str = field(default_factory=new_id)
    enabled: bool = True
    created_at: datetime = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("Watch name cannot be empty.")
        if self.active_revision.watch_id != self.id:
            raise ValueError("Active revision belongs to a different watch.")
        object.__setattr__(self, "name", self.name.strip())
        object.__setattr__(self, "created_at", _aware_utc(self.created_at))

    def with_revision(self, revision: WatchRevision) -> Watch:
        if revision.watch_id != self.id:
            raise ValueError("Revision belongs to a different watch.")
        if revision.revision_number != self.active_revision.revision_number + 1:
            raise ValueError("Watch revisions must increase by one.")
        return replace(self, active_revision=revision)


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    PARTIAL = "partial"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


_RUN_TRANSITIONS: dict[RunStatus, frozenset[RunStatus]] = {
    RunStatus.QUEUED: frozenset({RunStatus.RUNNING, RunStatus.CANCELLED}),
    RunStatus.RUNNING: frozenset(
        {
            RunStatus.QUEUED,
            RunStatus.PARTIAL,
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        }
    ),
    RunStatus.PARTIAL: frozenset(),
    RunStatus.SUCCEEDED: frozenset(),
    RunStatus.FAILED: frozenset(),
    RunStatus.CANCELLED: frozenset(),
}


@dataclass(frozen=True, slots=True, kw_only=True)
class Run:
    watch_revision_id: str
    scheduled_at: datetime
    id: str = field(default_factory=new_id)
    status: RunStatus = RunStatus.QUEUED
    created_at: datetime = field(default_factory=utc_now)
    available_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    attempt_count: int = 0
    report_id: str | None = None
    result_sha256: str | None = None
    artifact_count: int = 0
    source_error_count: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "scheduled_at", _aware_utc(self.scheduled_at))
        object.__setattr__(self, "created_at", _aware_utc(self.created_at))
        object.__setattr__(
            self,
            "available_at",
            _aware_utc(self.available_at or self.scheduled_at),
        )
        for field_name in ("started_at", "finished_at"):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(self, field_name, _aware_utc(value))
        if self.attempt_count < 0 or self.artifact_count < 0 or self.source_error_count < 0:
            raise ValueError("Run counters cannot be negative.")
        if self.result_sha256 is not None and not re.fullmatch(
            r"[0-9a-f]{64}", self.result_sha256
        ):
            raise ValueError("Run result SHA-256 is invalid.")

    def transition(self, status: RunStatus) -> Run:
        if status not in _RUN_TRANSITIONS[self.status]:
            raise ValueError(f"Cannot transition a run from {self.status} to {status}.")
        return replace(self, status=status)


@dataclass(frozen=True, slots=True, init=False)
class MetadataAssertion:
    id: str
    work_id: str
    field_name: str
    value_json: str
    source: str
    source_record_id: str
    observed_at: datetime

    def __init__(
        self,
        *,
        work_id: str,
        field_name: str,
        value: object,
        source: str,
        source_record_id: str,
        id: str | None = None,
        observed_at: datetime | None = None,
    ) -> None:
        if not field_name.strip() or not source.strip() or not source_record_id.strip():
            raise ValueError("Assertion field and source identifiers cannot be empty.")
        object.__setattr__(self, "id", id or new_id())
        object.__setattr__(self, "work_id", work_id)
        object.__setattr__(self, "field_name", field_name.strip())
        object.__setattr__(self, "value_json", canonical_json(value))
        object.__setattr__(self, "source", source.strip())
        object.__setattr__(self, "source_record_id", source_record_id.strip())
        object.__setattr__(self, "observed_at", _aware_utc(observed_at or utc_now()))


class EvidenceScope(StrEnum):
    METADATA = "metadata"
    ABSTRACT = "abstract"
    FULL_TEXT = "full_text"


@dataclass(frozen=True, slots=True, kw_only=True)
class EvidenceSegment:
    work_id: str
    text: str
    locator: str
    scope: EvidenceScope
    id: str = field(default_factory=new_id)
    sha256: str = field(init=False)

    def __post_init__(self) -> None:
        if not self.text:
            raise ValueError("Evidence text cannot be empty.")
        if not self.locator.strip():
            raise ValueError("Evidence locator cannot be empty.")
        object.__setattr__(self, "locator", self.locator.strip())
        object.__setattr__(self, "sha256", sha256_text(self.text))

    def verifies(self, text: str) -> bool:
        return sha256_text(text) == self.sha256


class ClaimKind(StrEnum):
    SOURCED = "sourced"
    SYSTEM = "system"


@dataclass(frozen=True, slots=True, kw_only=True)
class Claim:
    report_id: str
    text: str
    kind: ClaimKind = ClaimKind.SOURCED
    id: str = field(default_factory=new_id)

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("Claim text cannot be empty.")
        object.__setattr__(self, "text", self.text.strip())


class ClaimEvidenceRelation(StrEnum):
    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    CONTEXTUALIZES = "contextualizes"


@dataclass(frozen=True, slots=True)
class ClaimEvidenceLink:
    claim_id: str
    evidence_segment_id: str
    relation: ClaimEvidenceRelation = ClaimEvidenceRelation.SUPPORTS
