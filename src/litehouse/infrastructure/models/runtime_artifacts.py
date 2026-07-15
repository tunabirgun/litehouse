from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from urllib.parse import quote, urlsplit

from litehouse.infrastructure.system import (
    CapabilityProfile,
    InferenceBackend,
    OperatingSystem,
)

LLAMA_CPP_RELEASE_TAG = "b9637"
LLAMA_CPP_COMMIT = "aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3"
LLAMA_CPP_LICENSE_SPDX = "MIT"
RUNTIME_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
RUNTIME_MAX_ARCHIVE_MEMBERS = 512

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_ALLOWED_RUNTIME_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
)


class RuntimeArchiveFormat(StrEnum):
    TAR_GZ = "tar.gz"
    ZIP = "zip"


class UnsupportedRuntimePlatformError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class LlamaRuntimeArtifact:
    operating_system: OperatingSystem
    architecture: str
    archive_format: RuntimeArchiveFormat
    filename: str
    size: int
    sha256: str
    server_relative_path: str
    available_backends: tuple[InferenceBackend, ...]
    release_tag: str = LLAMA_CPP_RELEASE_TAG
    commit: str = LLAMA_CPP_COMMIT
    license_spdx: str = LLAMA_CPP_LICENSE_SPDX
    max_extracted_bytes: int = RUNTIME_MAX_EXTRACTED_BYTES
    max_archive_members: int = RUNTIME_MAX_ARCHIVE_MEMBERS

    def __post_init__(self) -> None:
        if self.release_tag != LLAMA_CPP_RELEASE_TAG or self.commit != LLAMA_CPP_COMMIT:
            raise ValueError("llama.cpp runtime must use the integrated exact release revision")
        if not _COMMIT.fullmatch(self.commit):
            raise ValueError("llama.cpp runtime commit must be exact")
        if not _SHA256.fullmatch(self.sha256):
            raise ValueError("llama.cpp runtime SHA-256 must be exact lowercase hexadecimal")
        filename = PurePosixPath(self.filename)
        if filename.name != self.filename or self.filename in {"", ".", ".."}:
            raise ValueError("llama.cpp archive filename must be a plain filename")
        if self.archive_format is RuntimeArchiveFormat.TAR_GZ:
            expected_suffix = ".tar.gz"
        else:
            expected_suffix = ".zip"
        if not self.filename.endswith(expected_suffix):
            raise ValueError("llama.cpp archive filename does not match its format")
        server_path = PurePosixPath(self.server_relative_path)
        if server_path.is_absolute() or ".." in server_path.parts or not server_path.parts:
            raise ValueError("llama.cpp server path must be a safe relative path")
        if self.size < 1 or self.max_extracted_bytes < 1 or self.max_archive_members < 1:
            raise ValueError("llama.cpp archive and extraction bounds must be positive")
        if not self.available_backends or InferenceBackend.LLAMA_CPU not in self.available_backends:
            raise ValueError("llama.cpp runtime archives must include the CPU backend")
        if self.license_spdx != LLAMA_CPP_LICENSE_SPDX:
            raise ValueError("llama.cpp runtime license metadata must be MIT")

    @property
    def source_url(self) -> str:
        filename = quote(self.filename, safe="")
        return (
            "https://github.com/ggml-org/llama.cpp/releases/download/"
            f"{self.release_tag}/{filename}"
        )

    @property
    def public_metadata(self) -> dict[str, object]:
        return {
            "operating_system": self.operating_system.value,
            "architecture": self.architecture,
            "archive_format": self.archive_format.value,
            "filename": self.filename,
            "size": self.size,
            "sha256": self.sha256,
            "server_relative_path": self.server_relative_path,
            "available_backends": [backend.value for backend in self.available_backends],
            "release_tag": self.release_tag,
            "commit": self.commit,
            "license_spdx": self.license_spdx,
            "max_extracted_bytes": self.max_extracted_bytes,
            "max_archive_members": self.max_archive_members,
            "source_url": self.source_url,
        }


LLAMA_CPP_RUNTIME_ARTIFACTS = (
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.MACOS,
        architecture="arm64",
        archive_format=RuntimeArchiveFormat.TAR_GZ,
        filename="llama-b9637-bin-macos-arm64.tar.gz",
        size=10_586_927,
        sha256="72a93f3e68c31de3e438d462669aad1fcdb423b995e9c41033cc7d27a9a3ac69",
        server_relative_path="llama-b9637/llama-server",
        available_backends=(InferenceBackend.LLAMA_CPU, InferenceBackend.LLAMA_METAL),
    ),
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.MACOS,
        architecture="x86_64",
        archive_format=RuntimeArchiveFormat.TAR_GZ,
        filename="llama-b9637-bin-macos-x64.tar.gz",
        size=10_877_158,
        sha256="71743f8db0958e7c266cceb7add7b16aa418a964667e471094aa6ae65b9c8298",
        server_relative_path="llama-b9637/llama-server",
        available_backends=(InferenceBackend.LLAMA_CPU,),
    ),
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.LINUX,
        architecture="arm64",
        archive_format=RuntimeArchiveFormat.TAR_GZ,
        filename="llama-b9637-bin-ubuntu-arm64.tar.gz",
        size=12_528_190,
        sha256="211d9e9ee738698beb7ca271be82661ae2b5da3fbb489cf7d9e4e6ed601be106",
        server_relative_path="llama-b9637/llama-server",
        available_backends=(InferenceBackend.LLAMA_CPU,),
    ),
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.LINUX,
        architecture="x86_64",
        archive_format=RuntimeArchiveFormat.TAR_GZ,
        filename="llama-b9637-bin-ubuntu-x64.tar.gz",
        size=15_512_345,
        sha256="a50ee14f021a9d8e92e30f622f7e3be1318ee1125bb9a9ba8d2025388df48743",
        server_relative_path="llama-b9637/llama-server",
        available_backends=(InferenceBackend.LLAMA_CPU,),
    ),
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.WINDOWS,
        architecture="arm64",
        archive_format=RuntimeArchiveFormat.ZIP,
        filename="llama-b9637-bin-win-cpu-arm64.zip",
        size=10_846_442,
        sha256="db1d3f4c13c08b693f539e100bf6d3a435148b0ffc186b044fdd65d490cc6df7",
        server_relative_path="llama-server.exe",
        available_backends=(InferenceBackend.LLAMA_CPU,),
    ),
    LlamaRuntimeArtifact(
        operating_system=OperatingSystem.WINDOWS,
        architecture="x86_64",
        archive_format=RuntimeArchiveFormat.ZIP,
        filename="llama-b9637-bin-win-cpu-x64.zip",
        size=16_906_751,
        sha256="f7783c2b8c007f95e710ac40f26a24861a80b603b0b739fc54d7c926a4716c1e",
        server_relative_path="llama-server.exe",
        available_backends=(InferenceBackend.LLAMA_CPU,),
    ),
)


def normalize_runtime_architecture(architecture: str) -> str:
    normalized = architecture.strip().casefold()
    aliases = {
        "aarch64": "arm64",
        "arm64": "arm64",
        "amd64": "x86_64",
        "x64": "x86_64",
        "x86_64": "x86_64",
    }
    try:
        return aliases[normalized]
    except KeyError as error:
        raise UnsupportedRuntimePlatformError(
            "No verified llama.cpp runtime is available for this architecture."
        ) from error


def runtime_artifact_for_platform(
    operating_system: OperatingSystem,
    architecture: str,
) -> LlamaRuntimeArtifact:
    normalized_architecture = normalize_runtime_architecture(architecture)
    for artifact in LLAMA_CPP_RUNTIME_ARTIFACTS:
        if (
            artifact.operating_system is operating_system
            and artifact.architecture == normalized_architecture
        ):
            return artifact
    raise UnsupportedRuntimePlatformError(
        "No verified llama.cpp runtime is available for this operating system and architecture."
    )


def runtime_artifact_for_profile(profile: CapabilityProfile) -> LlamaRuntimeArtifact:
    return runtime_artifact_for_platform(profile.operating_system, profile.architecture)


def is_allowed_runtime_url(url: str) -> bool:
    if len(url) > 8192 or url != url.strip():
        return False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.hostname is None or port not in (None, 443):
        return False
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        return False
    return parsed.hostname.casefold().rstrip(".") in _ALLOWED_RUNTIME_HOSTS
