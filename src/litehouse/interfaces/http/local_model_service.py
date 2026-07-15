from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol, cast

from litehouse.domain import EvidenceScope, EvidenceSegment, canonical_json
from litehouse.infrastructure.models.artifacts import (
    INTEGRATED_QWEN3_ARTIFACTS,
    IntegratedModelArtifact,
)
from litehouse.infrastructure.models.catalog import (
    ModelRecommendation,
    RecommendationTier,
    recommend_model_tiers,
)
from litehouse.infrastructure.models.downloader import (
    InstalledModel,
    ModelDownloadCancelled,
    ModelDownloadError,
    ModelDownloadProgress,
    ModelInstallReceipt,
    VerifiedModelInstaller,
)
from litehouse.infrastructure.models.providers import (
    EvidenceSynthesisClient as ProviderEvidenceSynthesisClient,
)
from litehouse.infrastructure.models.providers import (
    SynthesisRequest,
)
from litehouse.infrastructure.models.runtime import (
    LlamaServerHandle,
    LlamaServerSupervisor,
    RuntimeSupervisorError,
)
from litehouse.infrastructure.models.runtime_artifacts import (
    LlamaRuntimeArtifact,
    UnsupportedRuntimePlatformError,
    runtime_artifact_for_profile,
)
from litehouse.infrastructure.models.runtime_installer import (
    InstalledLlamaRuntime,
    RuntimeDownloadCancelled,
    RuntimeDownloadProgress,
    RuntimeInstallApproval,
    RuntimeInstallError,
    RuntimeInstallReceipt,
    VerifiedLlamaRuntimeInstaller,
)
from litehouse.infrastructure.system import CapabilityProfile

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REPORT_PROMPT_MARKER = "EVIDENCE_PACKET_SHA_BOUND_JSON:\n"
_MAX_REPORT_PROMPT_BYTES = 2 * 1024 * 1024
_ACTIVE_INSTALL_STATES = frozenset(
    {
        "queued",
        "installing_model",
        "installing_runtime",
        "verifying",
        "cancelling",
    }
)


class LocalModelServiceError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class _InstallReceiptMismatch(RuntimeError):
    pass


class InstallState(StrEnum):
    QUEUED = "queued"
    INSTALLING_MODEL = "installing_model"
    INSTALLING_RUNTIME = "installing_runtime"
    VERIFYING = "verifying"
    CANCELLING = "cancelling"
    READY = "ready"
    CANCELLED = "cancelled"
    FAILED = "failed"


class ServerState(StrEnum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class InstallApproval:
    tier: RecommendationTier
    model_sha256: str
    runtime_sha256: str

    def __post_init__(self) -> None:
        if not _SHA256.fullmatch(self.model_sha256) or not _SHA256.fullmatch(
            self.runtime_sha256
        ):
            raise ValueError("Install approval requires exact lowercase SHA-256 digests.")


@dataclass(frozen=True, slots=True)
class InstallSelection:
    recommendation: ModelRecommendation
    model_artifact: IntegratedModelArtifact
    runtime_artifact: LlamaRuntimeArtifact


@dataclass(frozen=True, slots=True)
class InstallJobSnapshot:
    job_id: str
    state: InstallState
    tier: RecommendationTier
    model_sha256: str
    runtime_sha256: str
    downloaded_bytes: int
    total_bytes: int
    created_at: datetime
    updated_at: datetime
    error_code: str | None = None
    retryable: bool = False
    model_receipt: ModelInstallReceipt | None = None
    runtime_receipt: RuntimeInstallReceipt | None = None

    @property
    def progress_fraction(self) -> float:
        if self.total_bytes < 1:
            return 0.0
        return round(min(1.0, self.downloaded_bytes / self.total_bytes), 6)


@dataclass(frozen=True, slots=True)
class ServerSnapshot:
    state: ServerState
    running: bool
    model_id: str | None
    backend: str | None
    context_tokens: int | None
    error_code: str | None = None


class ModelInstallerProtocol(Protocol):
    async def install(
        self,
        artifact: IntegratedModelArtifact,
        *,
        progress: Callable[[ModelDownloadProgress], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> InstalledModel: ...


class RuntimeInstallerProtocol(Protocol):
    async def install(
        self,
        artifact: LlamaRuntimeArtifact,
        *,
        approval: RuntimeInstallApproval | None = None,
        progress: Callable[[RuntimeDownloadProgress], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> InstalledLlamaRuntime: ...


class RuntimeSupervisorProtocol(Protocol):
    async def start(
        self,
        runtime: InstalledLlamaRuntime,
        model: InstalledModel,
        profile: CapabilityProfile,
        recommendation: ModelRecommendation,
    ) -> LlamaServerHandle: ...


class ReportEvidenceSynthesisHook:
    def __init__(self, service: LocalModelRuntimeService) -> None:
        self._service = service

    async def synthesize(self, prompt: str) -> dict[str, object]:
        instruction, evidence = parse_report_evidence_prompt(prompt)
        provider = await self._service.evidence_client()
        generated = await provider.synthesize(
            SynthesisRequest(instruction=instruction, evidence_segments=evidence)
        )
        return {
            "claims": [
                {
                    "claim_id": claim.claim_id,
                    "text": claim.text,
                    "evidence_ids": list(claim.evidence_ids),
                }
                for claim in generated.claims
            ]
        }


class LocalModelRuntimeService:
    def __init__(
        self,
        *,
        profile: CapabilityProfile,
        model_installer: ModelInstallerProtocol,
        runtime_installer: RuntimeInstallerProtocol,
        supervisor: RuntimeSupervisorProtocol,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._profile = profile
        self._model_installer = model_installer
        self._runtime_installer = runtime_installer
        self._supervisor = supervisor
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = asyncio.Lock()
        self._server_lock = asyncio.Lock()
        self._job: InstallJobSnapshot | None = None
        self._job_task: asyncio.Task[None] | None = None
        self._cancel_event: asyncio.Event | None = None
        self._installed_model: InstalledModel | None = None
        self._installed_runtime: InstalledLlamaRuntime | None = None
        self._installed_recommendation: ModelRecommendation | None = None
        self._server_handle: LlamaServerHandle | None = None
        self._server_state = ServerState.STOPPED
        self._server_error_code: str | None = None
        self._closed = False

    @classmethod
    def from_verified_components(
        cls,
        *,
        profile: CapabilityProfile,
        model_installer: VerifiedModelInstaller,
        runtime_installer: VerifiedLlamaRuntimeInstaller,
        supervisor: LlamaServerSupervisor,
    ) -> LocalModelRuntimeService:
        return cls(
            profile=profile,
            model_installer=model_installer,
            runtime_installer=runtime_installer,
            supervisor=supervisor,
        )

    def selections(self) -> tuple[InstallSelection, ...]:
        try:
            runtime_artifact = runtime_artifact_for_profile(self._profile)
        except UnsupportedRuntimePlatformError:
            raise LocalModelServiceError(
                "runtime_platform_unsupported",
                "No verified local inference runtime is available for this platform.",
            ) from None
        selections: list[InstallSelection] = []
        for recommendation in recommend_model_tiers(self._profile):
            model_artifact = next(
                artifact
                for artifact in INTEGRATED_QWEN3_ARTIFACTS
                if artifact.model_id == recommendation.model_id
            )
            selections.append(
                InstallSelection(recommendation, model_artifact, runtime_artifact)
            )
        return tuple(selections)

    def system_selection(self) -> InstallSelection:
        return next(
            selection
            for selection in self.selections()
            if selection.recommendation.tier is RecommendationTier.BALANCED
        )

    async def start_install(self, approval: InstallApproval) -> InstallJobSnapshot:
        selection = self._selection_for(approval.tier)
        if (
            approval.model_sha256 != selection.model_artifact.sha256
            or approval.runtime_sha256 != selection.runtime_artifact.sha256
        ):
            raise LocalModelServiceError(
                "install_approval_mismatch",
                "Install approval does not match the selected pinned artifacts.",
            )
        if selection.recommendation.exceeds_safe_budget:
            raise LocalModelServiceError(
                "model_exceeds_safe_budget",
                "The selected model exceeds this system's safe memory budget.",
            )
        async with self._lock:
            self._require_open()
            if self._job is not None and self._job.state.value in _ACTIVE_INSTALL_STATES:
                raise LocalModelServiceError(
                    "install_already_active",
                    "A local model installation is already active.",
                    retryable=True,
                )
            if self._server_handle is not None:
                raise LocalModelServiceError(
                    "server_running",
                    "Stop the local model server before changing its installation.",
                )
            now = self._clock()
            job_id = secrets.token_urlsafe(24)
            total_bytes = selection.model_artifact.size + selection.runtime_artifact.size
            snapshot = InstallJobSnapshot(
                job_id=job_id,
                state=InstallState.QUEUED,
                tier=approval.tier,
                model_sha256=approval.model_sha256,
                runtime_sha256=approval.runtime_sha256,
                downloaded_bytes=0,
                total_bytes=total_bytes,
                created_at=now,
                updated_at=now,
            )
            cancel_event = asyncio.Event()
            self._job = snapshot
            self._cancel_event = cancel_event
            self._installed_model = None
            self._installed_runtime = None
            self._installed_recommendation = None
            self._job_task = asyncio.create_task(
                self._run_install(snapshot.job_id, selection, cancel_event),
                name=f"litehouse-model-install-{snapshot.job_id}",
            )
            return snapshot

    async def install_status(self, job_id: str) -> InstallJobSnapshot:
        async with self._lock:
            if self._job is None or self._job.job_id != job_id:
                raise LocalModelServiceError("install_job_not_found", "Install job not found.")
            return self._job

    async def current_install_status(self) -> InstallJobSnapshot | None:
        async with self._lock:
            return self._job

    async def cancel_install(self, job_id: str) -> InstallJobSnapshot:
        async with self._lock:
            if self._job is None or self._job.job_id != job_id:
                raise LocalModelServiceError("install_job_not_found", "Install job not found.")
            if self._job.state.value not in _ACTIVE_INSTALL_STATES:
                return self._job
            if self._cancel_event is not None:
                self._cancel_event.set()
            self._job = replace(
                self._job,
                state=InstallState.CANCELLING,
                updated_at=self._clock(),
            )
            return self._job

    async def start_server(self) -> ServerSnapshot:
        async with self._server_lock:
            async with self._lock:
                self._require_open()
                if self._job is None or self._job.state is not InstallState.READY:
                    raise LocalModelServiceError(
                        "verified_install_required",
                        "A verified model and runtime installation is required.",
                    )
                if self._server_handle is not None and self._server_handle.running:
                    return self._server_snapshot_unlocked()
                stale_handle = self._server_handle
                self._server_handle = None
                model = self._installed_model
                runtime = self._installed_runtime
                recommendation = self._installed_recommendation
                if model is None or runtime is None or recommendation is None:
                    raise LocalModelServiceError(
                        "verified_install_required",
                        "A verified model and runtime installation is required.",
                    )
                self._server_state = ServerState.STARTING
                self._server_error_code = None
            if stale_handle is not None:
                await stale_handle.stop()
            try:
                handle = await self._supervisor.start(
                    runtime,
                    model,
                    self._profile,
                    recommendation,
                )
            except RuntimeSupervisorError as error:
                async with self._lock:
                    self._server_state = ServerState.FAILED
                    self._server_error_code = error.code
                raise LocalModelServiceError(
                    error.code,
                    error.safe_message,
                    retryable=error.retryable,
                ) from None
            except Exception:
                async with self._lock:
                    self._server_state = ServerState.FAILED
                    self._server_error_code = "server_start_failed"
                raise LocalModelServiceError(
                    "server_start_failed",
                    "The local model server could not be started.",
                    retryable=True,
                ) from None
            async with self._lock:
                if self._closed:
                    await handle.stop()
                    raise LocalModelServiceError(
                        "service_closed",
                        "The local model service is shutting down.",
                    )
                self._server_handle = handle
                self._server_state = ServerState.RUNNING
                return self._server_snapshot_unlocked()

    async def stop_server(self) -> ServerSnapshot:
        async with self._server_lock:
            async with self._lock:
                handle = self._server_handle
                if handle is None:
                    self._server_state = ServerState.STOPPED
                    return self._server_snapshot_unlocked()
                self._server_state = ServerState.STOPPING
            await handle.stop()
            async with self._lock:
                self._server_handle = None
                self._server_state = ServerState.STOPPED
                self._server_error_code = None
                return self._server_snapshot_unlocked()

    async def server_status(self) -> ServerSnapshot:
        async with self._lock:
            if (
                self._server_state is ServerState.RUNNING
                and self._server_handle is not None
                and not self._server_handle.running
            ):
                self._server_state = ServerState.FAILED
                self._server_error_code = "server_exited"
            return self._server_snapshot_unlocked()

    async def evidence_client(self) -> ProviderEvidenceSynthesisClient:
        async with self._lock:
            handle = self._server_handle
            if handle is None or not handle.running:
                raise LocalModelServiceError(
                    "server_not_running",
                    "The local evidence synthesis server is not running.",
                    retryable=True,
                )
            return ProviderEvidenceSynthesisClient(
                handle.endpoint_config,
                secret_resolver=handle,
            )

    def report_synthesis_client(self) -> ReportEvidenceSynthesisHook:
        return ReportEvidenceSynthesisHook(self)

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            if self._cancel_event is not None:
                self._cancel_event.set()
            task = self._job_task
        if task is not None and not task.done():
            await task
        await self.stop_server()

    async def _run_install(
        self,
        job_id: str,
        selection: InstallSelection,
        cancel_event: asyncio.Event,
    ) -> None:
        try:
            self._set_job_phase(job_id, InstallState.INSTALLING_MODEL)
            model = await self._model_installer.install(
                selection.model_artifact,
                progress=lambda event: self._set_model_progress(job_id, event),
                cancelled=cancel_event.is_set,
            )
            if not _model_receipt_matches(model, selection.model_artifact):
                raise _InstallReceiptMismatch("model receipt mismatch")
            if cancel_event.is_set():
                raise ModelDownloadCancelled("installation cancelled")
            self._set_job_phase(job_id, InstallState.INSTALLING_RUNTIME)
            runtime = await self._runtime_installer.install(
                selection.runtime_artifact,
                approval=RuntimeInstallApproval(selection.runtime_artifact.sha256),
                progress=lambda event: self._set_runtime_progress(
                    job_id,
                    selection.model_artifact.size,
                    event,
                ),
                cancelled=cancel_event.is_set,
            )
            if not _runtime_receipt_matches(runtime, selection.runtime_artifact):
                raise _InstallReceiptMismatch("runtime receipt mismatch")
            self._set_job_phase(job_id, InstallState.VERIFYING)
            if cancel_event.is_set():
                raise RuntimeDownloadCancelled("installation cancelled")
            async with self._lock:
                if self._job is None or self._job.job_id != job_id:
                    return
                self._installed_model = model
                self._installed_runtime = runtime
                self._installed_recommendation = selection.recommendation
                self._job = replace(
                    self._job,
                    state=InstallState.READY,
                    downloaded_bytes=self._job.total_bytes,
                    updated_at=self._clock(),
                    model_receipt=model.receipt,
                    runtime_receipt=runtime.receipt,
                )
        except (ModelDownloadCancelled, RuntimeDownloadCancelled):
            await self._finish_job(job_id, InstallState.CANCELLED)
        except ModelDownloadError as error:
            await self._finish_job(
                job_id,
                InstallState.FAILED,
                error_code=error.code,
                retryable=error.retryable,
            )
        except RuntimeInstallError as error:
            await self._finish_job(
                job_id,
                InstallState.FAILED,
                error_code=error.code,
                retryable=error.retryable,
            )
        except _InstallReceiptMismatch:
            await self._finish_job(
                job_id,
                InstallState.FAILED,
                error_code="install_receipt_mismatch",
                retryable=False,
            )
        except asyncio.CancelledError:
            await self._finish_job(job_id, InstallState.CANCELLED)
        except Exception:
            await self._finish_job(
                job_id,
                InstallState.FAILED,
                error_code="install_failed",
                retryable=True,
            )

    async def _finish_job(
        self,
        job_id: str,
        state: InstallState,
        *,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> None:
        async with self._lock:
            if self._job is None or self._job.job_id != job_id:
                return
            self._installed_model = None
            self._installed_runtime = None
            self._installed_recommendation = None
            self._job = replace(
                self._job,
                state=state,
                updated_at=self._clock(),
                error_code=error_code,
                retryable=retryable,
            )

    def _set_job_phase(self, job_id: str, state: InstallState) -> None:
        if self._job is None or self._job.job_id != job_id:
            return
        if self._job.state is InstallState.CANCELLING:
            return
        self._job = replace(self._job, state=state, updated_at=self._clock())

    def _set_model_progress(self, job_id: str, event: ModelDownloadProgress) -> None:
        self._set_progress(job_id, event.downloaded_bytes)

    def _set_runtime_progress(
        self,
        job_id: str,
        model_size: int,
        event: RuntimeDownloadProgress,
    ) -> None:
        self._set_progress(job_id, model_size + event.downloaded_bytes)

    def _set_progress(self, job_id: str, downloaded_bytes: int) -> None:
        if self._job is None or self._job.job_id != job_id:
            return
        bounded = max(self._job.downloaded_bytes, min(downloaded_bytes, self._job.total_bytes))
        self._job = replace(
            self._job,
            downloaded_bytes=bounded,
            updated_at=self._clock(),
        )

    def _selection_for(self, tier: RecommendationTier) -> InstallSelection:
        return next(
            selection
            for selection in self.selections()
            if selection.recommendation.tier is tier
        )

    def _server_snapshot_unlocked(self) -> ServerSnapshot:
        recommendation = self._installed_recommendation
        handle = self._server_handle
        return ServerSnapshot(
            state=self._server_state,
            running=handle is not None and handle.running,
            model_id=recommendation.model_id if recommendation is not None else None,
            backend=(
                handle.settings.backend.value
                if handle is not None and handle.running
                else None
            ),
            context_tokens=(
                handle.settings.context_tokens
                if handle is not None and handle.running
                else None
            ),
            error_code=self._server_error_code,
        )

    def _require_open(self) -> None:
        if self._closed:
            raise LocalModelServiceError(
                "service_closed",
                "The local model service is shutting down.",
            )


def parse_report_evidence_prompt(prompt: str) -> tuple[str, tuple[EvidenceSegment, ...]]:
    if len(prompt.encode("utf-8")) > _MAX_REPORT_PROMPT_BYTES:
        raise ValueError("The report evidence prompt exceeds the safe size limit.")
    prefix, marker, payload = prompt.partition(_REPORT_PROMPT_MARKER)
    if not marker or _REPORT_PROMPT_MARKER in payload or not prefix.strip():
        raise ValueError("The report evidence prompt is invalid.")
    raw: object = json.loads(payload)
    if not isinstance(raw, dict) or set(raw) != {"topic", "reader", "evidence"}:
        raise ValueError("The report evidence packet is invalid.")
    document = cast(dict[str, object], raw)
    topic = document["topic"]
    reader = document["reader"]
    evidence_rows = document["evidence"]
    if (
        not isinstance(topic, str)
        or not topic.strip()
        or len(topic) > 1000
        or not isinstance(reader, dict)
        or set(reader) != {"expertise", "prior_knowledge"}
        or not isinstance(evidence_rows, list)
        or not 1 <= len(evidence_rows) <= 50
    ):
        raise ValueError("The report evidence packet is invalid.")
    expertise = reader["expertise"]
    prior_knowledge = reader["prior_knowledge"]
    if (
        not isinstance(expertise, str)
        or not expertise.strip()
        or len(expertise) > 160
        or not isinstance(prior_knowledge, str)
        or len(prior_knowledge) > 4000
    ):
        raise ValueError("The report reader profile is invalid.")
    segments: list[EvidenceSegment] = []
    for raw_row in evidence_rows:
        if not isinstance(raw_row, dict) or set(raw_row) != {
            "evidence_id",
            "locator",
            "quoted_source_text",
            "scope",
            "sha256",
        }:
            raise ValueError("The report evidence packet is invalid.")
        row = cast(dict[str, object], raw_row)
        evidence_id = row["evidence_id"]
        locator = row["locator"]
        text = row["quoted_source_text"]
        sha256 = row["sha256"]
        scope = row["scope"]
        if (
            not isinstance(evidence_id, str)
            or not evidence_id.strip()
            or len(evidence_id) > 128
            or not isinstance(locator, str)
            or not locator.strip()
            or len(locator) > 4096
            or not isinstance(text, str)
            or not text
            or len(text) > 12_000
            or not isinstance(sha256, str)
            or hashlib.sha256(text.encode("utf-8")).hexdigest() != sha256
            or not isinstance(scope, str)
        ):
            raise ValueError("The report evidence packet failed SHA-256 validation.")
        segments.append(
            EvidenceSegment(
                id=evidence_id,
                work_id=f"report-prompt:{evidence_id}",
                text=text,
                locator=locator,
                scope=EvidenceScope(scope),
            )
        )
    if len({segment.id for segment in segments}) != len(segments):
        raise ValueError("The report evidence IDs must be unique.")
    instruction = canonical_json(
        {
            "task": "Create strictly grounded claims for the Litehouse report.",
            "topic": topic.strip(),
            "reader": {
                "expertise": expertise.strip(),
                "prior_knowledge": prior_knowledge.strip(),
            },
        }
    )
    return instruction, tuple(segments)


def _model_receipt_matches(
    installed: InstalledModel,
    artifact: IntegratedModelArtifact,
) -> bool:
    receipt = installed.receipt
    return (
        receipt.model_id == artifact.model_id
        and receipt.repository_id == artifact.repository_id
        and receipt.revision == artifact.revision
        and receipt.filename == artifact.filename
        and receipt.size == artifact.size
        and receipt.sha256 == artifact.sha256
        and receipt.license_spdx == artifact.license_spdx
        and _SHA256.fullmatch(receipt.request_sha256) is not None
    )


def _runtime_receipt_matches(
    installed: InstalledLlamaRuntime,
    artifact: LlamaRuntimeArtifact,
) -> bool:
    receipt = installed.receipt
    return (
        installed.artifact == artifact
        and receipt.release_tag == artifact.release_tag
        and receipt.commit == artifact.commit
        and receipt.archive_filename == artifact.filename
        and receipt.archive_size == artifact.size
        and receipt.archive_sha256 == artifact.sha256
        and receipt.license_spdx == artifact.license_spdx
        and _SHA256.fullmatch(receipt.server_sha256) is not None
        and _SHA256.fullmatch(receipt.extracted_tree_sha256) is not None
        and _SHA256.fullmatch(receipt.installation_sha256) is not None
        and _SHA256.fullmatch(receipt.request_sha256) is not None
    )
