from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx

from litehouse.infrastructure.fetch.policy import DestinationPolicy, DestinationPolicyError
from litehouse.infrastructure.fetch.resolver import ResolutionError, Resolver, SystemResolver
from litehouse.infrastructure.fetch.transport import PinnedNetworkBackend, _PinnedHTTPTransport
from litehouse.infrastructure.models.artifacts import (
    IntegratedModelArtifact,
    is_allowed_artifact_host,
)

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ACCEPTED_MIME_TYPES = frozenset(
    {
        "application/octet-stream",
        "binary/octet-stream",
        "application/x-binary",
    }
)
MAX_REDIRECTS = 3
DISK_RESERVE_BYTES = 1024**3


class ModelDownloadCancelled(RuntimeError):
    pass


class ModelDownloadError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ModelDownloadProgress:
    downloaded_bytes: int
    total_bytes: int


@dataclass(frozen=True, slots=True)
class ModelInstallReceipt:
    model_id: str
    repository_id: str
    revision: str
    filename: str
    size: int
    sha256: str
    license_spdx: str
    request_sha256: str
    final_host: str
    installed_at: datetime
    reused_verified_file: bool


@dataclass(frozen=True, slots=True)
class InstalledModel:
    path: Path
    receipt: ModelInstallReceipt


class ArtifactStream(Protocol):
    status_code: int
    headers: Mapping[str, str]
    peer_ip: str

    def iter_bytes(self) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


class ArtifactTransport(Protocol):
    async def open(
        self,
        url: str,
        *,
        resolved_addresses: tuple[str, ...],
    ) -> ArtifactStream: ...


class _NetworkStream(Protocol):
    def get_extra_info(self, info: str) -> object: ...


class _HttpxArtifactStream:
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
            raise ModelDownloadError(
                "model_download_timeout",
                "The model download timed out.",
                retryable=True,
            ) from error
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError) as error:
            raise ModelDownloadError(
                "model_download_transport_error",
                "The model download failed in transit.",
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
            raise ModelDownloadError(
                "model_peer_unavailable",
                "The model host connection address could not be verified.",
                retryable=True,
            )
        stream = cast(_NetworkStream, candidate)
        server_address = stream.get_extra_info("server_addr")
        if not isinstance(server_address, tuple) or not server_address:
            raise ModelDownloadError(
                "model_peer_unavailable",
                "The model host connection address could not be verified.",
                retryable=True,
            )
        peer_ip = server_address[0]
        if not isinstance(peer_ip, str):
            raise ModelDownloadError(
                "model_peer_unavailable",
                "The model host connection address could not be verified.",
                retryable=True,
            )
        return peer_ip


class HttpxArtifactTransport:
    def __init__(
        self,
        *,
        timeout_seconds: float = 60.0,
        network_backend_factory: Callable[[], httpcore.AsyncNetworkBackend] | None = None,
    ) -> None:
        self._timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 10.0))
        self._network_backend_factory = network_backend_factory or httpcore.AnyIOBackend

    async def open(
        self,
        url: str,
        *,
        resolved_addresses: tuple[str, ...],
    ) -> ArtifactStream:
        host = httpx.URL(url).host
        backend = PinnedNetworkBackend(host, resolved_addresses, self._network_backend_factory())
        client = httpx.AsyncClient(
            follow_redirects=False,
            trust_env=False,
            timeout=self._timeout,
            transport=_PinnedHTTPTransport(backend),
            headers={
                "Accept": "application/octet-stream",
                "Accept-Encoding": "identity",
                "User-Agent": "Litehouse/0.1 (+verified local model installer)",
            },
        )
        response: httpx.Response | None = None
        try:
            response = await client.send(client.build_request("GET", url), stream=True)
            return _HttpxArtifactStream(response, client)
        except ModelDownloadError:
            if response is not None:
                await response.aclose()
            await client.aclose()
            raise
        except (httpcore.TimeoutException, httpx.TimeoutException) as error:
            await client.aclose()
            raise ModelDownloadError(
                "model_download_timeout",
                "The model host timed out.",
                retryable=True,
            ) from error
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError) as error:
            await client.aclose()
            raise ModelDownloadError(
                "model_download_transport_error",
                "The model host request failed.",
                retryable=True,
            ) from error


class VerifiedModelInstaller:
    def __init__(
        self,
        root: Path,
        *,
        resolver: Resolver | None = None,
        transport: ArtifactTransport | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.root = root.resolve()
        self._resolver = resolver or SystemResolver()
        self._transport = transport or HttpxArtifactTransport()
        self._clock = clock or (lambda: datetime.now(UTC))

    async def install(
        self,
        artifact: IntegratedModelArtifact,
        *,
        progress: Callable[[ModelDownloadProgress], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> InstalledModel:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = self.root / artifact.sha256 / artifact.filename
        if destination.exists() and self._verify_file(destination, artifact):
            return self._installed(artifact, destination, artifact.source_url, reused=True)
        if destination.exists():
            raise ModelDownloadError(
                "installed_model_corrupt",
                "An existing model file failed SHA-256 verification.",
                retryable=False,
            )
        free = shutil.disk_usage(self.root).free
        if free < artifact.size + DISK_RESERVE_BYTES:
            raise ModelDownloadError(
                "insufficient_disk_space",
                "There is not enough free disk space to install this model safely.",
                retryable=False,
            )

        current_url = artifact.source_url
        stream: ArtifactStream | None = None
        for redirect_count in range(MAX_REDIRECTS + 1):
            resolved = await self._resolve(current_url)
            stream = await self._transport.open(current_url, resolved_addresses=resolved)
            peer = DestinationPolicy.validate_address(stream.peer_ip)
            if peer not in resolved:
                await stream.aclose()
                raise ModelDownloadError(
                    "model_peer_mismatch",
                    "The model host connection did not match its DNS answers.",
                    retryable=True,
                )
            if stream.status_code in _REDIRECT_STATUSES:
                location = stream.headers.get("location")
                await stream.aclose()
                stream = None
                if redirect_count >= MAX_REDIRECTS or not location:
                    raise ModelDownloadError(
                        "model_redirect_rejected",
                        "The model host returned an invalid redirect chain.",
                        retryable=False,
                    )
                candidate = urljoin(current_url, location)
                if not is_allowed_artifact_host(candidate):
                    raise ModelDownloadError(
                        "model_redirect_rejected",
                        "The model host redirected outside the trusted artifact service.",
                        retryable=False,
                    )
                current_url = candidate
                continue
            break
        if stream is None:
            raise ModelDownloadError(
                "model_download_unavailable",
                "The model host returned no downloadable artifact.",
                retryable=True,
            )
        temporary_path: Path | None = None
        try:
            self._validate_headers(stream.status_code, stream.headers, artifact)
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor, temporary_name = tempfile.mkstemp(
                dir=destination.parent,
                prefix=f".{artifact.sha256}.partial-",
            )
            temporary_path = Path(temporary_name)
            os.fchmod(descriptor, 0o600)
            digest = hashlib.sha256()
            size = 0
            with os.fdopen(descriptor, "wb") as output:
                async for chunk in stream.iter_bytes():
                    if cancelled and cancelled():
                        raise ModelDownloadCancelled("The model installation was cancelled.")
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > artifact.size:
                        raise ModelDownloadError(
                            "model_size_mismatch",
                            "The model artifact exceeded its pinned size.",
                            retryable=False,
                        )
                    digest.update(chunk)
                    output.write(chunk)
                    if progress:
                        progress(ModelDownloadProgress(size, artifact.size))
                output.flush()
                os.fsync(output.fileno())
            if size != artifact.size or digest.hexdigest() != artifact.sha256:
                raise ModelDownloadError(
                    "model_integrity_mismatch",
                    "The model artifact failed pinned size or SHA-256 verification.",
                    retryable=False,
                )
            os.replace(temporary_path, destination)
            temporary_path = None
            self._fsync_directory(destination.parent)
            return self._installed(artifact, destination, current_url, reused=False)
        finally:
            await stream.aclose()
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    async def _resolve(self, url: str) -> tuple[str, ...]:
        if not is_allowed_artifact_host(url):
            raise ModelDownloadError(
                "model_destination_rejected",
                "The model artifact destination is not trusted.",
                retryable=False,
            )
        hostname = urlsplit(url).hostname or ""
        try:
            answers = await self._resolver.resolve(hostname, 443)
            return DestinationPolicy.validate_addresses(answers)
        except DestinationPolicyError as error:
            raise ModelDownloadError(
                "model_destination_rejected",
                "The model artifact destination was rejected.",
                retryable=False,
            ) from error
        except ResolutionError as error:
            raise ModelDownloadError(
                "model_resolution_error",
                "The model artifact host could not be resolved.",
                retryable=True,
            ) from error

    @staticmethod
    def _validate_headers(
        status_code: int,
        headers: Mapping[str, str],
        artifact: IntegratedModelArtifact,
    ) -> None:
        if not 200 <= status_code < 300:
            raise ModelDownloadError(
                "model_http_error",
                "The model host returned an unsuccessful response.",
                retryable=status_code == 429 or status_code >= 500,
            )
        content_type = headers.get("content-type", "").partition(";")[0].strip().casefold()
        if content_type not in _ACCEPTED_MIME_TYPES:
            raise ModelDownloadError(
                "model_mime_rejected",
                "The model host returned an unexpected content type.",
                retryable=False,
            )
        if headers.get("content-encoding", "").strip().casefold() not in {"", "identity"}:
            raise ModelDownloadError(
                "model_encoding_rejected",
                "The model host returned encoded artifact bytes.",
                retryable=False,
            )
        if headers.get("transfer-encoding", "").strip():
            raise ModelDownloadError(
                "model_transfer_encoding_rejected",
                "The model host did not provide fixed artifact bytes.",
                retryable=False,
            )
        content_length = headers.get("content-length", "")
        if not content_length.isdecimal() or int(content_length) != artifact.size:
            raise ModelDownloadError(
                "model_size_mismatch",
                "The model host response did not match the pinned artifact size.",
                retryable=False,
            )

    @staticmethod
    def _verify_file(path: Path, artifact: IntegratedModelArtifact) -> bool:
        if not path.is_file() or path.is_symlink() or path.stat().st_size != artifact.size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest() == artifact.sha256

    def _installed(
        self,
        artifact: IntegratedModelArtifact,
        path: Path,
        final_url: str,
        *,
        reused: bool,
    ) -> InstalledModel:
        request_document = json.dumps(
            artifact.public_metadata,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return InstalledModel(
            path=path,
            receipt=ModelInstallReceipt(
                model_id=artifact.model_id,
                repository_id=artifact.repository_id,
                revision=artifact.revision,
                filename=artifact.filename,
                size=artifact.size,
                sha256=artifact.sha256,
                license_spdx=artifact.license_spdx,
                request_sha256=hashlib.sha256(request_document).hexdigest(),
                final_host=urlsplit(final_url).hostname or "unknown",
                installed_at=self._clock().astimezone(UTC),
                reused_verified_file=reused,
            ),
        )

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
