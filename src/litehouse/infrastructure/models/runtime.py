from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import socket
import tempfile
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urlsplit

import httpcore
import httpx

from litehouse.infrastructure.models.catalog import ModelRecommendation
from litehouse.infrastructure.models.downloader import InstalledModel
from litehouse.infrastructure.models.endpoints import (
    EndpointKind,
    EndpointProtocol,
    ModelEndpointConfig,
    SecretReference,
)
from litehouse.infrastructure.models.runtime_artifacts import (
    LlamaRuntimeArtifact,
    normalize_runtime_architecture,
)
from litehouse.infrastructure.models.runtime_installer import InstalledLlamaRuntime
from litehouse.infrastructure.system import (
    GIB,
    CapabilityProfile,
    InferenceBackend,
)

_LOOPBACK_HOST = "127.0.0.1"
_HEALTH_RESPONSE_LIMIT = 64 * 1024
_HASH_CHUNK_BYTES = 1024 * 1024
_KV_BYTES_PER_TOKEN_BUDGET = 256 * 1024
_MINIMUM_CONTEXT_TOKENS = 2048


class RuntimeSupervisorError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class HealthProbeUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class RuntimeLaunchSettings:
    context_tokens: int
    generation_threads: int
    batch_threads: int
    http_threads: int
    parallel_slots: int
    backend: InferenceBackend
    gpu_layers: str

    def __post_init__(self) -> None:
        if self.context_tokens < _MINIMUM_CONTEXT_TOKENS:
            raise ValueError("llama.cpp context is below the safe minimum")
        if min(
            self.generation_threads,
            self.batch_threads,
            self.http_threads,
            self.parallel_slots,
        ) < 1:
            raise ValueError("llama.cpp thread and slot settings must be positive")
        if self.parallel_slots != 1:
            raise ValueError("the integrated alpha runtime is restricted to one parallel slot")
        if self.gpu_layers not in {"0", "all"}:
            raise ValueError("llama.cpp GPU layers must be either zero or all")
        if self.backend is InferenceBackend.LLAMA_METAL and self.gpu_layers != "all":
            raise ValueError("the Metal backend requires full model offload")
        if self.backend is not InferenceBackend.LLAMA_METAL and self.gpu_layers != "0":
            raise ValueError("the CPU runtime cannot request GPU layers")


def launch_settings_for(
    profile: CapabilityProfile,
    recommendation: ModelRecommendation,
    artifact: LlamaRuntimeArtifact,
) -> RuntimeLaunchSettings:
    if recommendation.exceeds_safe_budget:
        raise RuntimeSupervisorError(
            "runtime_memory_budget_exceeded",
            "The selected local model exceeds the current safe memory budget.",
            retryable=False,
        )
    operating_reserve = max(2 * GIB, profile.total_ram_bytes // 5)
    headroom = (
        profile.available_ram_bytes
        - recommendation.estimated_working_set_bytes
        - operating_reserve
    )
    maximum_context = (max(0, headroom) // _KV_BYTES_PER_TOKEN_BUDGET) // 512 * 512
    context_tokens = min(recommendation.context_tokens, maximum_context)
    if context_tokens < _MINIMUM_CONTEXT_TOKENS:
        raise RuntimeSupervisorError(
            "runtime_memory_budget_exceeded",
            "Available memory is insufficient for the minimum local inference context.",
            retryable=True,
        )
    generation_threads = max(1, profile.logical_cpu_count - 3)
    http_threads = min(2, generation_threads)
    backend = recommendation.backend
    if backend not in artifact.available_backends:
        backend = InferenceBackend.LLAMA_CPU
    if backend not in {InferenceBackend.LLAMA_CPU, InferenceBackend.LLAMA_METAL}:
        backend = InferenceBackend.LLAMA_CPU
    return RuntimeLaunchSettings(
        context_tokens=context_tokens,
        generation_threads=generation_threads,
        batch_threads=generation_threads,
        http_threads=http_threads,
        parallel_slots=1,
        backend=backend,
        gpu_layers="all" if backend is InferenceBackend.LLAMA_METAL else "0",
    )


class ManagedProcess(Protocol):
    @property
    def returncode(self) -> int | None: ...

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


class ProcessLauncher(Protocol):
    async def launch(
        self,
        arguments: Sequence[str],
        *,
        cwd: Path,
        environment: Mapping[str, str],
    ) -> ManagedProcess: ...


class AsyncioProcessLauncher:
    async def launch(
        self,
        arguments: Sequence[str],
        *,
        cwd: Path,
        environment: Mapping[str, str],
    ) -> ManagedProcess:
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=str(cwd),
            env=dict(environment),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return cast(ManagedProcess, process)


@dataclass(frozen=True, slots=True)
class HealthResponse:
    status_code: int
    content_type: str
    body: bytes


class HealthProbe(Protocol):
    async def get(self, url: str) -> HealthResponse: ...


class LoopbackHealthProbe:
    def __init__(
        self,
        *,
        timeout_seconds: float = 2.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._timeout = httpx.Timeout(timeout_seconds)
        self._transport = transport

    async def get(self, url: str) -> HealthResponse:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            raise HealthProbeUnavailable("health destination was rejected") from None
        if (
            parsed.scheme != "http"
            or parsed.hostname != _LOOPBACK_HOST
            or parsed.username is not None
            or parsed.password is not None
            or port is None
            or not 1024 <= port <= 65535
            or parsed.path != "/health"
            or parsed.query
            or parsed.fragment
        ):
            raise HealthProbeUnavailable("health destination was rejected")
        try:
            async with httpx.AsyncClient(
                trust_env=False,
                follow_redirects=False,
                timeout=self._timeout,
                transport=self._transport,
                headers={"Accept": "application/json"},
            ) as client:
                async with client.stream("GET", url) as response:
                    content_length = response.headers.get("content-length")
                    if content_length is not None and (
                        not content_length.isdecimal()
                        or int(content_length) > _HEALTH_RESPONSE_LIMIT
                    ):
                        raise HealthProbeUnavailable("health response length was rejected")
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > _HEALTH_RESPONSE_LIMIT:
                            raise HealthProbeUnavailable("health response exceeded its limit")
                        chunks.append(chunk)
                    return HealthResponse(
                        status_code=response.status_code,
                        content_type=response.headers.get("content-type", ""),
                        body=b"".join(chunks),
                    )
        except HealthProbeUnavailable:
            raise
        except (httpcore.NetworkError, httpcore.ProtocolError, httpx.HTTPError):
            raise HealthProbeUnavailable("health endpoint was unavailable") from None


class LlamaServerHandle:
    def __init__(
        self,
        *,
        process: ManagedProcess,
        endpoint_config: ModelEndpointConfig,
        secret_reference: SecretReference,
        secret_value: str,
        session_root: Path,
        settings: RuntimeLaunchSettings,
        stop_timeout_seconds: float,
    ) -> None:
        self._process = process
        self.endpoint_config = endpoint_config
        self._secret_reference = secret_reference
        self._secret_value = secret_value
        self._session_root = session_root
        self.settings = settings
        self._stop_timeout_seconds = stop_timeout_seconds
        self._stopped = False

    @property
    def running(self) -> bool:
        return not self._stopped and self._process.returncode is None

    async def resolve(self, reference: SecretReference) -> str:
        if self._stopped or reference != self._secret_reference:
            raise RuntimeSupervisorError(
                "runtime_secret_unavailable",
                "The local runtime credential is unavailable.",
                retryable=False,
            )
        return self._secret_value

    def evidence_client(self):  # type: ignore[no-untyped-def]
        from litehouse.infrastructure.models.providers import EvidenceSynthesisClient

        return EvidenceSynthesisClient(self.endpoint_config, secret_resolver=self)

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        try:
            await _stop_process(self._process, self._stop_timeout_seconds)
        finally:
            self._secret_value = ""
            shutil.rmtree(self._session_root, ignore_errors=True)

    async def __aenter__(self) -> LlamaServerHandle:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.stop()


class LlamaServerSupervisor:
    def __init__(
        self,
        state_root: Path,
        *,
        launcher: ProcessLauncher | None = None,
        health_probe: HealthProbe | None = None,
        port_selector: Callable[[], int] | None = None,
        monotonic: Callable[[], float] | None = None,
        sleeper: Callable[[float], Awaitable[None]] | None = None,
        startup_timeout_seconds: float = 180.0,
        stop_timeout_seconds: float = 10.0,
    ) -> None:
        if not 1 <= startup_timeout_seconds <= 600:
            raise ValueError("llama.cpp startup timeout must be between 1 and 600 seconds")
        if not 1 <= stop_timeout_seconds <= 60:
            raise ValueError("llama.cpp stop timeout must be between 1 and 60 seconds")
        self.state_root = state_root.resolve()
        self._launcher = launcher or AsyncioProcessLauncher()
        self._health_probe = health_probe or LoopbackHealthProbe()
        self._port_selector = port_selector or _unused_loopback_port
        self._monotonic = monotonic or time.monotonic
        self._sleeper = sleeper or asyncio.sleep
        self._startup_timeout = startup_timeout_seconds
        self._stop_timeout = stop_timeout_seconds

    async def start(
        self,
        runtime: InstalledLlamaRuntime,
        model: InstalledModel,
        profile: CapabilityProfile,
        recommendation: ModelRecommendation,
    ) -> LlamaServerHandle:
        self._validate_platform(runtime.artifact, profile)
        settings = launch_settings_for(profile, recommendation, runtime.artifact)
        runtime_valid, model_valid = await asyncio.gather(
            asyncio.to_thread(
                _verified_regular_file,
                runtime.server_path,
                runtime.receipt.server_sha256,
                None,
                True,
            ),
            asyncio.to_thread(
                _verified_regular_file,
                model.path,
                model.receipt.sha256,
                model.receipt.size,
                False,
            ),
        )
        if not runtime_valid:
            raise RuntimeSupervisorError(
                "runtime_binary_invalid",
                "The installed llama.cpp server binary failed verification.",
                retryable=False,
            )
        if not model_valid:
            raise RuntimeSupervisorError(
                "runtime_model_invalid",
                "The selected local model failed SHA-256 verification.",
                retryable=False,
            )

        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        session_root = Path(
            tempfile.mkdtemp(dir=self.state_root, prefix=".llama-session-")
        )
        os.chmod(session_root, 0o700)
        secret_value = secrets.token_urlsafe(32)
        secret_reference = SecretReference(f"runtime.llama_cpp.{secrets.token_hex(8)}")
        key_path = session_root / "api-key"
        self._write_key_file(key_path, secret_value)
        port = self._port_selector()
        if not 1024 <= port <= 65535:
            shutil.rmtree(session_root, ignore_errors=True)
            raise RuntimeSupervisorError(
                "runtime_port_invalid",
                "The selected local runtime port was invalid.",
                retryable=True,
            )
        arguments = self._arguments(
            runtime,
            model,
            key_path,
            port,
            settings,
        )
        process: ManagedProcess | None = None
        try:
            process = await self._launcher.launch(
                arguments,
                cwd=runtime.server_path.parent,
                environment=_sanitized_environment(),
            )
            await self._wait_until_ready(process, port)
            endpoint = ModelEndpointConfig(
                kind=EndpointKind.LLAMA_CPP_LOCAL,
                protocol=EndpointProtocol.OPENAI_COMPATIBLE,
                base_url=f"http://{_LOOPBACK_HOST}:{port}/v1",
                model=model.receipt.model_id,
                display_name="Local llama.cpp",
                secret_ref=secret_reference,
            )
            return LlamaServerHandle(
                process=process,
                endpoint_config=endpoint,
                secret_reference=secret_reference,
                secret_value=secret_value,
                session_root=session_root,
                settings=settings,
                stop_timeout_seconds=self._stop_timeout,
            )
        except RuntimeSupervisorError:
            if process is not None:
                await _stop_process(process, self._stop_timeout)
            shutil.rmtree(session_root, ignore_errors=True)
            raise
        except (OSError, ValueError):
            if process is not None:
                await _stop_process(process, self._stop_timeout)
            shutil.rmtree(session_root, ignore_errors=True)
            raise RuntimeSupervisorError(
                "runtime_start_failed",
                "The local llama.cpp server could not be started.",
                retryable=True,
            ) from None
        except BaseException:
            if process is not None:
                await _stop_process(process, self._stop_timeout)
            shutil.rmtree(session_root, ignore_errors=True)
            raise

    async def _wait_until_ready(self, process: ManagedProcess, port: int) -> None:
        deadline = self._monotonic() + self._startup_timeout
        health_url = f"http://{_LOOPBACK_HOST}:{port}/health"
        while self._monotonic() < deadline:
            if process.returncode is not None:
                raise RuntimeSupervisorError(
                    "runtime_exited_early",
                    "The local llama.cpp server exited before it became ready.",
                    retryable=True,
                )
            try:
                response = await self._health_probe.get(health_url)
            except HealthProbeUnavailable:
                await self._sleeper(0.2)
                continue
            if response.status_code == 503:
                await self._sleeper(0.2)
                continue
            if response.status_code != 200 or not _health_is_ready(response):
                raise RuntimeSupervisorError(
                    "runtime_health_rejected",
                    "The local llama.cpp server returned an invalid health response.",
                    retryable=True,
                )
            return
        raise RuntimeSupervisorError(
            "runtime_start_timeout",
            "The local llama.cpp server did not become ready before the timeout.",
            retryable=True,
        )

    @staticmethod
    def _arguments(
        runtime: InstalledLlamaRuntime,
        model: InstalledModel,
        key_path: Path,
        port: int,
        settings: RuntimeLaunchSettings,
    ) -> tuple[str, ...]:
        return (
            str(runtime.server_path),
            "--model",
            str(model.path),
            "--alias",
            model.receipt.model_id,
            "--host",
            _LOOPBACK_HOST,
            "--port",
            str(port),
            "--ctx-size",
            str(settings.context_tokens),
            "--threads",
            str(settings.generation_threads),
            "--threads-batch",
            str(settings.batch_threads),
            "--threads-http",
            str(settings.http_threads),
            "--parallel",
            str(settings.parallel_slots),
            "--n-gpu-layers",
            settings.gpu_layers,
            "--flash-attn",
            "auto",
            "--jinja",
            "--reasoning",
            "off",
            "--no-mmproj",
            "--no-ui",
            "--no-ui-mcp-proxy",
            "--no-slots",
            "--api-key-file",
            str(key_path),
        )

    @staticmethod
    def _write_key_file(path: Path, secret_value: str) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(secret_value)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())

    @staticmethod
    def _validate_platform(
        artifact: LlamaRuntimeArtifact,
        profile: CapabilityProfile,
    ) -> None:
        try:
            architecture = normalize_runtime_architecture(profile.architecture)
        except ValueError:
            raise RuntimeSupervisorError(
                "runtime_platform_unsupported",
                "The installed llama.cpp runtime does not support this platform.",
                retryable=False,
            ) from None
        if (
            artifact.operating_system is not profile.operating_system
            or artifact.architecture != architecture
        ):
            raise RuntimeSupervisorError(
                "runtime_platform_mismatch",
                "The installed llama.cpp runtime does not match this platform.",
                retryable=False,
            )


def _health_is_ready(response: HealthResponse) -> bool:
    content_type = response.content_type.partition(";")[0].strip().casefold()
    if content_type != "application/json":
        return False
    try:
        document: object = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(document, dict) and document == {"status": "ok"}


def _unused_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind((_LOOPBACK_HOST, 0))
        port = candidate.getsockname()[1]
    if not isinstance(port, int):
        raise RuntimeSupervisorError(
            "runtime_port_unavailable",
            "A local inference port could not be selected.",
            retryable=True,
        )
    return port


def _sanitized_environment() -> dict[str, str]:
    allowed_names = (
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    )
    environment = {
        name: value
        for name in allowed_names
        if (value := os.environ.get(name))
        and len(value) <= 8192
        and not any(ord(character) < 0x20 for character in value)
    }
    environment["NO_PROXY"] = _LOOPBACK_HOST
    environment["no_proxy"] = _LOOPBACK_HOST
    return environment


def _verified_regular_file(
    path: Path,
    expected_sha256: str,
    expected_size: int | None,
    require_executable: bool,
) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    stat_result = path.stat()
    if expected_size is not None and stat_result.st_size != expected_size:
        return False
    if require_executable and os.name != "nt" and not os.access(path, os.X_OK):
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest() == expected_sha256


async def _stop_process(process: ManagedProcess, timeout_seconds: float) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
    except TimeoutError:
        process.kill()
        await process.wait()
