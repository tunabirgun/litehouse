from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping
from typing import Protocol, cast

import httpcore
import httpx

from litehouse.infrastructure.fetch.transport import PinnedNetworkBackend, _PinnedHTTPTransport


class DocumentTransportError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class DocumentStream(Protocol):
    status_code: int
    headers: Mapping[str, str]
    peer_ip: str

    def iter_bytes(self) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


class DocumentTransport(Protocol):
    async def open(
        self,
        url: str,
        *,
        resolved_addresses: tuple[str, ...],
    ) -> DocumentStream: ...


class _NetworkStream(Protocol):
    def get_extra_info(self, info: str) -> object: ...


class HttpxDocumentStream:
    def __init__(self, response: httpx.Response, client: httpx.AsyncClient) -> None:
        self._response = response
        self._client = client
        self.status_code = response.status_code
        self.headers: Mapping[str, str] = {
            key.lower(): value for key, value in response.headers.items()
        }
        self.peer_ip = self._peer_ip(response)

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._response.aiter_raw():
                yield chunk
        except (httpcore.TimeoutException, httpx.TimeoutException) as error:
            raise DocumentTransportError(
                "repository_timeout",
                "The document repository timed out.",
                retryable=True,
            ) from error
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError) as error:
            raise DocumentTransportError(
                "repository_transport_error",
                "The document repository request failed.",
                retryable=True,
            ) from error

    async def aclose(self) -> None:
        try:
            await self._response.aclose()
        finally:
            await self._client.aclose()

    @staticmethod
    def _peer_ip(response: httpx.Response) -> str:
        candidate = response.extensions.get("network_stream")
        if candidate is None or not hasattr(candidate, "get_extra_info"):
            raise DocumentTransportError(
                "peer_unavailable",
                "The repository connection address could not be verified.",
                retryable=True,
            )
        stream = cast(_NetworkStream, candidate)
        server_address = stream.get_extra_info("server_addr")
        if not isinstance(server_address, tuple) or not server_address:
            raise DocumentTransportError(
                "peer_unavailable",
                "The repository connection address could not be verified.",
                retryable=True,
            )
        peer_ip = server_address[0]
        if not isinstance(peer_ip, str):
            raise DocumentTransportError(
                "peer_unavailable",
                "The repository connection address could not be verified.",
                retryable=True,
            )
        return peer_ip


class HttpxDocumentTransport:
    def __init__(
        self,
        *,
        timeout_seconds: float = 30.0,
        network_backend_factory: Callable[[], httpcore.AsyncNetworkBackend] | None = None,
    ) -> None:
        self._timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 10.0))
        self._network_backend_factory = network_backend_factory or httpcore.AnyIOBackend

    async def open(
        self,
        url: str,
        *,
        resolved_addresses: tuple[str, ...],
    ) -> DocumentStream:
        host = httpx.URL(url).host
        backend = PinnedNetworkBackend(
            host,
            resolved_addresses,
            self._network_backend_factory(),
        )
        client = httpx.AsyncClient(
            follow_redirects=False,
            trust_env=False,
            timeout=self._timeout,
            transport=_PinnedHTTPTransport(backend),
            headers={
                "Accept": "application/pdf",
                "Accept-Encoding": "identity",
                "User-Agent": "Litehouse/0.1 (+local open-access retrieval)",
            },
        )
        response: httpx.Response | None = None
        try:
            request = client.build_request("GET", url)
            response = await client.send(request, stream=True)
            return HttpxDocumentStream(response, client)
        except DocumentTransportError:
            if response is not None:
                await response.aclose()
            await client.aclose()
            raise
        except (httpcore.TimeoutException, httpx.TimeoutException) as error:
            await client.aclose()
            raise DocumentTransportError(
                "repository_timeout",
                "The document repository timed out.",
                retryable=True,
            ) from error
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError) as error:
            await client.aclose()
            raise DocumentTransportError(
                "repository_transport_error",
                "The document repository request failed.",
                retryable=True,
            ) from error
