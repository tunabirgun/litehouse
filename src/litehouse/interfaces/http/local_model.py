from __future__ import annotations

import hmac
from typing import Annotated, Self

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from litehouse.config import Settings
from litehouse.infrastructure.models.catalog import RecommendationTier
from litehouse.interfaces.http.local_model_service import (
    InstallApproval,
    InstallJobSnapshot,
    InstallSelection,
    LocalModelRuntimeService,
    LocalModelServiceError,
    ServerSnapshot,
)

Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
OpaqueJobId = Annotated[
    str,
    StringConstraints(
        min_length=24,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
]


class LocalModelContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ModelArtifactResponse(LocalModelContract):
    model_id: str
    repository_id: str
    revision: str
    filename: str
    size: int = Field(ge=1)
    sha256: Sha256
    license_spdx: str
    publisher: str


class RuntimeArtifactResponse(LocalModelContract):
    release_tag: str
    commit: str
    archive_filename: str
    archive_size: int = Field(ge=1)
    archive_sha256: Sha256
    license_spdx: str
    operating_system: str
    architecture: str
    available_backends: tuple[str, ...]


class RecommendationOptionResponse(LocalModelContract):
    tier: RecommendationTier
    system_recommended: bool
    installable: bool
    quantization: str
    estimated_working_set_bytes: int = Field(ge=1)
    context_tokens: int = Field(ge=1)
    preferred_backend: str
    reasons: tuple[str, ...]
    model: ModelArtifactResponse

    @classmethod
    def from_selection(cls, selection: InstallSelection) -> Self:
        recommendation = selection.recommendation
        artifact = selection.model_artifact
        return cls(
            tier=recommendation.tier,
            system_recommended=recommendation.tier is RecommendationTier.BALANCED,
            installable=not recommendation.exceeds_safe_budget,
            quantization=recommendation.quantization,
            estimated_working_set_bytes=recommendation.estimated_working_set_bytes,
            context_tokens=recommendation.context_tokens,
            preferred_backend=recommendation.backend.value,
            reasons=recommendation.reasons,
            model=ModelArtifactResponse(
                model_id=artifact.model_id,
                repository_id=artifact.repository_id,
                revision=artifact.revision,
                filename=artifact.filename,
                size=artifact.size,
                sha256=artifact.sha256,
                license_spdx=artifact.license_spdx,
                publisher=artifact.publisher.value,
            ),
        )


class SystemRecommendationResponse(LocalModelContract):
    selected_tier: RecommendationTier
    options: tuple[RecommendationOptionResponse, ...]
    runtime: RuntimeArtifactResponse

    @classmethod
    def from_service(cls, service: LocalModelRuntimeService) -> Self:
        selections = service.selections()
        system = service.system_selection()
        runtime = system.runtime_artifact
        return cls(
            selected_tier=system.recommendation.tier,
            options=tuple(
                RecommendationOptionResponse.from_selection(selection)
                for selection in selections
            ),
            runtime=RuntimeArtifactResponse(
                release_tag=runtime.release_tag,
                commit=runtime.commit,
                archive_filename=runtime.filename,
                archive_size=runtime.size,
                archive_sha256=runtime.sha256,
                license_spdx=runtime.license_spdx,
                operating_system=runtime.operating_system.value,
                architecture=runtime.architecture,
                available_backends=tuple(
                    backend.value for backend in runtime.available_backends
                ),
            ),
        )


class StartInstallRequest(LocalModelContract):
    tier: RecommendationTier
    approved_model_sha256: Sha256
    approved_runtime_sha256: Sha256


class ModelReceiptResponse(LocalModelContract):
    model_id: str
    repository_id: str
    revision: str
    filename: str
    size: int = Field(ge=1)
    sha256: Sha256
    license_spdx: str
    request_sha256: Sha256
    final_host: str
    installed_at: AwareDatetime
    reused_verified_file: bool


class RuntimeReceiptResponse(LocalModelContract):
    release_tag: str
    commit: str
    archive_filename: str
    archive_size: int = Field(ge=1)
    archive_sha256: Sha256
    license_spdx: str
    server_sha256: Sha256
    extracted_size: int = Field(ge=1)
    extracted_file_count: int = Field(ge=1)
    extracted_tree_sha256: Sha256
    installation_sha256: Sha256
    request_sha256: Sha256
    final_host: str
    installed_at: AwareDatetime
    reused_verified_install: bool


class InstallJobResponse(LocalModelContract):
    job_id: OpaqueJobId
    state: str
    tier: RecommendationTier
    model_sha256: Sha256
    runtime_sha256: Sha256
    downloaded_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=1)
    progress_fraction: float = Field(ge=0, le=1)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    error_code: str | None
    retryable: bool
    model_receipt: ModelReceiptResponse | None
    runtime_receipt: RuntimeReceiptResponse | None

    @classmethod
    def from_snapshot(cls, snapshot: InstallJobSnapshot) -> Self:
        model = snapshot.model_receipt
        runtime = snapshot.runtime_receipt
        return cls(
            job_id=snapshot.job_id,
            state=snapshot.state.value,
            tier=snapshot.tier,
            model_sha256=snapshot.model_sha256,
            runtime_sha256=snapshot.runtime_sha256,
            downloaded_bytes=snapshot.downloaded_bytes,
            total_bytes=snapshot.total_bytes,
            progress_fraction=snapshot.progress_fraction,
            created_at=snapshot.created_at,
            updated_at=snapshot.updated_at,
            error_code=snapshot.error_code,
            retryable=snapshot.retryable,
            model_receipt=(
                None
                if model is None
                else ModelReceiptResponse(
                    model_id=model.model_id,
                    repository_id=model.repository_id,
                    revision=model.revision,
                    filename=model.filename,
                    size=model.size,
                    sha256=model.sha256,
                    license_spdx=model.license_spdx,
                    request_sha256=model.request_sha256,
                    final_host=model.final_host,
                    installed_at=model.installed_at,
                    reused_verified_file=model.reused_verified_file,
                )
            ),
            runtime_receipt=(
                None
                if runtime is None
                else RuntimeReceiptResponse(
                    release_tag=runtime.release_tag,
                    commit=runtime.commit,
                    archive_filename=runtime.archive_filename,
                    archive_size=runtime.archive_size,
                    archive_sha256=runtime.archive_sha256,
                    license_spdx=runtime.license_spdx,
                    server_sha256=runtime.server_sha256,
                    extracted_size=runtime.extracted_size,
                    extracted_file_count=runtime.extracted_file_count,
                    extracted_tree_sha256=runtime.extracted_tree_sha256,
                    installation_sha256=runtime.installation_sha256,
                    request_sha256=runtime.request_sha256,
                    final_host=runtime.final_host,
                    installed_at=runtime.installed_at,
                    reused_verified_install=runtime.reused_verified_install,
                )
            ),
        )


class ServerStatusResponse(LocalModelContract):
    state: str
    running: bool
    model_id: str | None
    backend: str | None
    context_tokens: int | None
    error_code: str | None

    @classmethod
    def from_snapshot(cls, snapshot: ServerSnapshot) -> Self:
        return cls(
            state=snapshot.state.value,
            running=snapshot.running,
            model_id=snapshot.model_id,
            backend=snapshot.backend,
            context_tokens=snapshot.context_tokens,
            error_code=snapshot.error_code,
        )


class LocalModelStatusResponse(LocalModelContract):
    status: str
    install: InstallJobResponse | None
    server: ServerStatusResponse


def _authorized_service(request: Request) -> LocalModelRuntimeService:
    settings = getattr(request.app.state, "settings", None)
    if not isinstance(settings, Settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The local model service is unavailable.",
        )
    authorizations = request.headers.getlist("authorization")
    authorization = authorizations[0] if len(authorizations) == 1 else ""
    scheme, separator, supplied = authorization.partition(" ")
    expected = settings.session_token.get_secret_value()
    valid = (
        len(authorizations) == 1
        and separator == " "
        and scheme.casefold() == "bearer"
        and " " not in supplied
        and hmac.compare_digest(supplied.encode(), expected.encode())
    )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    service = getattr(request.app.state, "local_model_service", None)
    if not isinstance(service, LocalModelRuntimeService):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The local model service is unavailable.",
        )
    return service


LocalModelServiceDependency = Annotated[
    LocalModelRuntimeService,
    Depends(_authorized_service),
]


def _service_error(error: LocalModelServiceError) -> HTTPException:
    if error.code == "install_job_not_found":
        code = status.HTTP_404_NOT_FOUND
        detail = "Resource not found."
    elif error.code in {
        "install_already_active",
        "install_approval_mismatch",
        "server_running",
        "verified_install_required",
    }:
        code = status.HTTP_409_CONFLICT
        detail = error.safe_message
    elif error.code == "model_exceeds_safe_budget":
        code = status.HTTP_422_UNPROCESSABLE_CONTENT
        detail = error.safe_message
    else:
        code = status.HTTP_503_SERVICE_UNAVAILABLE
        detail = error.safe_message
    return HTTPException(status_code=code, detail=detail)


def create_local_model_router() -> APIRouter:
    router = APIRouter(prefix="/v1/local-model", tags=["local-model"])

    @router.get("/recommendation", response_model=SystemRecommendationResponse)
    async def recommendation(
        service: LocalModelServiceDependency,
    ) -> SystemRecommendationResponse:
        try:
            return SystemRecommendationResponse.from_service(service)
        except LocalModelServiceError as error:
            raise _service_error(error) from None

    @router.post(
        "/install",
        response_model=InstallJobResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def start_install(
        payload: StartInstallRequest,
        service: LocalModelServiceDependency,
    ) -> InstallJobResponse:
        try:
            snapshot = await service.start_install(
                InstallApproval(
                    tier=payload.tier,
                    model_sha256=payload.approved_model_sha256,
                    runtime_sha256=payload.approved_runtime_sha256,
                )
            )
        except LocalModelServiceError as error:
            raise _service_error(error) from None
        return InstallJobResponse.from_snapshot(snapshot)

    @router.get("/install/{job_id}", response_model=InstallJobResponse)
    async def install_status(
        job_id: OpaqueJobId,
        service: LocalModelServiceDependency,
    ) -> InstallJobResponse:
        try:
            snapshot = await service.install_status(job_id)
        except LocalModelServiceError as error:
            raise _service_error(error) from None
        return InstallJobResponse.from_snapshot(snapshot)

    @router.post(
        "/install/{job_id}/cancel",
        response_model=InstallJobResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def cancel_install(
        job_id: OpaqueJobId,
        service: LocalModelServiceDependency,
    ) -> InstallJobResponse:
        try:
            snapshot = await service.cancel_install(job_id)
        except LocalModelServiceError as error:
            raise _service_error(error) from None
        return InstallJobResponse.from_snapshot(snapshot)

    @router.post("/server/start", response_model=ServerStatusResponse)
    async def start_server(
        service: LocalModelServiceDependency,
    ) -> ServerStatusResponse:
        try:
            snapshot = await service.start_server()
        except LocalModelServiceError as error:
            raise _service_error(error) from None
        return ServerStatusResponse.from_snapshot(snapshot)

    @router.post("/server/stop", response_model=ServerStatusResponse)
    async def stop_server(
        service: LocalModelServiceDependency,
    ) -> ServerStatusResponse:
        snapshot = await service.stop_server()
        return ServerStatusResponse.from_snapshot(snapshot)

    @router.get("/status", response_model=LocalModelStatusResponse)
    @router.get("/health", response_model=LocalModelStatusResponse)
    async def model_status(
        service: LocalModelServiceDependency,
    ) -> LocalModelStatusResponse:
        install = await service.current_install_status()
        server = await service.server_status()
        degraded = (
            install is not None and install.state.value == "failed"
        ) or server.state.value == "failed"
        return LocalModelStatusResponse(
            status="degraded" if degraded else "ok",
            install=None if install is None else InstallJobResponse.from_snapshot(install),
            server=ServerStatusResponse.from_snapshot(server),
        )

    return router
