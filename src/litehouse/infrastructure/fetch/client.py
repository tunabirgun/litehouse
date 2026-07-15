from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from urllib.parse import urljoin

from litehouse.infrastructure.fetch.models import (
    FetchError,
    FetchReceipt,
    FetchRequest,
    FetchResult,
)
from litehouse.infrastructure.fetch.policy import (
    OFFICIAL_SOURCE_POLICY,
    DestinationPolicyError,
)
from litehouse.infrastructure.fetch.resolver import ResolutionError, Resolver, SystemResolver
from litehouse.infrastructure.fetch.transport import FetchTransportError, HttpxTransport, Transport

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


class OfficialSourceFetcher:
    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        transport: Transport | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._resolver = resolver or SystemResolver()
        self._transport = transport or HttpxTransport()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._policy = OFFICIAL_SOURCE_POLICY

    async def fetch(self, request: FetchRequest) -> FetchResult:
        current_url = request.url
        for redirect_count in range(request.redirect_limit + 1):
            validation = await self._validate_destination(request, current_url)
            if isinstance(validation, FetchResult):
                return validation
            resolved = validation

            try:
                response = await self._transport.send(
                    current_url,
                    max_bytes=request.max_bytes,
                    resolved_addresses=resolved,
                )
                peer_ip = self._policy.validate_address(response.peer_ip)
            except FetchTransportError as error:
                return self._failure(
                    request,
                    error.code,
                    error.safe_message,
                    retryable=error.retryable,
                )
            except DestinationPolicyError:
                return self._failure(
                    request,
                    "peer_rejected",
                    "The official source connection address was rejected.",
                    retryable=True,
                )

            if len(response.body) > request.max_bytes:
                return self._failure(
                    request,
                    "response_too_large",
                    "The official source response exceeded the size limit.",
                    retryable=False,
                )
            if peer_ip not in resolved:
                return self._failure(
                    request,
                    "peer_mismatch",
                    "The official source connection did not match its DNS answers.",
                    retryable=True,
                )

            if response.status_code in _REDIRECT_STATUSES:
                if redirect_count >= request.redirect_limit:
                    return self._failure(
                        request,
                        "redirect_rejected",
                        "The official source returned a disallowed redirect.",
                        retryable=False,
                        http_status=response.status_code,
                    )
                location = response.headers.get("location")
                if not location:
                    return self._failure(
                        request,
                        "invalid_redirect",
                        "The official source returned an invalid redirect.",
                        retryable=False,
                        http_status=response.status_code,
                    )
                current_url = urljoin(current_url, location)
                continue

            if not 200 <= response.status_code < 300:
                return self._failure(
                    request,
                    "source_http_error",
                    "The official source returned an unsuccessful status.",
                    retryable=response.status_code == 429 or response.status_code >= 500,
                    http_status=response.status_code,
                )

            content_type = self._content_type(response.headers.get("content-type"))
            if content_type not in request.accepted_mime_types:
                return self._failure(
                    request,
                    "mime_rejected",
                    "The official source returned an unexpected content type.",
                    retryable=False,
                )
            if not self._matches_declared_type(response.body, content_type):
                return self._failure(
                    request,
                    "content_rejected",
                    "The official source response did not match its declared content type.",
                    retryable=False,
                )

            receipt = FetchReceipt(
                source=request.source,
                endpoint=request.endpoint,
                request_sha256=hashlib.sha256(current_url.encode("utf-8")).hexdigest(),
                content_sha256=hashlib.sha256(response.body).hexdigest(),
                size=len(response.body),
                content_type=content_type,
                status_code=response.status_code,
                resolved_addresses=resolved,
                peer_ip=peer_ip,
                retrieved_at=self._clock(),
            )
            return FetchResult(payload=response.body, receipt=receipt)

        return self._failure(
            request,
            "redirect_rejected",
            "The official source returned a disallowed redirect.",
            retryable=False,
        )

    async def _validate_destination(
        self,
        request: FetchRequest,
        url: str,
    ) -> tuple[str, ...] | FetchResult:
        try:
            parsed = self._policy.validate_url(url)
            answers = await self._resolver.resolve(parsed.hostname or "", 443)
            return self._policy.validate_addresses(answers)
        except DestinationPolicyError:
            return self._failure(
                request,
                "destination_rejected",
                "The source destination was rejected by policy.",
                retryable=False,
            )
        except ResolutionError:
            return self._failure(
                request,
                "source_resolution_error",
                "The official source could not be resolved.",
                retryable=True,
            )

    @staticmethod
    def _content_type(value: str | None) -> str:
        if value is None:
            return ""
        return value.partition(";")[0].strip().lower()

    @staticmethod
    def _matches_declared_type(body: bytes, content_type: str) -> bool:
        if content_type != "application/json" and not content_type.endswith("+json"):
            return False
        try:
            decoded = body.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        return isinstance(value, dict | list)

    @staticmethod
    def _failure(
        request: FetchRequest,
        code: str,
        message: str,
        *,
        retryable: bool,
        http_status: int | None = None,
    ) -> FetchResult:
        return FetchResult(
            error=FetchError(
                source=request.source,
                code=code,
                message=message,
                retryable=retryable,
                http_status=http_status,
            )
        )


def with_redirect_limit(request: FetchRequest, limit: int) -> FetchRequest:
    """Return an explicit redirect-enabled request for a reviewed connector contract."""

    return replace(request, redirect_limit=limit)
