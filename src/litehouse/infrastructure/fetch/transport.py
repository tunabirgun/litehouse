from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

import httpcore
import httpx

from litehouse.infrastructure.fetch.models import RawResponse


class FetchTransportError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class Transport(Protocol):
    async def send(
        self,
        url: str,
        *,
        max_bytes: int,
        resolved_addresses: tuple[str, ...],
    ) -> RawResponse: ...


class _NetworkStream(Protocol):
    def get_extra_info(self, info: str) -> Any: ...


class _CoreResponseStream(Protocol):
    def __aiter__(self) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


class _HttpxResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream: _CoreResponseStream) -> None:
        self._stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for part in self._stream:
            yield part

    async def aclose(self) -> None:
        await self._stream.aclose()


class PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Replace the approved hostname only at the TCP connection boundary."""

    def __init__(
        self,
        official_host: str,
        addresses: tuple[str, ...],
        backend: httpcore.AsyncNetworkBackend,
    ) -> None:
        if not addresses:
            raise ValueError("A pinned network backend requires validated addresses.")
        self._official_host = official_host
        self._addresses = addresses
        self._backend = backend

    async def connect_tcp(  # noqa: ASYNC109 - httpcore interface
        self,
        host: str,
        port: int,
        timeout: float | None = None,  # noqa: ASYNC109 - httpcore interface
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        if host != self._official_host or port != 443:
            raise httpcore.ConnectError("Connection destination is outside the pinned endpoint.")

        last_error: httpcore.ConnectError | httpcore.ConnectTimeout | None = None
        for address in self._addresses:
            try:
                return await self._backend.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                last_error = error
        if last_error is not None:
            raise last_error
        raise httpcore.ConnectError("No validated destination address was available.")

    async def connect_unix_socket(  # noqa: ASYNC109 - httpcore interface
        self,
        path: str,
        timeout: float | None = None,  # noqa: ASYNC109 - httpcore interface
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Unix sockets are disabled for source retrieval.")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class _PinnedHTTPTransport(httpx.AsyncBaseTransport):
    def __init__(self, backend: PinnedNetworkBackend) -> None:
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpcore.default_ssl_context(),
            max_connections=1,
            max_keepalive_connections=0,
            http1=True,
            http2=False,
            retries=0,
            network_backend=backend,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not isinstance(request.stream, httpx.AsyncByteStream):
            raise httpcore.LocalProtocolError("An asynchronous request stream is required.")
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        core_response = await self._pool.handle_async_request(core_request)
        stream = cast(_CoreResponseStream, core_response.stream)
        return httpx.Response(
            status_code=core_response.status,
            headers=core_response.headers,
            stream=_HttpxResponseStream(stream),
            extensions=core_response.extensions,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()


class HttpxTransport:
    def __init__(
        self,
        *,
        timeout_seconds: float = 20.0,
        network_backend_factory: Callable[[], httpcore.AsyncNetworkBackend] | None = None,
    ) -> None:
        self._timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 10.0))
        self._network_backend_factory = network_backend_factory or httpcore.AnyIOBackend

    async def send(
        self,
        url: str,
        *,
        max_bytes: int,
        resolved_addresses: tuple[str, ...],
    ) -> RawResponse:
        official_host = urlsplit(url).hostname
        if official_host is None:
            raise FetchTransportError(
                "destination_rejected",
                "The source destination was rejected by policy.",
                retryable=False,
            )
        backend = PinnedNetworkBackend(
            official_host,
            resolved_addresses,
            self._network_backend_factory(),
        )
        pinned_transport = _PinnedHTTPTransport(backend)
        try:
            async with httpx.AsyncClient(
                follow_redirects=False,
                trust_env=False,
                timeout=self._timeout,
                transport=pinned_transport,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "Litehouse/0.1 (+local scholarly retrieval)",
                },
            ) as client:
                async with client.stream("GET", url) as response:
                    self._check_declared_size(response.headers.get("content-length"), max_bytes)
                    peer_ip = self._peer_ip(response)
                    body = await self._read_bounded(response, max_bytes)
                    return RawResponse(
                        status_code=response.status_code,
                        headers=dict(response.headers),
                        body=body,
                        peer_ip=peer_ip,
                    )
        except FetchTransportError:
            raise
        except (httpcore.TimeoutException, httpx.TimeoutException) as error:
            raise FetchTransportError(
                "source_timeout",
                "The official source timed out.",
                retryable=True,
            ) from error
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError) as error:
            raise FetchTransportError(
                "source_transport_error",
                "The official source request failed.",
                retryable=True,
            ) from error

    @staticmethod
    def _check_declared_size(value: str | None, max_bytes: int) -> None:
        if value is None:
            return
        if not value.isdecimal():
            raise FetchTransportError(
                "invalid_response_length",
                "The official source returned an invalid response length.",
                retryable=False,
            )
        if int(value) > max_bytes:
            raise FetchTransportError(
                "response_too_large",
                "The official source response exceeded the size limit.",
                retryable=False,
            )

    @staticmethod
    async def _read_bounded(response: httpx.Response, max_bytes: int) -> bytes:
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise FetchTransportError(
                    "response_too_large",
                    "The official source response exceeded the size limit.",
                    retryable=False,
                )
            chunks.append(chunk)
        return b"".join(chunks)

    @staticmethod
    def _peer_ip(response: httpx.Response) -> str:
        candidate = response.extensions.get("network_stream")
        if candidate is None or not hasattr(candidate, "get_extra_info"):
            raise FetchTransportError(
                "peer_unavailable",
                "The official source connection address could not be verified.",
                retryable=True,
            )
        stream = cast(_NetworkStream, candidate)
        server_address = stream.get_extra_info("server_addr")
        if not isinstance(server_address, tuple) or not server_address:
            raise FetchTransportError(
                "peer_unavailable",
                "The official source connection address could not be verified.",
                retryable=True,
            )
        peer_ip = server_address[0]
        if not isinstance(peer_ip, str):
            raise FetchTransportError(
                "peer_unavailable",
                "The official source connection address could not be verified.",
                retryable=True,
            )
        return peer_ip
