from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from litehouse.config import Settings
from litehouse.infrastructure.models import (
    INTEGRATED_QWEN3_ARTIFACTS,
    UnsupportedRuntimePlatformError,
    recommend_model_tiers,
    runtime_artifact_for_profile,
)
from litehouse.infrastructure.system import CapabilityProfile, probe_capabilities


class _ResponseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CapabilityResponse(_ResponseModel):
    operating_system: str
    architecture: str
    logical_cpu_count: int = Field(ge=1)
    total_ram_bytes: int = Field(ge=1)
    available_ram_bytes: int = Field(ge=0)
    disk_free_bytes: int = Field(ge=0)
    memory_architecture: str
    accelerator: str
    available_backends: tuple[str, ...]
    estimated_safe_model_bytes: int = Field(ge=0)

    @classmethod
    def from_profile(cls, profile: CapabilityProfile) -> CapabilityResponse:
        return cls(
            operating_system=profile.operating_system.value,
            architecture=profile.architecture,
            logical_cpu_count=profile.logical_cpu_count,
            total_ram_bytes=profile.total_ram_bytes,
            available_ram_bytes=profile.available_ram_bytes,
            disk_free_bytes=profile.disk_free_bytes,
            memory_architecture=profile.memory_architecture.value,
            accelerator=profile.accelerator.value,
            available_backends=tuple(value.value for value in profile.available_backends),
            estimated_safe_model_bytes=profile.estimated_safe_model_bytes,
        )


class ModelArtifactResponse(_ResponseModel):
    repository_id: str
    revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    filename: str
    size: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    license_spdx: str
    publisher: str
    source_url: str


class ModelRecommendationResponse(_ResponseModel):
    tier: str
    model_id: str
    quantization: str
    estimated_working_set_bytes: int = Field(ge=1)
    context_tokens: int = Field(ge=1)
    backend: str
    reasons: tuple[str, ...]
    exceeds_safe_budget: bool
    artifact: ModelArtifactResponse | None


class RuntimeArtifactResponse(_ResponseModel):
    supported: bool
    release_tag: str | None = None
    commit: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    filename: str | None = None
    size: int | None = Field(default=None, ge=1)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    license_spdx: str | None = None
    available_backends: tuple[str, ...] = ()
    source_url: str | None = None


class SystemRecommendationResponse(_ResponseModel):
    capability: CapabilityResponse
    recommendations: tuple[ModelRecommendationResponse, ...] = Field(min_length=3, max_length=3)
    runtime: RuntimeArtifactResponse
    download_requires_confirmation: bool = True
    integrity_algorithm: str = "sha256"


def _existing_probe_path(path: Path) -> Path:
    candidate = path.expanduser().absolute()
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def _response(profile: CapabilityProfile) -> SystemRecommendationResponse:
    artifacts = {artifact.model_id: artifact for artifact in INTEGRATED_QWEN3_ARTIFACTS}
    recommendations = []
    for recommendation in recommend_model_tiers(profile):
        artifact = artifacts.get(recommendation.model_id)
        recommendations.append(
            ModelRecommendationResponse(
                tier=recommendation.tier.value,
                model_id=recommendation.model_id,
                quantization=recommendation.quantization,
                estimated_working_set_bytes=recommendation.estimated_working_set_bytes,
                context_tokens=recommendation.context_tokens,
                backend=recommendation.backend.value,
                reasons=recommendation.reasons,
                exceeds_safe_budget=recommendation.exceeds_safe_budget,
                artifact=(
                    ModelArtifactResponse(
                        repository_id=artifact.repository_id,
                        revision=artifact.revision,
                        filename=artifact.filename,
                        size=artifact.size,
                        sha256=artifact.sha256,
                        license_spdx=artifact.license_spdx,
                        publisher=artifact.publisher.value,
                        source_url=artifact.source_url,
                    )
                    if artifact is not None
                    else None
                ),
            )
        )
    try:
        runtime = runtime_artifact_for_profile(profile)
    except UnsupportedRuntimePlatformError:
        runtime_response = RuntimeArtifactResponse(supported=False)
    else:
        runtime_response = RuntimeArtifactResponse(
            supported=True,
            release_tag=runtime.release_tag,
            commit=runtime.commit,
            filename=runtime.filename,
            size=runtime.size,
            sha256=runtime.sha256,
            license_spdx=runtime.license_spdx,
            available_backends=tuple(value.value for value in runtime.available_backends),
            source_url=runtime.source_url,
        )
    return SystemRecommendationResponse(
        capability=CapabilityResponse.from_profile(profile),
        recommendations=tuple(recommendations),
        runtime=runtime_response,
    )


def system_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/v1", tags=["system"])

    @router.get("/system/recommendations", response_model=SystemRecommendationResponse)
    async def system_recommendations() -> SystemRecommendationResponse:
        try:
            profile = await asyncio.to_thread(
                probe_capabilities,
                _existing_probe_path(settings.vault_path),
            )
            return _response(profile)
        except (OSError, RuntimeError):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="System capabilities could not be measured safely.",
            ) from None

    return router
