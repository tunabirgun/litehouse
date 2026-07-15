from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import urlsplit

from litehouse.infrastructure.system import (
    GIB,
    AcceleratorKind,
    CapabilityProfile,
    InferenceBackend,
)


class RecommendationTier(StrEnum):
    MINIMUM = "minimum"
    BALANCED = "balanced"
    QUALITY = "quality"


@dataclass(frozen=True, slots=True)
class ModelVariant:
    model_id: str
    parameter_label: str
    quantization: str
    estimated_working_set_bytes: int
    default_context_tokens: int

    def __post_init__(self) -> None:
        if not self.model_id.strip():
            raise ValueError("model_id must not be empty")
        if self.estimated_working_set_bytes <= 0:
            raise ValueError("estimated_working_set_bytes must be positive")
        if self.default_context_tokens <= 0:
            raise ValueError("default_context_tokens must be positive")


@dataclass(frozen=True, slots=True)
class ModelFamilyManifest:
    family_id: str
    display_name: str
    license_spdx: str
    variants: tuple[ModelVariant, ...]

    def __post_init__(self) -> None:
        if not self.family_id.strip() or not self.display_name.strip():
            raise ValueError("model family identifiers must not be empty")
        if not self.license_spdx.strip():
            raise ValueError("license_spdx is required")
        if not self.variants:
            raise ValueError("at least one model variant is required")


@dataclass(frozen=True, slots=True)
class RemoteModelArtifact:
    source_url: str
    sha256: str | None
    license_spdx: str | None

    def validation_errors(self) -> tuple[str, ...]:
        errors: list[str] = []
        parsed = urlsplit(self.source_url)
        if parsed.scheme != "https" or parsed.hostname is None:
            errors.append("remote model source must use HTTPS")
        if parsed.username is not None or parsed.password is not None or parsed.query:
            errors.append("remote model source must not contain credentials or query data")
        if self.sha256 is None or re.fullmatch(r"[0-9a-fA-F]{64}", self.sha256) is None:
            errors.append("an exact SHA-256 digest is required")
        if self.license_spdx is None or not self.license_spdx.strip():
            errors.append("license metadata is required")
        return tuple(errors)

    @property
    def usable(self) -> bool:
        return not self.validation_errors()

    def require_usable(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ArtifactValidationError("; ".join(errors))


class ArtifactValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ModelOverride:
    model_id: str
    estimated_working_set_bytes: int
    context_tokens: int

    def __post_init__(self) -> None:
        if not self.model_id.strip():
            raise ValueError("model_id must not be empty")
        if self.estimated_working_set_bytes <= 0 or self.context_tokens <= 0:
            raise ValueError("override sizing values must be positive")


@dataclass(frozen=True, slots=True)
class ModelRecommendation:
    tier: RecommendationTier
    model_id: str
    quantization: str
    estimated_working_set_bytes: int
    context_tokens: int
    backend: InferenceBackend
    reasons: tuple[str, ...]
    user_override: bool = False
    exceeds_safe_budget: bool = False


class UnsafeModelOverrideError(ValueError):
    pass


DEFAULT_QWEN3_MANIFEST = ModelFamilyManifest(
    family_id="qwen3",
    display_name="Qwen3",
    license_spdx="Apache-2.0",
    variants=(
        ModelVariant("Qwen3-1.7B", "1.7B", "Q4_K_M", 3 * GIB // 2, 16384),
        ModelVariant("Qwen3-4B", "4B", "Q4_K_M", 3 * GIB, 16384),
        ModelVariant("Qwen3-8B", "8B", "Q4_K_M", 11 * GIB // 2, 16384),
    ),
)


def _preferred_backend(profile: CapabilityProfile) -> InferenceBackend:
    order = (
        InferenceBackend.LLAMA_METAL,
        InferenceBackend.LLAMA_CUDA,
        InferenceBackend.LLAMA_HIP,
        InferenceBackend.LLAMA_VULKAN,
        InferenceBackend.DIRECTML,
        InferenceBackend.LLAMA_CPU,
    )
    return next(backend for backend in order if backend in profile.available_backends)


def _largest_fitting(
    variants: tuple[ModelVariant, ...], budget: int, fallback: ModelVariant
) -> ModelVariant:
    fitting = [variant for variant in variants if variant.estimated_working_set_bytes <= budget]
    return fitting[-1] if fitting else fallback


def _reasons(
    *, profile: CapabilityProfile, variant: ModelVariant, backend: InferenceBackend
) -> tuple[str, ...]:
    reasons = [
        (
            f"Estimated {variant.estimated_working_set_bytes // (1024**2)} MiB working set "
            f"fits the {profile.estimated_safe_model_bytes // (1024**2)} MiB safe budget."
        ),
        f"llama.cpp can use the detected {backend.value} backend.",
        "Litehouse downloads only after confirmation and verifies the catalog SHA-256.",
    ]
    if profile.accelerator in {AcceleratorKind.NONE, AcceleratorKind.UNKNOWN}:
        reasons.append("No supported accelerator was detected, so CPU inference may be slow.")
    return tuple(reasons)


def recommend_model_tiers(
    profile: CapabilityProfile,
    *,
    manifest: ModelFamilyManifest = DEFAULT_QWEN3_MANIFEST,
    override: ModelOverride | None = None,
    allow_unsafe_override: bool = False,
) -> tuple[ModelRecommendation, ...]:
    variants = tuple(
        sorted(manifest.variants, key=lambda variant: variant.estimated_working_set_bytes)
    )
    smallest = variants[0]
    safe_budget = profile.estimated_safe_model_bytes
    backend = _preferred_backend(profile)
    tier_budgets = {
        RecommendationTier.MINIMUM: min(safe_budget, smallest.estimated_working_set_bytes),
        RecommendationTier.BALANCED: safe_budget * 45 // 100,
        RecommendationTier.QUALITY: safe_budget,
    }
    recommendations: list[ModelRecommendation] = []
    for tier in RecommendationTier:
        variant = _largest_fitting(variants, tier_budgets[tier], smallest)
        exceeds = variant.estimated_working_set_bytes > safe_budget
        reasons = _reasons(profile=profile, variant=variant, backend=backend)
        if exceeds:
            reasons += ("Even the smallest catalog model exceeds the current safe budget.",)
        recommendations.append(
            ModelRecommendation(
                tier=tier,
                model_id=variant.model_id,
                quantization=variant.quantization,
                estimated_working_set_bytes=variant.estimated_working_set_bytes,
                context_tokens=variant.default_context_tokens,
                backend=backend,
                reasons=reasons,
                exceeds_safe_budget=exceeds,
            )
        )

    if override is not None:
        exceeds = override.estimated_working_set_bytes > safe_budget
        if exceeds and not allow_unsafe_override:
            raise UnsafeModelOverrideError(
                "override exceeds the estimated safe model memory budget"
            )
        reasons = (
            "The user supplied this model override.",
            f"The selected backend is {backend.value}.",
            "Litehouse does not download or execute a user override during recommendation.",
        )
        if exceeds:
            reasons += ("Override exceeds the safe memory estimate and may cause swapping.",)
        recommendations[1] = ModelRecommendation(
            tier=RecommendationTier.BALANCED,
            model_id=override.model_id,
            quantization="user-specified",
            estimated_working_set_bytes=override.estimated_working_set_bytes,
            context_tokens=override.context_tokens,
            backend=backend,
            reasons=reasons,
            user_override=True,
            exceeds_safe_budget=exceeds,
        )
    return tuple(recommendations)
