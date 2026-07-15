from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import stat
import tarfile
import tempfile
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import BinaryIO, cast
from urllib.parse import urljoin, urlsplit

from litehouse.domain.entities import canonical_json
from litehouse.infrastructure.fetch.policy import DestinationPolicy, DestinationPolicyError
from litehouse.infrastructure.fetch.resolver import ResolutionError, Resolver, SystemResolver
from litehouse.infrastructure.models.downloader import (
    ArtifactStream,
    ArtifactTransport,
    HttpxArtifactTransport,
    ModelDownloadError,
)
from litehouse.infrastructure.models.runtime_artifacts import (
    LlamaRuntimeArtifact,
    RuntimeArchiveFormat,
    is_allowed_runtime_url,
)

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ACCEPTED_MIME_TYPES = frozenset(
    {
        "application/gzip",
        "application/octet-stream",
        "application/x-gzip",
        "application/zip",
        "binary/octet-stream",
    }
)
_MAX_REDIRECTS = 3
_DISK_RESERVE_BYTES = 1024**3
_MANIFEST_FILENAME = ".litehouse-runtime.json"
_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_COPY_CHUNK_BYTES = 1024 * 1024


class RuntimeInstallError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class RuntimeDownloadCancelled(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class RuntimeInstallApproval:
    artifact_sha256: str

    @classmethod
    def for_artifact(cls, artifact: LlamaRuntimeArtifact) -> RuntimeInstallApproval:
        return cls(artifact.sha256)

    def approves(self, artifact: LlamaRuntimeArtifact) -> bool:
        return self.artifact_sha256 == artifact.sha256


@dataclass(frozen=True, slots=True)
class RuntimeDownloadProgress:
    downloaded_bytes: int
    total_bytes: int


@dataclass(frozen=True, slots=True)
class RuntimeInstallReceipt:
    release_tag: str
    commit: str
    archive_filename: str
    archive_size: int
    archive_sha256: str
    license_spdx: str
    server_relative_path: str
    server_sha256: str
    extracted_size: int
    extracted_file_count: int
    extracted_tree_sha256: str
    installation_sha256: str
    request_sha256: str
    final_host: str
    installed_at: datetime
    reused_verified_install: bool


@dataclass(frozen=True, slots=True)
class InstalledLlamaRuntime:
    root: Path
    server_path: Path
    artifact: LlamaRuntimeArtifact
    receipt: RuntimeInstallReceipt


@dataclass(frozen=True, slots=True)
class _ExtractedFile:
    path: str
    size: int
    sha256: str
    executable: bool

    @property
    def document(self) -> dict[str, object]:
        return {
            "path": self.path,
            "size": self.size,
            "sha256": self.sha256,
            "executable": self.executable,
        }


@dataclass(frozen=True, slots=True)
class _VerifiedManifest:
    files: tuple[_ExtractedFile, ...]
    extracted_size: int
    tree_sha256: str
    installation_sha256: str
    final_host: str


class VerifiedLlamaRuntimeInstaller:
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
        artifact: LlamaRuntimeArtifact,
        *,
        approval: RuntimeInstallApproval | None = None,
        progress: Callable[[RuntimeDownloadProgress], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> InstalledLlamaRuntime:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = self.root / artifact.sha256
        if destination.exists():
            if not destination.is_dir() or destination.is_symlink():
                raise RuntimeInstallError(
                    "runtime_install_corrupt",
                    "The existing llama.cpp runtime installation is invalid.",
                    retryable=False,
                )
            verified = await asyncio.to_thread(self._verify_install, destination, artifact)
            return self._installed(artifact, destination, verified, reused=True)
        if approval is None or not approval.approves(artifact):
            raise RuntimeInstallError(
                "runtime_download_confirmation_required",
                "The verified llama.cpp runtime download requires user confirmation.",
                retryable=False,
            )

        required_disk = artifact.size + artifact.max_extracted_bytes + _DISK_RESERVE_BYTES
        if shutil.disk_usage(self.root).free < required_disk:
            raise RuntimeInstallError(
                "runtime_insufficient_disk_space",
                "There is not enough free disk space to install llama.cpp safely.",
                retryable=False,
            )

        archive_path: Path | None = None
        temporary_install: Path | None = None
        try:
            archive_path, final_host = await self._download(
                artifact,
                progress=progress,
                cancelled=cancelled,
            )
            extracted_path, verified = await asyncio.to_thread(
                self._extract_verified_archive,
                archive_path,
                artifact,
                final_host,
            )
            temporary_install = extracted_path
            if destination.exists():
                raise RuntimeInstallError(
                    "runtime_install_conflict",
                    "The llama.cpp runtime destination changed during installation.",
                    retryable=False,
                )
            os.replace(extracted_path, destination)
            temporary_install = None
            self._fsync_directory(self.root)
            return self._installed(artifact, destination, verified, reused=False)
        except ModelDownloadError as error:
            raise RuntimeInstallError(
                "runtime_download_failed",
                "The verified llama.cpp runtime download failed.",
                retryable=error.retryable,
            ) from None
        finally:
            if archive_path is not None:
                archive_path.unlink(missing_ok=True)
            if temporary_install is not None:
                shutil.rmtree(temporary_install, ignore_errors=True)

    async def _download(
        self,
        artifact: LlamaRuntimeArtifact,
        *,
        progress: Callable[[RuntimeDownloadProgress], None] | None,
        cancelled: Callable[[], bool] | None,
    ) -> tuple[Path, str]:
        current_url = artifact.source_url
        stream: ArtifactStream | None = None
        for redirect_count in range(_MAX_REDIRECTS + 1):
            resolved = await self._resolve(current_url)
            try:
                stream = await self._transport.open(current_url, resolved_addresses=resolved)
            except ModelDownloadError:
                raise
            try:
                peer = DestinationPolicy.validate_address(stream.peer_ip)
            except DestinationPolicyError:
                await stream.aclose()
                raise RuntimeInstallError(
                    "runtime_peer_rejected",
                    "The llama.cpp release connection address was rejected.",
                    retryable=True,
                ) from None
            if peer not in resolved:
                await stream.aclose()
                raise RuntimeInstallError(
                    "runtime_peer_mismatch",
                    "The llama.cpp release connection did not match its DNS answers.",
                    retryable=True,
                )
            if stream.status_code in _REDIRECT_STATUSES:
                location = stream.headers.get("location")
                await stream.aclose()
                stream = None
                if redirect_count >= _MAX_REDIRECTS or not location:
                    raise RuntimeInstallError(
                        "runtime_redirect_rejected",
                        "The llama.cpp release returned an invalid redirect chain.",
                        retryable=False,
                    )
                candidate = urljoin(current_url, location)
                if not is_allowed_runtime_url(candidate):
                    raise RuntimeInstallError(
                        "runtime_redirect_rejected",
                        "The llama.cpp release redirected outside the trusted hosts.",
                        retryable=False,
                    )
                current_url = candidate
                continue
            break
        if stream is None:
            raise RuntimeInstallError(
                "runtime_download_unavailable",
                "The llama.cpp release returned no downloadable archive.",
                retryable=True,
            )

        temporary_path: Path | None = None
        try:
            self._validate_headers(stream.status_code, stream.headers, artifact)
            descriptor, temporary_name = tempfile.mkstemp(
                dir=self.root,
                prefix=f".{artifact.sha256}.archive-",
            )
            temporary_path = Path(temporary_name)
            os.fchmod(descriptor, 0o600)
            digest = hashlib.sha256()
            size = 0
            with os.fdopen(descriptor, "wb") as output:
                async for chunk in stream.iter_bytes():
                    if cancelled and cancelled():
                        raise RuntimeDownloadCancelled(
                            "The llama.cpp runtime download was cancelled."
                        )
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > artifact.size:
                        raise RuntimeInstallError(
                            "runtime_archive_size_mismatch",
                            "The llama.cpp archive exceeded its pinned size.",
                            retryable=False,
                        )
                    digest.update(chunk)
                    output.write(chunk)
                    if progress:
                        progress(RuntimeDownloadProgress(size, artifact.size))
                output.flush()
                os.fsync(output.fileno())
            if size != artifact.size or digest.hexdigest() != artifact.sha256:
                raise RuntimeInstallError(
                    "runtime_archive_integrity_mismatch",
                    "The llama.cpp archive failed pinned size or SHA-256 verification.",
                    retryable=False,
                )
            completed = temporary_path
            temporary_path = None
            return completed, urlsplit(current_url).hostname or "unknown"
        finally:
            await stream.aclose()
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    async def _resolve(self, url: str) -> tuple[str, ...]:
        if not is_allowed_runtime_url(url):
            raise RuntimeInstallError(
                "runtime_destination_rejected",
                "The llama.cpp runtime destination is not trusted.",
                retryable=False,
            )
        hostname = urlsplit(url).hostname or ""
        try:
            answers = await self._resolver.resolve(hostname, 443)
            return DestinationPolicy.validate_addresses(answers)
        except DestinationPolicyError:
            raise RuntimeInstallError(
                "runtime_destination_rejected",
                "The llama.cpp runtime destination was rejected.",
                retryable=False,
            ) from None
        except ResolutionError:
            raise RuntimeInstallError(
                "runtime_resolution_error",
                "The llama.cpp release host could not be resolved.",
                retryable=True,
            ) from None

    @staticmethod
    def _validate_headers(
        status_code: int,
        headers: Mapping[str, str],
        artifact: LlamaRuntimeArtifact,
    ) -> None:
        if not 200 <= status_code < 300:
            raise RuntimeInstallError(
                "runtime_http_error",
                "The llama.cpp release returned an unsuccessful response.",
                retryable=status_code == 429 or status_code >= 500,
            )
        content_type = headers.get("content-type", "").partition(";")[0].strip().casefold()
        if content_type not in _ACCEPTED_MIME_TYPES:
            raise RuntimeInstallError(
                "runtime_mime_rejected",
                "The llama.cpp release returned an unexpected content type.",
                retryable=False,
            )
        if headers.get("content-encoding", "").strip().casefold() not in {"", "identity"}:
            raise RuntimeInstallError(
                "runtime_encoding_rejected",
                "The llama.cpp release returned encoded archive bytes.",
                retryable=False,
            )
        if headers.get("transfer-encoding", "").strip():
            raise RuntimeInstallError(
                "runtime_transfer_encoding_rejected",
                "The llama.cpp release did not provide fixed archive bytes.",
                retryable=False,
            )
        content_length = headers.get("content-length", "")
        if not content_length.isdecimal() or int(content_length) != artifact.size:
            raise RuntimeInstallError(
                "runtime_archive_size_mismatch",
                "The llama.cpp release response did not match the pinned archive size.",
                retryable=False,
            )

    def _extract_verified_archive(
        self,
        archive_path: Path,
        artifact: LlamaRuntimeArtifact,
        final_host: str,
    ) -> tuple[Path, _VerifiedManifest]:
        temporary_root = Path(tempfile.mkdtemp(dir=self.root, prefix=".runtime-extract-"))
        os.chmod(temporary_root, 0o700)
        try:
            if artifact.archive_format is RuntimeArchiveFormat.TAR_GZ:
                files = self._extract_tar(archive_path, temporary_root, artifact)
            else:
                files = self._extract_zip(archive_path, temporary_root, artifact)
            verified = self._create_manifest(temporary_root, artifact, files, final_host)
            self._write_manifest(temporary_root, artifact, verified)
            self._validate_server(temporary_root, artifact, verified)
            self._fsync_tree(temporary_root)
            return temporary_root, verified
        except RuntimeInstallError:
            shutil.rmtree(temporary_root, ignore_errors=True)
            raise
        except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError):
            shutil.rmtree(temporary_root, ignore_errors=True)
            raise RuntimeInstallError(
                "runtime_archive_rejected",
                "The llama.cpp release archive could not be extracted safely.",
                retryable=False,
            ) from None

    def _extract_tar(
        self,
        archive_path: Path,
        destination: Path,
        artifact: LlamaRuntimeArtifact,
    ) -> tuple[_ExtractedFile, ...]:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members: list[tarfile.TarInfo] = []
            for member in archive:
                members.append(member)
                if len(members) > artifact.max_archive_members:
                    raise self._archive_limit_error()
            paths = self._validate_member_paths(
                tuple(member.name for member in members), artifact
            )
            member_by_path = dict(zip(paths, members, strict=True))
            planned_sizes: list[int] = []
            for path, member in member_by_path.items():
                if member.isdir():
                    planned_sizes.append(0)
                elif member.isfile():
                    planned_sizes.append(member.size)
                elif member.issym():
                    target = self._resolve_tar_symlink(path, member, member_by_path)
                    planned_sizes.append(target.size)
                elif member.islnk():
                    raise RuntimeInstallError(
                        "runtime_archive_link_rejected",
                        "The llama.cpp archive contained a hard link.",
                        retryable=False,
                    )
                else:
                    raise RuntimeInstallError(
                        "runtime_archive_member_rejected",
                        "The llama.cpp archive contained an unsupported member type.",
                        retryable=False,
                    )
            self._validate_extracted_size(sum(planned_sizes), artifact)

            extracted: list[_ExtractedFile] = []
            for path, member in member_by_path.items():
                if member.isdir():
                    self._directory(destination, path)
                    continue
                source_member = (
                    self._resolve_tar_symlink(path, member, member_by_path)
                    if member.issym()
                    else member
                )
                source = archive.extractfile(source_member)
                if source is None:
                    raise RuntimeInstallError(
                        "runtime_archive_member_rejected",
                        "The llama.cpp archive member could not be read safely.",
                        retryable=False,
                    )
                expected_size = source_member.size
                executable = path.as_posix() == artifact.server_relative_path
                with source:
                    extracted.append(
                        self._write_member(
                            destination,
                            path,
                            cast(BinaryIO, source),
                            expected_size,
                            executable=executable,
                        )
                    )
            return tuple(sorted(extracted, key=lambda item: item.path))

    def _extract_zip(
        self,
        archive_path: Path,
        destination: Path,
        artifact: LlamaRuntimeArtifact,
    ) -> tuple[_ExtractedFile, ...]:
        with zipfile.ZipFile(archive_path, mode="r") as archive:
            members = archive.infolist()
            if len(members) > artifact.max_archive_members:
                raise self._archive_limit_error()
            paths = self._validate_member_paths(
                tuple(member.filename for member in members), artifact
            )
            total_size = 0
            for member in members:
                unix_mode = (member.external_attr >> 16) & 0xFFFF
                if member.flag_bits & 0x1:
                    raise RuntimeInstallError(
                        "runtime_archive_member_rejected",
                        "The llama.cpp archive contained an encrypted member.",
                        retryable=False,
                    )
                if stat.S_ISLNK(unix_mode):
                    raise RuntimeInstallError(
                        "runtime_archive_link_rejected",
                        "The llama.cpp archive contained a symbolic link.",
                        retryable=False,
                    )
                if member.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise RuntimeInstallError(
                        "runtime_archive_compression_rejected",
                        "The llama.cpp archive used an unsupported compression method.",
                        retryable=False,
                    )
                if not member.is_dir():
                    if unix_mode and not stat.S_ISREG(unix_mode):
                        raise RuntimeInstallError(
                            "runtime_archive_member_rejected",
                            "The llama.cpp archive contained an unsupported member type.",
                            retryable=False,
                        )
                    total_size += member.file_size
            self._validate_extracted_size(total_size, artifact)

            extracted: list[_ExtractedFile] = []
            for path, member in zip(paths, members, strict=True):
                if member.is_dir():
                    self._directory(destination, path)
                    continue
                executable = path.as_posix() == artifact.server_relative_path
                with archive.open(member, mode="r") as source:
                    extracted.append(
                        self._write_member(
                            destination,
                            path,
                            cast(BinaryIO, source),
                            member.file_size,
                            executable=executable,
                        )
                    )
            return tuple(sorted(extracted, key=lambda item: item.path))

    @staticmethod
    def _validate_member_paths(
        names: tuple[str, ...],
        artifact: LlamaRuntimeArtifact,
    ) -> tuple[PurePosixPath, ...]:
        paths: list[PurePosixPath] = []
        casefolded: set[str] = set()
        for name in names:
            raw = name[:-1] if name.endswith("/") else name
            if (
                not raw
                or raw == _MANIFEST_FILENAME
                or len(raw.encode("utf-8")) > 1024
                or "\\" in raw
                or any(ord(character) < 0x20 or ord(character) == 0x7F for character in raw)
            ):
                raise RuntimeInstallError(
                    "runtime_archive_path_rejected",
                    "The llama.cpp archive contained an unsafe member path.",
                    retryable=False,
                )
            path = PurePosixPath(raw)
            if (
                path.is_absolute()
                or path.as_posix() != raw
                or ".." in path.parts
                or any(":" in part for part in path.parts)
            ):
                raise RuntimeInstallError(
                    "runtime_archive_path_rejected",
                    "The llama.cpp archive contained an unsafe member path.",
                    retryable=False,
                )
            folded = path.as_posix().casefold()
            if folded in casefolded:
                raise RuntimeInstallError(
                    "runtime_archive_path_rejected",
                    "The llama.cpp archive contained duplicate member paths.",
                    retryable=False,
                )
            casefolded.add(folded)
            paths.append(path)
        if artifact.server_relative_path.casefold() not in casefolded:
            raise RuntimeInstallError(
                "runtime_server_missing",
                "The pinned llama.cpp server binary was missing from the archive.",
                retryable=False,
            )
        return tuple(paths)

    def _resolve_tar_symlink(
        self,
        link_path: PurePosixPath,
        member: tarfile.TarInfo,
        members: Mapping[PurePosixPath, tarfile.TarInfo],
    ) -> tarfile.TarInfo:
        seen: set[PurePosixPath] = set()
        current_path = link_path
        current = member
        while current.issym():
            if current_path in seen or len(seen) > 16:
                raise RuntimeInstallError(
                    "runtime_archive_link_rejected",
                    "The llama.cpp archive contained a cyclic symbolic link.",
                    retryable=False,
                )
            seen.add(current_path)
            linkname = current.linkname
            if (
                not linkname
                or "\\" in linkname
                or PurePosixPath(linkname).is_absolute()
                or ".." in PurePosixPath(linkname).parts
            ):
                raise RuntimeInstallError(
                    "runtime_archive_link_rejected",
                    "The llama.cpp archive contained an unsafe symbolic link.",
                    retryable=False,
                )
            target_path = current_path.parent / PurePosixPath(linkname)
            if target_path not in members:
                raise RuntimeInstallError(
                    "runtime_archive_link_rejected",
                    "The llama.cpp archive symbolic link target was missing.",
                    retryable=False,
                )
            current_path = target_path
            current = members[target_path]
        if not current.isfile():
            raise RuntimeInstallError(
                "runtime_archive_link_rejected",
                "The llama.cpp archive symbolic link target was not a regular file.",
                retryable=False,
            )
        return current

    @staticmethod
    def _directory(root: Path, path: PurePosixPath) -> None:
        destination = root.joinpath(*path.parts)
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(destination, 0o700)

    def _write_member(
        self,
        root: Path,
        path: PurePosixPath,
        source: BinaryIO,
        expected_size: int,
        *,
        executable: bool,
    ) -> _ExtractedFile:
        destination = root.joinpath(*path.parts)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(destination, flags, 0o600)
        digest = hashlib.sha256()
        size = 0
        try:
            with os.fdopen(descriptor, "wb") as output:
                while chunk := source.read(_COPY_CHUNK_BYTES):
                    size += len(chunk)
                    if size > expected_size:
                        raise RuntimeInstallError(
                            "runtime_archive_size_mismatch",
                            "A llama.cpp archive member exceeded its declared size.",
                            retryable=False,
                        )
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        if size != expected_size:
            destination.unlink(missing_ok=True)
            raise RuntimeInstallError(
                "runtime_archive_size_mismatch",
                "A llama.cpp archive member did not match its declared size.",
                retryable=False,
            )
        mode = 0o700 if executable else 0o600
        os.chmod(destination, mode)
        return _ExtractedFile(path.as_posix(), size, digest.hexdigest(), executable)

    @staticmethod
    def _validate_extracted_size(size: int, artifact: LlamaRuntimeArtifact) -> None:
        if size < 1 or size > artifact.max_extracted_bytes:
            raise VerifiedLlamaRuntimeInstaller._archive_limit_error()

    @staticmethod
    def _archive_limit_error() -> RuntimeInstallError:
        return RuntimeInstallError(
            "runtime_archive_limit_exceeded",
            "The llama.cpp archive exceeded the safe extraction limits.",
            retryable=False,
        )

    def _create_manifest(
        self,
        root: Path,
        artifact: LlamaRuntimeArtifact,
        files: tuple[_ExtractedFile, ...],
        final_host: str,
    ) -> _VerifiedManifest:
        if final_host not in {
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
        }:
            raise RuntimeInstallError(
                "runtime_destination_rejected",
                "The llama.cpp archive final host was not trusted.",
                retryable=False,
            )
        documents = [item.document for item in files]
        tree_sha256 = hashlib.sha256(canonical_json(documents).encode("utf-8")).hexdigest()
        extracted_size = sum(item.size for item in files)
        payload = self._manifest_payload(
            artifact,
            files,
            extracted_size,
            tree_sha256,
            final_host,
        )
        installation_sha256 = hashlib.sha256(
            canonical_json(payload).encode("utf-8")
        ).hexdigest()
        return _VerifiedManifest(
            files=files,
            extracted_size=extracted_size,
            tree_sha256=tree_sha256,
            installation_sha256=installation_sha256,
            final_host=final_host,
        )

    @staticmethod
    def _manifest_payload(
        artifact: LlamaRuntimeArtifact,
        files: tuple[_ExtractedFile, ...],
        extracted_size: int,
        tree_sha256: str,
        final_host: str,
    ) -> dict[str, object]:
        return {
            "schema_version": 1,
            "artifact": artifact.public_metadata,
            "files": [item.document for item in files],
            "extracted_size": extracted_size,
            "extracted_file_count": len(files),
            "extracted_tree_sha256": tree_sha256,
            "final_host": final_host,
        }

    def _write_manifest(
        self,
        root: Path,
        artifact: LlamaRuntimeArtifact,
        verified: _VerifiedManifest,
    ) -> None:
        payload = self._manifest_payload(
            artifact,
            verified.files,
            verified.extracted_size,
            verified.tree_sha256,
            verified.final_host,
        )
        document = {**payload, "installation_sha256": verified.installation_sha256}
        encoded = canonical_json(document).encode("utf-8")
        if len(encoded) > _MAX_MANIFEST_BYTES:
            raise self._archive_limit_error()
        path = root / _MANIFEST_FILENAME
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())

    def _verify_install(
        self,
        root: Path,
        artifact: LlamaRuntimeArtifact,
    ) -> _VerifiedManifest:
        manifest_path = root / _MANIFEST_FILENAME
        if (
            not manifest_path.is_file()
            or manifest_path.is_symlink()
            or manifest_path.stat().st_size > _MAX_MANIFEST_BYTES
        ):
            raise RuntimeInstallError(
                "runtime_install_corrupt",
                "The existing llama.cpp runtime manifest is invalid.",
                retryable=False,
            )
        try:
            raw: object = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise RuntimeInstallError(
                "runtime_install_corrupt",
                "The existing llama.cpp runtime manifest is invalid.",
                retryable=False,
            ) from None
        if not isinstance(raw, dict):
            raise RuntimeInstallError(
                "runtime_install_corrupt",
                "The existing llama.cpp runtime manifest is invalid.",
                retryable=False,
            )
        document = cast(dict[str, object], raw)
        expected_fields = {
            "schema_version",
            "artifact",
            "files",
            "extracted_size",
            "extracted_file_count",
            "extracted_tree_sha256",
            "final_host",
            "installation_sha256",
        }
        if set(document) != expected_fields or document.get("artifact") != artifact.public_metadata:
            raise self._corrupt_install_error()
        raw_files = document.get("files")
        if not isinstance(raw_files, list) or not raw_files:
            raise self._corrupt_install_error()
        files: list[_ExtractedFile] = []
        for raw_file in raw_files:
            if not isinstance(raw_file, dict) or set(raw_file) != {
                "path",
                "size",
                "sha256",
                "executable",
            }:
                raise self._corrupt_install_error()
            path = raw_file["path"]
            size = raw_file["size"]
            sha256 = raw_file["sha256"]
            executable = raw_file["executable"]
            if (
                not isinstance(path, str)
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(sha256, str)
                or len(sha256) != 64
                or not isinstance(executable, bool)
            ):
                raise self._corrupt_install_error()
            files.append(_ExtractedFile(path, size, sha256, executable))
        files_tuple = tuple(files)
        paths = self._validate_member_paths(tuple(item.path for item in files_tuple), artifact)
        if tuple(path.as_posix() for path in paths) != tuple(item.path for item in files_tuple):
            raise self._corrupt_install_error()
        if tuple(sorted(files_tuple, key=lambda item: item.path)) != files_tuple:
            raise self._corrupt_install_error()

        actual_paths: set[str] = set()
        for current_root, directories, filenames in os.walk(root, followlinks=False):
            current = Path(current_root)
            for name in directories:
                if (current / name).is_symlink():
                    raise self._corrupt_install_error()
            for name in filenames:
                path = current / name
                if path.is_symlink() or not path.is_file():
                    raise self._corrupt_install_error()
                relative = path.relative_to(root).as_posix()
                if relative != _MANIFEST_FILENAME:
                    actual_paths.add(relative)
        if actual_paths != {item.path for item in files_tuple}:
            raise self._corrupt_install_error()

        for item in files_tuple:
            path = root.joinpath(*PurePosixPath(item.path).parts)
            if path.stat().st_size != item.size or self._file_sha256(path) != item.sha256:
                raise self._corrupt_install_error()
        documents = [item.document for item in files_tuple]
        tree_sha256 = hashlib.sha256(canonical_json(documents).encode("utf-8")).hexdigest()
        extracted_size = sum(item.size for item in files_tuple)
        final_host = document.get("final_host")
        if not isinstance(final_host, str) or final_host not in {
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
        }:
            raise self._corrupt_install_error()
        payload = self._manifest_payload(
            artifact,
            files_tuple,
            extracted_size,
            tree_sha256,
            final_host,
        )
        installation_sha256 = hashlib.sha256(
            canonical_json(payload).encode("utf-8")
        ).hexdigest()
        if (
            document.get("schema_version") != 1
            or document.get("extracted_size") != extracted_size
            or document.get("extracted_file_count") != len(files_tuple)
            or document.get("extracted_tree_sha256") != tree_sha256
            or document.get("installation_sha256") != installation_sha256
        ):
            raise self._corrupt_install_error()
        verified = _VerifiedManifest(
            files=files_tuple,
            extracted_size=extracted_size,
            tree_sha256=tree_sha256,
            installation_sha256=installation_sha256,
            final_host=final_host,
        )
        self._validate_server(root, artifact, verified)
        return verified

    @staticmethod
    def _validate_server(
        root: Path,
        artifact: LlamaRuntimeArtifact,
        verified: _VerifiedManifest,
    ) -> None:
        server_path = root.joinpath(*PurePosixPath(artifact.server_relative_path).parts)
        server_entry = next(
            (item for item in verified.files if item.path == artifact.server_relative_path),
            None,
        )
        if (
            server_entry is None
            or not server_entry.executable
            or not server_path.is_file()
            or server_path.is_symlink()
            or server_path.stat().st_size != server_entry.size
        ):
            raise RuntimeInstallError(
                "runtime_server_invalid",
                "The pinned llama.cpp server binary was invalid.",
                retryable=False,
            )
        if os.name != "nt" and not os.access(server_path, os.X_OK):
            raise RuntimeInstallError(
                "runtime_server_invalid",
                "The pinned llama.cpp server binary was not executable.",
                retryable=False,
            )

    def _installed(
        self,
        artifact: LlamaRuntimeArtifact,
        root: Path,
        verified: _VerifiedManifest,
        *,
        reused: bool,
    ) -> InstalledLlamaRuntime:
        server_path = root.joinpath(*PurePosixPath(artifact.server_relative_path).parts)
        server_entry = next(
            item for item in verified.files if item.path == artifact.server_relative_path
        )
        request_sha256 = hashlib.sha256(
            canonical_json(artifact.public_metadata).encode("utf-8")
        ).hexdigest()
        return InstalledLlamaRuntime(
            root=root,
            server_path=server_path,
            artifact=artifact,
            receipt=RuntimeInstallReceipt(
                release_tag=artifact.release_tag,
                commit=artifact.commit,
                archive_filename=artifact.filename,
                archive_size=artifact.size,
                archive_sha256=artifact.sha256,
                license_spdx=artifact.license_spdx,
                server_relative_path=artifact.server_relative_path,
                server_sha256=server_entry.sha256,
                extracted_size=verified.extracted_size,
                extracted_file_count=len(verified.files),
                extracted_tree_sha256=verified.tree_sha256,
                installation_sha256=verified.installation_sha256,
                request_sha256=request_sha256,
                final_host=verified.final_host,
                installed_at=self._clock().astimezone(UTC),
                reused_verified_install=reused,
            ),
        )

    @staticmethod
    def _corrupt_install_error() -> RuntimeInstallError:
        return RuntimeInstallError(
            "runtime_install_corrupt",
            "The existing llama.cpp runtime installation failed verification.",
            retryable=False,
        )

    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(_COPY_CHUNK_BYTES):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _fsync_tree(root: Path) -> None:
        directories = [Path(current) for current, _, _ in os.walk(root)]
        for directory in reversed(directories):
            VerifiedLlamaRuntimeInstaller._fsync_directory(directory)

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
