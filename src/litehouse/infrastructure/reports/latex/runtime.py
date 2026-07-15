from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import zipfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from litehouse.domain import canonical_json
from litehouse.infrastructure.fetch.policy import DestinationPolicy, DestinationPolicyError
from litehouse.infrastructure.fetch.resolver import ResolutionError, SystemResolver
from litehouse.infrastructure.models.downloader import (
    ArtifactStream,
    HttpxArtifactTransport,
    ModelDownloadError,
)

from .renderer import _ASSET_DIR, _PREAMBLE

TECTONIC_VERSION = "0.16.9"
TECTONIC_RELEASE_TAG = "tectonic@0.16.9"
TECTONIC_BUNDLE_URL = "https://relay.fullyjustified.net/default_bundle_v33.tar"
TECTONIC_BUNDLE_DIGEST = "6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c"
TECTONIC_BUNDLE_INDEX_SHA256 = (
    "0fb434b0fa5fdebea7f767ed9c31939c99a780d6f95cd3f540aae55910bb5697"
)

_MAX_BINARY_BYTES = 100 * 1024 * 1024
_ALLOWED_DOWNLOAD_HOSTS = frozenset(
    {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
)
_PROBE_SOURCE = (
    _PREAMBLE
    + r"""
\begin{document}
\includegraphics[width=37mm]{litehouse-wordmark.pdf}
\section*{Litehouse compiler verification}
\begin{longtable}{L{0.28\textwidth}L{0.62\textwidth}}
\toprule
Runtime & Offline, untrusted Tectonic compilation \\
\bottomrule
\end{longtable}
\href{https://example.org}{\nolinkurl{https://example.org}}
{\small $x+y$}\quad
{\footnotesize $x+y$}\quad
{\scriptsize $x+y$ \texttt{0123456789abcdef}}\quad
{\tiny $x+y$}
\end{document}
"""
)


class TectonicRuntimeError(RuntimeError):
    pass


class TectonicConfirmationRequiredError(TectonicRuntimeError):
    pass


class TectonicPlatformUnsupportedError(TectonicRuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class _Artifact:
    platform_id: str
    archive_target: str
    archive_name: str
    archive_sha256: str
    archive_size: int
    executable_name: str
    emulated: bool = False

    @property
    def url(self) -> str:
        encoded_tag = TECTONIC_RELEASE_TAG.replace("@", "%40")
        return (
            "https://github.com/tectonic-typesetting/tectonic/releases/download/"
            f"{encoded_tag}/{self.archive_name}"
        )


_ARTIFACTS = {
    ("Darwin", "arm64"): _Artifact(
        "darwin-aarch64",
        "aarch64-apple-darwin",
        "tectonic-0.16.9-aarch64-apple-darwin.tar.gz",
        "edb67c61aba768289f6da441c9e6f523cfaff4f8b2a5708523ef29c543f8e88e",
        20_590_132,
        "tectonic",
    ),
    ("Darwin", "x86_64"): _Artifact(
        "darwin-x86_64",
        "x86_64-apple-darwin",
        "tectonic-0.16.9-x86_64-apple-darwin.tar.gz",
        "79d8839fa3594bfea9b2bf2ac0a0455bcc4d0de956a5e5c403107e9a72f79e86",
        20_572_838,
        "tectonic",
    ),
    ("Linux", "aarch64"): _Artifact(
        "linux-aarch64",
        "aarch64-unknown-linux-musl",
        "tectonic-0.16.9-aarch64-unknown-linux-musl.tar.gz",
        "f9aa39017dbd51f111fdb93dda222178cbe51c8193508fc567b523cc74fff9c1",
        9_923_433,
        "tectonic",
    ),
    ("Linux", "x86_64"): _Artifact(
        "linux-x86_64",
        "x86_64-unknown-linux-musl",
        "tectonic-0.16.9-x86_64-unknown-linux-musl.tar.gz",
        "60b13a0826ae7ad9ce34b4a2df06bff2cfcfa6dda8a915477c0cbb84e1a4a902",
        10_146_030,
        "tectonic",
    ),
    ("Windows", "AMD64"): _Artifact(
        "windows-x86_64",
        "x86_64-pc-windows-msvc",
        "tectonic-0.16.9-x86_64-pc-windows-msvc.zip",
        "131a24604785a9600989a3d91225f597df52ac06f00aeffe86fd529f99ee5cdd",
        20_035_039,
        "tectonic.exe",
    ),
    ("Windows", "ARM64"): _Artifact(
        "windows-aarch64",
        "x86_64-pc-windows-msvc",
        "tectonic-0.16.9-x86_64-pc-windows-msvc.zip",
        "131a24604785a9600989a3d91225f597df52ac06f00aeffe86fd529f99ee5cdd",
        20_035_039,
        "tectonic.exe",
        emulated=True,
    ),
}


@dataclass(frozen=True, slots=True)
class TectonicRuntimeStatus:
    installed: bool
    ready: bool
    version: str
    platform_id: str | None
    emulated: bool
    source_url: str | None
    archive_sha256: str | None
    binary_sha256: str | None
    bundle_url: str
    bundle_digest: str
    bundle_index_sha256: str
    reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_for_host() -> _Artifact:
    system = platform.system()
    machine = platform.machine()
    normalized = {
        ("Darwin", "aarch64"): ("Darwin", "arm64"),
        ("Linux", "arm64"): ("Linux", "aarch64"),
        ("Windows", "x86_64"): ("Windows", "AMD64"),
        ("Windows", "arm64"): ("Windows", "ARM64"),
    }.get((system, machine), (system, machine))
    try:
        return _ARTIFACTS[normalized]
    except KeyError as error:
        raise TectonicPlatformUnsupportedError(
            f"Tectonic {TECTONIC_VERSION} is not published for this platform."
        ) from error


def _runtime_dir(data_dir: Path, artifact: _Artifact) -> Path:
    return data_dir.resolve() / "runtimes" / "tectonic" / TECTONIC_VERSION / artifact.platform_id


def _runtime_environment(cache_dir: Path, temporary_dir: Path) -> dict[str, str]:
    environment = {
        "TECTONIC_CACHE_DIR": str(cache_dir),
        "TECTONIC_UNTRUSTED_MODE": "1",
        "SOURCE_DATE_EPOCH": "0",
        "TZ": "UTC",
        "TMPDIR": str(temporary_dir),
        "TEMP": str(temporary_dir),
        "TMP": str(temporary_dir),
    }
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    return environment


def _safe_download_url(url: str) -> bool:
    parsed = urlsplit(url)
    return (
        parsed.scheme == "https"
        and parsed.hostname in _ALLOWED_DOWNLOAD_HOSTS
        and parsed.username is None
        and parsed.password is None
        and not parsed.fragment
    )


async def _resolved_addresses(url: str, resolver: SystemResolver) -> tuple[str, ...]:
    hostname = urlsplit(url).hostname or ""
    try:
        return DestinationPolicy.validate_addresses(await resolver.resolve(hostname, 443))
    except (DestinationPolicyError, ResolutionError) as error:
        raise TectonicRuntimeError("The compiler download destination was rejected.") from error


async def _download_async(artifact: _Artifact, destination: Path) -> None:
    current_url = artifact.url
    resolver = SystemResolver()
    transport = HttpxArtifactTransport(timeout_seconds=60.0)
    stream: ArtifactStream | None = None
    try:
        for redirect_count in range(5):
            if not _safe_download_url(current_url):
                raise TectonicRuntimeError(
                    "The compiler download redirected to an untrusted host."
                )
            resolved = await _resolved_addresses(current_url, resolver)
            stream = await transport.open(current_url, resolved_addresses=resolved)
            try:
                peer = DestinationPolicy.validate_address(stream.peer_ip)
            except DestinationPolicyError as error:
                raise TectonicRuntimeError(
                    "The compiler download peer was rejected."
                ) from error
            if peer not in resolved:
                raise TectonicRuntimeError(
                    "The compiler download peer did not match its pinned DNS answers."
                )
            if stream.status_code in {301, 302, 303, 307, 308}:
                location = stream.headers.get("location")
                await stream.aclose()
                stream = None
                if redirect_count == 4 or not location:
                    raise TectonicRuntimeError(
                        "The compiler download redirect was malformed."
                    )
                current_url = urljoin(current_url, location)
                continue
            if stream.status_code != 200:
                raise TectonicRuntimeError("The compiler download was unavailable.")
            content_length = stream.headers.get("content-length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except (TypeError, ValueError) as error:
                    raise TectonicRuntimeError(
                        "The compiler archive length header was malformed."
                    ) from error
                if declared_length != artifact.archive_size:
                    raise TectonicRuntimeError(
                        "The compiler archive size did not match provenance."
                    )
            written = 0
            digest = hashlib.sha256()
            with destination.open("xb") as handle:
                async for chunk in stream.iter_bytes():
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > artifact.archive_size:
                        raise TectonicRuntimeError(
                            "The compiler archive exceeded its pinned size."
                        )
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if written != artifact.archive_size:
                raise TectonicRuntimeError("The compiler archive was incomplete.")
            if digest.hexdigest() != artifact.archive_sha256:
                raise TectonicRuntimeError(
                    "The compiler archive failed SHA-256 verification."
                )
            return
        raise TectonicRuntimeError("The compiler download exceeded the redirect limit.")
    except ModelDownloadError as error:
        raise TectonicRuntimeError("The compiler download failed in transit.") from error
    finally:
        if stream is not None:
            await stream.aclose()


def _download(artifact: _Artifact, destination: Path) -> None:
    asyncio.run(_download_async(artifact, destination))


def _extract_binary(archive: Path, artifact: _Artifact, destination: Path) -> str:
    if artifact.archive_name.endswith(".zip"):
        with zipfile.ZipFile(archive) as package:
            zip_entries = package.infolist()
            if len(zip_entries) != 1 or zip_entries[0].filename != artifact.executable_name:
                raise TectonicRuntimeError("The compiler ZIP layout was not the pinned layout.")
            if zip_entries[0].file_size > _MAX_BINARY_BYTES or zip_entries[0].is_dir():
                raise TectonicRuntimeError("The compiler executable size was invalid.")
            zip_source = package.open(zip_entries[0])
            with zip_source, destination.open("xb") as target:
                shutil.copyfileobj(zip_source, target, length=1024 * 1024)
    else:
        with tarfile.open(archive, mode="r:gz") as package:
            tar_entries = package.getmembers()
            if (
                len(tar_entries) != 1
                or tar_entries[0].name != artifact.executable_name
                or not tar_entries[0].isfile()
                or tar_entries[0].size > _MAX_BINARY_BYTES
            ):
                raise TectonicRuntimeError("The compiler tar layout was not the pinned layout.")
            tar_source = package.extractfile(tar_entries[0])
            if tar_source is None:
                raise TectonicRuntimeError("The compiler executable was missing.")
            with tar_source, destination.open("xb") as target:
                shutil.copyfileobj(tar_source, target, length=1024 * 1024)
    destination.chmod(0o700)
    return _sha256_file(destination)


def _sanitized_process_error(output: str, root: Path) -> str:
    cleaned = output.replace(str(root), "<runtime-dir>").replace(str(Path.home()), "<home>")
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    return ("\n".join(lines[-10:]) or "Tectonic stopped without a diagnostic line.")[:1600]


def _run_tectonic(
    binary: Path,
    cache_dir: Path,
    probe_dir: Path,
    *,
    only_cached: bool,
) -> None:
    arguments = [
        str(binary),
        "-X",
        "compile",
        "--bundle",
        TECTONIC_BUNDLE_URL,
        "--untrusted",
    ]
    if only_cached:
        arguments.append("--only-cached")
    arguments.extend(
        ["--keep-logs", "--reruns", "1", "--outdir", str(probe_dir), "report.tex"]
    )
    completed = subprocess.run(  # noqa: S603
        arguments,
        cwd=probe_dir,
        env=_runtime_environment(cache_dir, probe_dir),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0 or not (probe_dir / "report.pdf").is_file():
        raise TectonicRuntimeError(
            _sanitized_process_error(completed.stdout + "\n" + completed.stderr, probe_dir)
        )


def _verify_bundle_cache(cache_dir: Path) -> None:
    hashes_dir = cache_dir / "bundles" / "hashes"
    matches = [
        item
        for item in hashes_dir.iterdir()
        if item.is_file()
        and item.read_text(encoding="ascii").strip() == TECTONIC_BUNDLE_DIGEST
    ]
    if len(matches) != 1:
        raise TectonicRuntimeError("The Tectonic bundle digest was not the pinned digest.")
    index = cache_dir / "bundles" / "data" / f"{TECTONIC_BUNDLE_DIGEST}.index"
    if not index.is_file() or _sha256_file(index) != TECTONIC_BUNDLE_INDEX_SHA256:
        raise TectonicRuntimeError("The Tectonic bundle index failed SHA-256 verification.")


def _prime_runtime(binary: Path, cache_dir: Path, root: Path) -> None:
    probe_dir = root / "probe"
    fonts_dir = probe_dir / "fonts"
    fonts_dir.mkdir(parents=True)
    for name in (
        "EBGaramond-Variable.ttf",
        "EBGaramond-Italic-Variable.ttf",
        "litehouse-wordmark.pdf",
    ):
        destination = probe_dir / name if name.endswith(".pdf") else fonts_dir / name
        shutil.copyfile(_ASSET_DIR / name, destination)
    (probe_dir / "report.tex").write_text(_PROBE_SOURCE, encoding="utf-8", newline="\n")
    _run_tectonic(binary, cache_dir, probe_dir, only_cached=False)
    _verify_bundle_cache(cache_dir)
    (probe_dir / "report.pdf").unlink(missing_ok=True)
    _run_tectonic(binary, cache_dir, probe_dir, only_cached=True)
    shutil.rmtree(probe_dir)


def _manifest_payload(artifact: _Artifact, binary_sha256: str) -> dict[str, object]:
    return {
        "archive_name": artifact.archive_name,
        "archive_sha256": artifact.archive_sha256,
        "archive_size": artifact.archive_size,
        "archive_target": artifact.archive_target,
        "binary_sha256": binary_sha256,
        "bundle_digest": TECTONIC_BUNDLE_DIGEST,
        "bundle_index_sha256": TECTONIC_BUNDLE_INDEX_SHA256,
        "bundle_url": TECTONIC_BUNDLE_URL,
        "emulated": artifact.emulated,
        "installed_at": datetime.now(UTC).isoformat(),
        "platform_id": artifact.platform_id,
        "release_tag": TECTONIC_RELEASE_TAG,
        "schema_version": 1,
        "source_url": artifact.url,
        "version": TECTONIC_VERSION,
    }


def _read_valid_manifest(root: Path, artifact: _Artifact) -> tuple[dict[str, object], Path]:
    manifest_path = root / "install.json"
    binary = root / "bin" / artifact.executable_name
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TectonicRuntimeError("The installed compiler provenance is unavailable.") from error
    if not isinstance(payload, dict):
        raise TectonicRuntimeError("The installed compiler provenance is malformed.")
    expected = {
        "archive_name": artifact.archive_name,
        "archive_sha256": artifact.archive_sha256,
        "archive_size": artifact.archive_size,
        "archive_target": artifact.archive_target,
        "bundle_digest": TECTONIC_BUNDLE_DIGEST,
        "bundle_index_sha256": TECTONIC_BUNDLE_INDEX_SHA256,
        "bundle_url": TECTONIC_BUNDLE_URL,
        "emulated": artifact.emulated,
        "platform_id": artifact.platform_id,
        "release_tag": TECTONIC_RELEASE_TAG,
        "schema_version": 1,
        "source_url": artifact.url,
        "version": TECTONIC_VERSION,
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        raise TectonicRuntimeError("The installed compiler provenance does not match the pinset.")
    binary_sha256 = payload.get("binary_sha256")
    if (
        not isinstance(binary_sha256, str)
        or len(binary_sha256) != 64
        or not binary.is_file()
        or _sha256_file(binary) != binary_sha256
    ):
        raise TectonicRuntimeError("The installed compiler executable failed verification.")
    _verify_bundle_cache(root / "cache")
    return payload, binary


def tectonic_runtime_status(data_dir: Path) -> TectonicRuntimeStatus:
    try:
        artifact = _artifact_for_host()
    except TectonicPlatformUnsupportedError as error:
        return TectonicRuntimeStatus(
            False,
            False,
            TECTONIC_VERSION,
            None,
            False,
            None,
            None,
            None,
            TECTONIC_BUNDLE_URL,
            TECTONIC_BUNDLE_DIGEST,
            TECTONIC_BUNDLE_INDEX_SHA256,
            str(error),
        )
    root = _runtime_dir(data_dir, artifact)
    if not root.is_dir():
        return TectonicRuntimeStatus(
            False,
            False,
            TECTONIC_VERSION,
            artifact.platform_id,
            artifact.emulated,
            artifact.url,
            artifact.archive_sha256,
            None,
            TECTONIC_BUNDLE_URL,
            TECTONIC_BUNDLE_DIGEST,
            TECTONIC_BUNDLE_INDEX_SHA256,
            "The verified compiler runtime has not been installed.",
        )
    try:
        payload, binary = _read_valid_manifest(root, artifact)
        with tempfile.TemporaryDirectory(prefix=".litehouse-tectonic-check-", dir=root) as temp:
            completed = subprocess.run(  # noqa: S603
                [str(binary), "--version"],
                cwd=root,
                env=_runtime_environment(root / "cache", Path(temp)),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        if completed.returncode != 0 or completed.stdout.strip() != f"Tectonic {TECTONIC_VERSION}":
            raise TectonicRuntimeError("The installed compiler version check failed.")
        return TectonicRuntimeStatus(
            True,
            True,
            TECTONIC_VERSION,
            artifact.platform_id,
            artifact.emulated,
            artifact.url,
            artifact.archive_sha256,
            str(payload["binary_sha256"]),
            TECTONIC_BUNDLE_URL,
            TECTONIC_BUNDLE_DIGEST,
            TECTONIC_BUNDLE_INDEX_SHA256,
        )
    except (OSError, subprocess.SubprocessError, TectonicRuntimeError):
        return TectonicRuntimeStatus(
            True,
            False,
            TECTONIC_VERSION,
            artifact.platform_id,
            artifact.emulated,
            artifact.url,
            artifact.archive_sha256,
            None,
            TECTONIC_BUNDLE_URL,
            TECTONIC_BUNDLE_DIGEST,
            TECTONIC_BUNDLE_INDEX_SHA256,
            "The installed compiler runtime failed integrity verification.",
        )


def install_tectonic_runtime(data_dir: Path, *, confirmed: bool) -> TectonicRuntimeStatus:
    if confirmed is not True:
        raise TectonicConfirmationRequiredError(
            "Installing Tectonic requires explicit user confirmation."
        )
    artifact = _artifact_for_host()
    destination = _runtime_dir(data_dir, artifact)
    base = destination.parent
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = base / f".{artifact.platform_id}.install-lock"
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError as error:
        raise TectonicRuntimeError("A compiler installation is already in progress.") from error
    staging = base / f".{artifact.platform_id}.staging-{uuid.uuid4().hex}"
    backup = base / f".{artifact.platform_id}.previous-{uuid.uuid4().hex}"
    try:
        current = tectonic_runtime_status(data_dir)
        if current.ready:
            return current
        staging.mkdir(mode=0o700)
        archive = staging / artifact.archive_name
        _download(artifact, archive)
        binary_dir = staging / "bin"
        binary_dir.mkdir(mode=0o700)
        binary = binary_dir / artifact.executable_name
        binary_sha256 = _extract_binary(archive, artifact, binary)
        archive.unlink()
        cache = staging / "cache"
        cache.mkdir(mode=0o700)
        _prime_runtime(binary, cache, staging)
        manifest = staging / "install.json"
        manifest.write_text(
            canonical_json(_manifest_payload(artifact, binary_sha256)) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        manifest.chmod(0o600)
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(staging, destination)
        except OSError:
            if backup.exists() and not destination.exists():
                os.replace(backup, destination)
            raise
        shutil.rmtree(backup, ignore_errors=True)
        installed = tectonic_runtime_status(data_dir)
        if not installed.ready:
            raise TectonicRuntimeError("The installed compiler failed final verification.")
        return installed
    except (
        OSError,
        subprocess.SubprocessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        raise TectonicRuntimeError(
            "The verified compiler runtime could not be installed."
        ) from error
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(backup, ignore_errors=True)
        lock.rmdir()


def resolve_tectonic_runtime(data_dir: Path) -> tuple[Path, Path]:
    artifact = _artifact_for_host()
    root = _runtime_dir(data_dir, artifact)
    status = tectonic_runtime_status(data_dir)
    if not status.ready:
        raise TectonicRuntimeError(status.reason or "The verified compiler runtime is unavailable.")
    return root / "bin" / artifact.executable_name, root / "cache"
