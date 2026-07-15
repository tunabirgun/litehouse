from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware

from litehouse import __version__
from litehouse.application.reporting import (
    EvidenceSynthesisClient,
    ReportGenerationError,
    ReportGenerationService,
)
from litehouse.application.reviews import ReviewPreparationService
from litehouse.application.schemas import (
    CreateWatchRequest,
    GeneratedReportResponse,
    GenerateReportRequest,
    PreparedReviewResponse,
    PrepareReviewRequest,
    QueuedRunResponse,
    QueueRunRequest,
    ReviseWatchRequest,
    RunResponse,
    WatchResponse,
)
from litehouse.application.services import WatchService
from litehouse.application.worker import BackgroundReportWorker, WorkerLimits
from litehouse.config import Settings, get_settings
from litehouse.infrastructure.db.repositories import (
    ConcurrentRevisionError,
    RunRepository,
    WatchNotFoundError,
    WatchRepository,
)
from litehouse.infrastructure.db.session import (
    create_session_factory,
    create_sqlite_engine,
    init_database,
)
from litehouse.infrastructure.models import (
    LlamaServerSupervisor,
    VerifiedLlamaRuntimeInstaller,
    VerifiedModelInstaller,
)
from litehouse.infrastructure.sources import (
    CrossrefConnector,
    DataCiteConnector,
    EuropePmcConnector,
    LibraryOfCongressConnector,
    OpenAlexConnector,
    SemanticScholarConnector,
    SourceSearchCoordinator,
)
from litehouse.infrastructure.system import probe_capabilities
from litehouse.infrastructure.vault.paths import VaultRoot
from litehouse.infrastructure.vault.repository import VaultRepository
from litehouse.infrastructure.vault.store import VaultBlobStore
from litehouse.interfaces.http.latex_runtime import latex_runtime_router
from litehouse.interfaces.http.library import create_library_router
from litehouse.interfaces.http.library_service import LibraryHttpService
from litehouse.interfaces.http.local_model import create_local_model_router
from litehouse.interfaces.http.local_model_service import LocalModelRuntimeService
from litehouse.interfaces.http.provider_settings import create_provider_settings_router
from litehouse.interfaces.http.provider_settings_service import ProviderSettingsService
from litehouse.interfaces.http.system import system_router
from litehouse.interfaces.http.vault_relocation import create_vault_relocation_router


def _service(request: Request) -> WatchService:
    service: WatchService = request.app.state.watch_service
    return service


def _review_service(request: Request) -> ReviewPreparationService:
    service: ReviewPreparationService = request.app.state.review_service
    return service


def _report_service(request: Request) -> ReportGenerationService:
    service: ReportGenerationService = request.app.state.report_service
    return service


def _official_review_coordinator() -> SourceSearchCoordinator:
    return SourceSearchCoordinator(
        (
            OpenAlexConnector(),
            CrossrefConnector(),
            EuropePmcConnector(),
            SemanticScholarConnector(),
            LibraryOfCongressConnector(),
            DataCiteConnector(),
        )
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found.")


def _router() -> APIRouter:
    router = APIRouter(prefix="/v1")

    @router.post(
        "/reviews/prepare",
        response_model=PreparedReviewResponse,
        tags=["reviews"],
    )
    async def prepare_review(
        payload: PrepareReviewRequest,
        request: Request,
    ) -> PreparedReviewResponse:
        try:
            return await _review_service(request).prepare(
                payload.specification,
                max_results=payload.max_results,
            )
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The literature request could not be prepared.",
            ) from None

    @router.post(
        "/reports/generate",
        response_model=GeneratedReportResponse,
        tags=["reports"],
    )
    async def generate_report(
        payload: GenerateReportRequest,
        request: Request,
    ) -> GeneratedReportResponse:
        try:
            receipt = await _report_service(request).generate(
                payload.specification,
                max_results=payload.max_results,
            )
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The report request could not be generated.",
            ) from None
        except ReportGenerationError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="The requested report output is unavailable.",
            ) from None
        return GeneratedReportResponse.from_receipt(receipt)

    @router.post(
        "/watches",
        response_model=WatchResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["watches"],
    )
    async def create_watch(payload: CreateWatchRequest, request: Request) -> WatchResponse:
        watch = await _service(request).create_watch(
            name=payload.name,
            specification=payload.specification,
            enabled=payload.enabled,
        )
        return WatchResponse.from_domain(watch)

    @router.get("/watches", response_model=list[WatchResponse], tags=["watches"])
    async def list_watches(request: Request) -> list[WatchResponse]:
        watches = await _service(request).list_watches()
        return [WatchResponse.from_domain(watch) for watch in watches]

    @router.get("/watches/{watch_id}", response_model=WatchResponse, tags=["watches"])
    async def get_watch(watch_id: str, request: Request) -> WatchResponse:
        try:
            watch = await _service(request).get_watch(watch_id)
        except WatchNotFoundError:
            raise _not_found() from None
        return WatchResponse.from_domain(watch)

    @router.post(
        "/watches/{watch_id}/revisions",
        response_model=WatchResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["watches"],
    )
    async def revise_watch(
        watch_id: str,
        payload: ReviseWatchRequest,
        request: Request,
    ) -> WatchResponse:
        try:
            watch = await _service(request).revise_watch(
                watch_id=watch_id,
                base_revision_number=payload.base_revision_number,
                specification=payload.specification,
            )
        except WatchNotFoundError:
            raise _not_found() from None
        except ConcurrentRevisionError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The watch changed before this revision was saved.",
            ) from None
        return WatchResponse.from_domain(watch)

    @router.post(
        "/watches/{watch_id}/runs",
        response_model=QueuedRunResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["runs"],
    )
    async def queue_run(
        watch_id: str,
        payload: QueueRunRequest,
        request: Request,
        response: Response,
    ) -> QueuedRunResponse:
        try:
            result = await _service(request).queue_run(
                watch_id=watch_id,
                scheduled_at=payload.scheduled_at,
            )
        except WatchNotFoundError:
            raise _not_found() from None
        if not result.created:
            response.status_code = status.HTTP_200_OK
        return QueuedRunResponse(
            run=RunResponse.from_domain(result.run),
            created=result.created,
        )

    @router.get("/runs", response_model=list[RunResponse], tags=["runs"])
    async def list_runs(
        request: Request,
        watch_id: str | None = None,
        limit: int = Query(default=100, ge=1, le=200),
    ) -> list[RunResponse]:
        try:
            runs = await _service(request).list_runs(watch_id=watch_id, limit=limit)
        except WatchNotFoundError:
            raise _not_found() from None
        return [RunResponse.from_domain(run) for run in runs]

    return router


def create_app(
    settings: Settings | None = None,
    *,
    review_coordinator: SourceSearchCoordinator | None = None,
    report_service: ReportGenerationService | None = None,
    synthesis_client: EvidenceSynthesisClient | None = None,
) -> FastAPI:
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(instance: FastAPI) -> AsyncIterator[None]:
        engine = create_sqlite_engine(resolved.database_path)
        worker: BackgroundReportWorker | None = None
        worker_task: asyncio.Task[None] | None = None
        local_model: LocalModelRuntimeService | None = None
        try:
            await init_database(engine)
            sessions = create_session_factory(engine)
            watches = WatchRepository(sessions)
            runs = RunRepository(sessions)
            instance.state.watch_service = WatchService(
                watches,
                runs,
            )
            reviews = ReviewPreparationService(
                review_coordinator or _official_review_coordinator()
            )
            instance.state.review_service = reviews
            blobs = VaultBlobStore(
                VaultRoot.from_user_path(resolved.vault_path.expanduser().resolve())
            )
            vault = VaultRepository(sessions, blobs)
            instance.state.library_service = LibraryHttpService(vault, blobs)
            instance.state.library_repository = vault
            instance.state.library_blobs = blobs
            profile = await asyncio.to_thread(probe_capabilities, resolved.vault_path)
            local_model = LocalModelRuntimeService.from_verified_components(
                profile=profile,
                model_installer=VerifiedModelInstaller(resolved.data_dir / "models"),
                runtime_installer=VerifiedLlamaRuntimeInstaller(
                    resolved.data_dir / "runtimes" / "llama.cpp"
                ),
                supervisor=LlamaServerSupervisor(
                    resolved.data_dir / "runtime-state" / "llama.cpp"
                ),
            )
            instance.state.local_model_service = local_model
            provider_settings = ProviderSettingsService(
                config_path=resolved.data_dir / "config" / "model-provider.json",
                local_model=local_model,
            )
            instance.state.provider_settings_service = provider_settings
            reports = report_service or ReportGenerationService(
                reviews,
                vault,
                resolved.reports_path,
                synthesis_client=(
                    synthesis_client or provider_settings.report_synthesis_client()
                ),
            )
            instance.state.report_service = reports
            worker_limits = WorkerLimits(
                    concurrency=resolved.scheduler_concurrency,
                    catch_up_runs=resolved.scheduler_catch_up_runs,
                    catch_up_hours=resolved.scheduler_catch_up_hours,
                    max_attempts=resolved.scheduler_run_max_attempts,
                    lease_seconds=resolved.scheduler_lease_seconds,
                )

            def make_report_worker() -> BackgroundReportWorker:
                return BackgroundReportWorker(
                    watches,
                    runs,
                    reports,
                    limits=worker_limits,
                )

            worker = make_report_worker()
            instance.state.report_worker = worker
            instance.state.report_worker_factory = make_report_worker
            instance.state.report_worker_poll_seconds = resolved.scheduler_poll_seconds
            instance.state.scheduler_enabled = resolved.scheduler_enabled
            worker_task = (
                asyncio.create_task(
                    worker.run(poll_seconds=resolved.scheduler_poll_seconds),
                    name="litehouse-report-worker",
                )
                if resolved.scheduler_enabled
                else None
            )
            instance.state.report_worker_task = worker_task
            yield
        finally:
            active_worker: BackgroundReportWorker | None = getattr(
                instance.state,
                "report_worker",
                worker,
            )
            active_worker_task: asyncio.Task[None] | None = getattr(
                instance.state,
                "report_worker_task",
                worker_task,
            )
            if active_worker is not None and active_worker_task is not None:
                active_worker.stop()
                try:
                    await asyncio.wait_for(asyncio.shield(active_worker_task), timeout=5)
                except TimeoutError:
                    active_worker_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await active_worker_task
            if local_model is not None:
                await local_model.close()
            await engine.dispose()

    app = FastAPI(
        title="Litehouse local API",
        version=__version__,
        docs_url="/v1/docs" if resolved.development_mode else None,
        redoc_url=None,
        openapi_url="/v1/openapi.json" if resolved.development_mode else None,
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.vault_lifecycle_lock = asyncio.Lock()
    app.state.vault_relocation_maintenance = False
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list(resolved.allowed_hosts),
        www_redirect=False,
    )
    if resolved.development_mode:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved.allowed_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.middleware("http")
    async def local_security_boundary(
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        origins = request.headers.getlist("origin")
        origin = origins[0] if len(origins) == 1 else None
        if len(origins) > 1 or (origin is not None and origin not in resolved.allowed_origins):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "Origin is not allowed."},
            )
        is_public = request.url.path == "/v1/health"
        is_development_preflight = (
            resolved.development_mode
            and request.method == "OPTIONS"
            and origin in resolved.allowed_origins
        )
        is_api = request.url.path == "/v1" or request.url.path.startswith("/v1/")
        if is_api and not is_public and not is_development_preflight:
            authorizations = request.headers.getlist("authorization")
            authorization = authorizations[0] if len(authorizations) == 1 else ""
            scheme, separator, supplied = authorization.partition(" ")
            expected = resolved.session_token.get_secret_value()
            valid = (
                len(authorizations) == 1
                and separator == " "
                and scheme.casefold() == "bearer"
                and " " not in supplied
                and hmac.compare_digest(supplied.encode(), expected.encode())
            )
            if not valid:
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Authentication required."},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        is_vault_relocation = request.url.path == "/v1/system/vault/relocate"
        is_mutation = request.method not in {"GET", "HEAD", "OPTIONS"}
        if is_api and is_mutation and not is_vault_relocation:
            async with request.app.state.vault_lifecycle_lock:
                if request.app.state.vault_relocation_maintenance:
                    return JSONResponse(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        content={
                            "detail": (
                                "Vault relocation is verified. Restart Litehouse before "
                                "making further changes."
                            )
                        },
                    )
                return await call_next(request)
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_error(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": "Request validation failed."},
        )

    @app.exception_handler(Exception)
    async def internal_error(_request: Request, _error: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error."},
        )

    @app.get("/v1/health", tags=["system"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    app.include_router(_router())
    app.include_router(latex_runtime_router())
    app.include_router(create_library_router())
    app.include_router(create_local_model_router())
    app.include_router(create_provider_settings_router())
    app.include_router(system_router(resolved))
    app.include_router(create_vault_relocation_router(resolved))
    return app


app = create_app()
