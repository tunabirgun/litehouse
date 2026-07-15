from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from litehouse.infrastructure.blobs import BlobRef

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DocumentProvider(StrEnum):
    ARXIV = "arxiv"
    PMC = "pmc"


class AccessAssertion(StrEnum):
    OPEN_ACCESS = "open_access"
    PUBLIC_DOMAIN = "public_domain"
    CC0 = "cc0"
    CC_BY = "cc_by"
    CC_BY_SA = "cc_by_sa"


@dataclass(frozen=True, slots=True)
class OpenAccessEvidence:
    provider: DocumentProvider
    source_record_id: str
    source_record_sha256: str
    source_record_retrieved_at: datetime
    access_assertion: AccessAssertion
    license_url: str

    def __post_init__(self) -> None:
        if not SHA256_PATTERN.fullmatch(self.source_record_sha256):
            raise ValueError("Source-record SHA-256 must use canonical lowercase hex.")
        if self.source_record_retrieved_at.tzinfo is None:
            raise ValueError("Source-record retrieval time must include a timezone.")


@dataclass(frozen=True, slots=True)
class DocumentRequest:
    provider: DocumentProvider
    repository_id: str
    exact_pdf_path: str
    evidence: OpenAccessEvidence


@dataclass(frozen=True, slots=True)
class DownloadReceipt:
    provider: DocumentProvider
    source_record_id: str
    request_sha256: str
    content_sha256: str
    size: int
    content_type: str
    resolved_addresses: tuple[str, ...]
    peer_ip: str
    source_record_sha256: str
    source_record_retrieved_at: datetime
    access_assertion: AccessAssertion
    license_url: str
    retrieved_at: datetime


@dataclass(frozen=True, slots=True)
class DocumentError:
    provider: DocumentProvider
    code: str
    message: str
    retryable: bool
    partial_source: bool = True
    http_status: int | None = None


@dataclass(frozen=True, slots=True)
class DocumentResult:
    blob: BlobRef | None = None
    receipt: DownloadReceipt | None = None
    error: DocumentError | None = None

    def __post_init__(self) -> None:
        accepted = self.blob is not None and self.receipt is not None and self.error is None
        rejected = self.blob is None and self.receipt is None and self.error is not None
        if not (accepted or rejected):
            raise ValueError("A document result must contain accepted data or one error.")

    @property
    def accepted(self) -> bool:
        return self.error is None
