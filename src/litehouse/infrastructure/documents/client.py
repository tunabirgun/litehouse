from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path

from litehouse.infrastructure.blobs import BlobIntegrityError
from litehouse.infrastructure.documents.blob_store import DocumentBlobStore
from litehouse.infrastructure.documents.models import (
    DocumentError,
    DocumentProvider,
    DocumentRequest,
    DocumentResult,
    DownloadReceipt,
)
from litehouse.infrastructure.documents.policy import DOCUMENT_POLICY, DocumentPolicyError
from litehouse.infrastructure.documents.transport import (
    DocumentTransport,
    DocumentTransportError,
    HttpxDocumentTransport,
)
from litehouse.infrastructure.fetch.policy import DestinationPolicy, DestinationPolicyError
from litehouse.infrastructure.fetch.resolver import ResolutionError, Resolver, SystemResolver

MAX_PDF_BYTES = 100 * 1024 * 1024
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_PDF_HEADER = re.compile(rb"^%PDF-1\.[0-9]\r?\n")
_PDF_EOF = re.compile(rb"%%EOF[\x00\x09\x0a\x0c\x0d\x20]*\Z")


class OpenAccessDocumentDownloader:
    def __init__(
        self,
        blob_store: DocumentBlobStore,
        *,
        resolver: Resolver | None = None,
        transport: DocumentTransport | None = None,
        clock: Callable[[], datetime] | None = None,
        temporary_directory: Path | None = None,
    ) -> None:
        self._blob_store = blob_store
        self._resolver = resolver or SystemResolver()
        self._transport = transport or HttpxDocumentTransport()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._temporary_directory = temporary_directory

    async def acquire(self, request: DocumentRequest) -> DocumentResult:
        try:
            DOCUMENT_POLICY.validate_evidence(request.evidence, request)
            target = DOCUMENT_POLICY.build_target(request)
            parsed = DOCUMENT_POLICY.validate_constructed_url(target)
        except DocumentPolicyError:
            return self._failure(
                request.provider,
                "document_request_rejected",
                "The open-access document request was rejected by policy.",
                retryable=False,
            )

        try:
            answers = await self._resolver.resolve(parsed.hostname or "", 443)
            resolved = DestinationPolicy.validate_addresses(answers)
        except DestinationPolicyError:
            return self._failure(
                request.provider,
                "destination_rejected",
                "The document repository destination was rejected.",
                retryable=False,
            )
        except ResolutionError:
            return self._failure(
                request.provider,
                "repository_resolution_error",
                "The document repository could not be resolved.",
                retryable=True,
            )

        stream = None
        temporary_path: Path | None = None
        try:
            stream = await self._transport.open(target.url, resolved_addresses=resolved)
            peer_ip = DestinationPolicy.validate_address(stream.peer_ip)
            if peer_ip not in resolved:
                return self._failure(
                    request.provider,
                    "peer_mismatch",
                    "The repository connection did not match its DNS answers.",
                    retryable=True,
                )
            header_error = self._validate_response_headers(
                request.provider,
                stream.status_code,
                stream.headers,
            )
            if header_error is not None:
                return header_error

            declared_size = int(stream.headers["content-length"])
            descriptor, temporary_name = tempfile.mkstemp(
                dir=self._temporary_directory,
                prefix="litehouse-pdf-",
            )
            temporary_path = Path(temporary_name)
            os.fchmod(descriptor, 0o600)
            digest = hashlib.sha256()
            size = 0
            prefix = bytearray()
            tail = bytearray()
            with os.fdopen(descriptor, "wb") as output:
                async for chunk in stream.iter_bytes():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_PDF_BYTES or size > declared_size:
                        return self._failure(
                            request.provider,
                            "response_too_large",
                            "The repository document exceeded its declared size limit.",
                            retryable=False,
                        )
                    digest.update(chunk)
                    output.write(chunk)
                    if len(prefix) < 16:
                        prefix.extend(chunk[: 16 - len(prefix)])
                    if len(chunk) >= 2048:
                        tail = bytearray(chunk[-2048:])
                    else:
                        tail.extend(chunk)
                        if len(tail) > 2048:
                            del tail[:-2048]
                output.flush()
                os.fsync(output.fileno())

            if size != declared_size:
                return self._failure(
                    request.provider,
                    "response_length_mismatch",
                    "The repository document did not match its declared size.",
                    retryable=True,
                )
            if not _PDF_HEADER.match(prefix):
                return self._failure(
                    request.provider,
                    "pdf_header_rejected",
                    "The repository response did not have a canonical PDF header.",
                    retryable=False,
                )
            if not _PDF_EOF.search(tail):
                return self._failure(
                    request.provider,
                    "pdf_eof_rejected",
                    "The repository response did not have a valid PDF terminator.",
                    retryable=False,
                )

            content_sha256 = digest.hexdigest()
            blob = self._blob_store.put_verified_file(
                temporary_path,
                expected_sha256=content_sha256,
                size=size,
            )
            receipt = DownloadReceipt(
                provider=request.provider,
                source_record_id=request.evidence.source_record_id,
                request_sha256=self._request_sha256(request, target.url),
                content_sha256=content_sha256,
                size=size,
                content_type="application/pdf",
                resolved_addresses=resolved,
                peer_ip=peer_ip,
                source_record_sha256=request.evidence.source_record_sha256,
                source_record_retrieved_at=request.evidence.source_record_retrieved_at,
                access_assertion=request.evidence.access_assertion,
                license_url=request.evidence.license_url,
                retrieved_at=self._clock(),
            )
            return DocumentResult(blob=blob, receipt=receipt)
        except DocumentTransportError as error:
            return self._failure(
                request.provider,
                error.code,
                error.safe_message,
                retryable=error.retryable,
            )
        except DestinationPolicyError:
            return self._failure(
                request.provider,
                "peer_rejected",
                "The repository connection address was rejected.",
                retryable=True,
            )
        except BlobIntegrityError:
            return self._failure(
                request.provider,
                "content_store_rejected",
                "The downloaded document failed content-store verification.",
                retryable=False,
            )
        finally:
            if stream is not None:
                await stream.aclose()
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _validate_response_headers(
        provider: DocumentProvider,
        status_code: int,
        headers: Mapping[str, str],
    ) -> DocumentResult | None:
        if status_code in _REDIRECT_STATUSES:
            return OpenAccessDocumentDownloader._failure(
                provider,
                "redirect_rejected",
                "The document repository returned a disallowed redirect.",
                retryable=False,
                http_status=status_code,
            )
        if not 200 <= status_code < 300:
            return OpenAccessDocumentDownloader._failure(
                provider,
                "repository_http_error",
                "The document repository returned an unsuccessful status.",
                retryable=status_code == 429 or status_code >= 500,
                http_status=status_code,
            )
        content_type = headers.get("content-type", "").partition(";")[0].strip().lower()
        if content_type != "application/pdf":
            return OpenAccessDocumentDownloader._failure(
                provider,
                "mime_rejected",
                "The repository returned an unexpected content type.",
                retryable=False,
            )
        content_encoding = headers.get("content-encoding", "").strip().lower()
        if content_encoding not in ("", "identity"):
            return OpenAccessDocumentDownloader._failure(
                provider,
                "content_encoding_rejected",
                "The repository returned an encoded document.",
                retryable=False,
            )
        transfer_encoding = headers.get("transfer-encoding", "").strip().lower()
        if transfer_encoding:
            return OpenAccessDocumentDownloader._failure(
                provider,
                "transfer_encoding_rejected",
                "The repository returned a streamed document without a fixed length.",
                retryable=False,
            )
        content_length = headers.get("content-length", "")
        if not content_length.isdecimal() or int(content_length) < 1:
            return OpenAccessDocumentDownloader._failure(
                provider,
                "invalid_response_length",
                "The repository returned an invalid response length.",
                retryable=False,
            )
        if int(content_length) > MAX_PDF_BYTES:
            return OpenAccessDocumentDownloader._failure(
                provider,
                "response_too_large",
                "The repository document exceeded the size limit.",
                retryable=False,
            )
        return None

    @staticmethod
    def _request_sha256(request: DocumentRequest, url: str) -> str:
        canonical = json.dumps(
            {
                "access_assertion": request.evidence.access_assertion,
                "license_url": request.evidence.license_url,
                "provider": request.provider,
                "repository_id": request.repository_id,
                "source_record_sha256": request.evidence.source_record_sha256,
                "url": url,
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    @staticmethod
    def _failure(
        provider: DocumentProvider,
        code: str,
        message: str,
        *,
        retryable: bool,
        http_status: int | None = None,
    ) -> DocumentResult:
        return DocumentResult(
            error=DocumentError(
                provider=provider,
                code=code,
                message=message,
                retryable=retryable,
                http_status=http_status,
            )
        )
