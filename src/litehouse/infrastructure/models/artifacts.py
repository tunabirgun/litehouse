from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from urllib.parse import quote, urlsplit

from litehouse.infrastructure.models.catalog import RecommendationTier

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")


class ArtifactPublisher(StrEnum):
    QWEN = "Qwen"
    GGML_ORG = "ggml-org"


@dataclass(frozen=True, slots=True)
class IntegratedModelArtifact:
    tier: RecommendationTier
    model_id: str
    repository_id: str
    revision: str
    filename: str
    size: int
    sha256: str
    license_spdx: str
    publisher: ArtifactPublisher

    def __post_init__(self) -> None:
        if not self.model_id.strip() or not self.repository_id.strip():
            raise ValueError("Integrated model identifiers cannot be empty.")
        if not _REVISION.fullmatch(self.revision):
            raise ValueError("Integrated model revision must be an exact Git commit.")
        if not _SHA256.fullmatch(self.sha256):
            raise ValueError("Integrated model SHA-256 must be exact lowercase hexadecimal.")
        path = PurePosixPath(self.filename)
        if path.name != self.filename or self.filename in {"", ".", ".."}:
            raise ValueError("Integrated model filename must be a plain filename.")
        if self.size < 1:
            raise ValueError("Integrated model size must be positive.")
        if self.license_spdx != "Apache-2.0":
            raise ValueError("The integrated default catalog is restricted to Apache-2.0 models.")

    @property
    def source_url(self) -> str:
        repository = "/".join(quote(part, safe="") for part in self.repository_id.split("/"))
        filename = quote(self.filename, safe="")
        return f"https://huggingface.co/{repository}/resolve/{self.revision}/{filename}"

    @property
    def public_metadata(self) -> dict[str, str | int]:
        return {
            "tier": self.tier.value,
            "model_id": self.model_id,
            "repository_id": self.repository_id,
            "revision": self.revision,
            "filename": self.filename,
            "size": self.size,
            "sha256": self.sha256,
            "license_spdx": self.license_spdx,
            "publisher": self.publisher.value,
            "source_url": self.source_url,
        }


INTEGRATED_QWEN3_ARTIFACTS = (
    IntegratedModelArtifact(
        tier=RecommendationTier.MINIMUM,
        model_id="Qwen3-1.7B",
        repository_id="ggml-org/Qwen3-1.7B-GGUF",
        revision="daeb8e2d528a760970442092f6bf1e55c3b659eb",
        filename="Qwen3-1.7B-Q4_K_M.gguf",
        size=1_282_439_264,
        sha256="d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5",
        license_spdx="Apache-2.0",
        publisher=ArtifactPublisher.GGML_ORG,
    ),
    IntegratedModelArtifact(
        tier=RecommendationTier.BALANCED,
        model_id="Qwen3-4B",
        repository_id="Qwen/Qwen3-4B-GGUF",
        revision="bc640142c66e1fdd12af0bd68f40445458f3869b",
        filename="Qwen3-4B-Q4_K_M.gguf",
        size=2_497_280_256,
        sha256="7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        license_spdx="Apache-2.0",
        publisher=ArtifactPublisher.QWEN,
    ),
    IntegratedModelArtifact(
        tier=RecommendationTier.QUALITY,
        model_id="Qwen3-8B",
        repository_id="Qwen/Qwen3-8B-GGUF",
        revision="7c41481f57cb95916b40956ab2f0b139b296d974",
        filename="Qwen3-8B-Q4_K_M.gguf",
        size=5_027_783_488,
        sha256="d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        license_spdx="Apache-2.0",
        publisher=ArtifactPublisher.QWEN,
    ),
)


def integrated_artifact_for_tier(tier: RecommendationTier) -> IntegratedModelArtifact:
    return next(artifact for artifact in INTEGRATED_QWEN3_ARTIFACTS if artifact.tier is tier)


def is_allowed_artifact_host(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname is None:
        return False
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        return False
    hostname = parsed.hostname.casefold().rstrip(".")
    return hostname == "huggingface.co" or hostname.endswith(".hf.co")
