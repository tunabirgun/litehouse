from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType


class UnsupportedSourceError(ValueError):
    """Raised when a source cannot meet the safe JSON retrieval contract."""


@dataclass(frozen=True, slots=True)
class UnsupportedSource:
    source: str
    reason_code: str


UNSUPPORTED_SOURCES = MappingProxyType(
    {
        "arxiv": UnsupportedSource(source="arxiv", reason_code="xml_only"),
        "core": UnsupportedSource(source="core", reason_code="credential_required"),
        "doaj": UnsupportedSource(source="doaj", reason_code="query_in_path"),
        "google_scholar": UnsupportedSource(
            source="google_scholar",
            reason_code="no_official_public_api",
        ),
    }
)


def reject_unsupported_source(source: str) -> None:
    normalized = source.strip().lower()
    if normalized in UNSUPPORTED_SOURCES:
        raise UnsupportedSourceError("Source is not enabled by the safe retrieval policy.")
