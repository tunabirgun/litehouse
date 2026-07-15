from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class FetchRequest:
    source: str
    endpoint: str
    url: str
    accepted_mime_types: frozenset[str] = frozenset({"application/json"})
    max_bytes: int = 5 * 1024 * 1024
    redirect_limit: int = 0

    def __post_init__(self) -> None:
        if self.max_bytes < 1:
            raise ValueError("Fetch size limit must be positive.")
        if not 0 <= self.redirect_limit <= 3:
            raise ValueError("Redirect limit must be between zero and three.")
        if not self.accepted_mime_types:
            raise ValueError("At least one response MIME type must be allowed.")


@dataclass(frozen=True, slots=True)
class RawResponse:
    status_code: int
    headers: Mapping[str, str]
    body: bytes
    peer_ip: str

    def __post_init__(self) -> None:
        normalized = {key.lower(): value for key, value in self.headers.items()}
        object.__setattr__(self, "headers", MappingProxyType(normalized))


@dataclass(frozen=True, slots=True)
class FetchReceipt:
    source: str
    endpoint: str
    request_sha256: str
    content_sha256: str
    size: int
    content_type: str
    status_code: int
    resolved_addresses: tuple[str, ...]
    peer_ip: str
    retrieved_at: datetime


@dataclass(frozen=True, slots=True)
class FetchError:
    source: str
    code: str
    message: str
    retryable: bool
    partial_source: bool = True
    http_status: int | None = None


@dataclass(frozen=True, slots=True)
class FetchResult:
    payload: bytes | None = None
    receipt: FetchReceipt | None = None
    error: FetchError | None = None

    def __post_init__(self) -> None:
        accepted = self.payload is not None and self.receipt is not None and self.error is None
        rejected = self.payload is None and self.receipt is None and self.error is not None
        if not (accepted or rejected):
            raise ValueError("A fetch result must contain either accepted data or one error.")

    @property
    def accepted(self) -> bool:
        return self.error is None
