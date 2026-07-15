from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from litehouse.application.reporting import ReportGenerationError, ReportGenerationService
from litehouse.application.scheduler import SchedulePlanner, SchedulerService
from litehouse.application.schemas import WatchSpecification
from litehouse.domain import Run, RunStatus
from litehouse.domain.entities import utc_now
from litehouse.infrastructure.db.repositories import RunRepository, WatchRepository

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class WorkerLimits:
    concurrency: int = 2
    catch_up_runs: int = 4
    catch_up_hours: int = 24
    max_attempts: int = 3
    lease_seconds: int = 300
    watch_limit: int = 100

    def __post_init__(self) -> None:
        if not 1 <= self.concurrency <= 4:
            raise ValueError("Worker concurrency must be between 1 and 4.")
        if not 1 <= self.catch_up_runs <= 24:
            raise ValueError("Catch-up run count must be between 1 and 24.")
        if not 1 <= self.catch_up_hours <= 168:
            raise ValueError("Catch-up hours must be between 1 and 168.")
        if not 1 <= self.max_attempts <= 5:
            raise ValueError("Maximum attempts must be between 1 and 5.")
        if not 30 <= self.lease_seconds <= 3600:
            raise ValueError("Worker leases must be between 30 and 3600 seconds.")
        if not 1 <= self.watch_limit <= 200:
            raise ValueError("Worker watch limits must be between 1 and 200.")


@dataclass(frozen=True, slots=True)
class WorkerTickReceipt:
    queued_count: int
    claimed_count: int
    recovered_count: int


class BackgroundReportWorker:
    def __init__(
        self,
        watches: WatchRepository,
        runs: RunRepository,
        reports: ReportGenerationService,
        *,
        limits: WorkerLimits | None = None,
        planner: SchedulePlanner | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._watches = watches
        self._runs = runs
        self._reports = reports
        self._limits = limits or WorkerLimits()
        self._planner = planner or SchedulePlanner()
        self._scheduler = SchedulerService(runs, self._planner)
        self._clock = clock
        self._stop = asyncio.Event()

    async def run(self, *, poll_seconds: float) -> None:
        if not 0.1 <= poll_seconds <= 3600:
            raise ValueError("Worker polling must be between 0.1 and 3600 seconds.")
        while not self._stop.is_set():
            try:
                await self.tick()
            except Exception:
                _LOGGER.error("Background report worker tick failed.")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=poll_seconds)
            except TimeoutError:
                continue

    def stop(self) -> None:
        self._stop.set()

    async def tick(self) -> WorkerTickReceipt:
        now = self._clock()
        recovered = await self._runs.recover_stale(
            stale_before=now - timedelta(seconds=self._limits.lease_seconds),
            now=now,
            max_attempts=self._limits.max_attempts,
            limit=self._limits.concurrency * 4,
        )
        queued_count = await self._queue_due(now)
        claimed = await self._runs.claim_due(now, limit=self._limits.concurrency)
        if claimed:
            await asyncio.gather(
                *(self._execute(run) for run in claimed),
                return_exceptions=True,
            )
        return WorkerTickReceipt(
            queued_count=queued_count,
            claimed_count=len(claimed),
            recovered_count=len(recovered),
        )

    async def _queue_due(self, now: datetime) -> int:
        created_count = 0
        catch_up_start = now - timedelta(hours=self._limits.catch_up_hours)
        for watch in await self._watches.list_enabled(limit=self._limits.watch_limit):
            try:
                specification = WatchSpecification.model_validate(
                    watch.active_revision.specification
                )
            except ValueError:
                continue
            latest = await self._runs.latest_scheduled_at(watch.active_revision.id)
            start = latest or max(watch.created_at, catch_up_start)
            queued = await self._scheduler.queue_due(
                watch_revision_id=watch.active_revision.id,
                specification=specification,
                start_exclusive=start,
                end_inclusive=now,
                limit=self._limits.catch_up_runs,
            )
            created_count += sum(item.created for item in queued)
        return created_count

    async def _execute(self, run: Run) -> None:
        try:
            revision = await self._watches.get_revision(run.watch_revision_id)
            specification = WatchSpecification.model_validate(revision.specification)
            receipt = await self._reports.generate(
                specification,
                max_results=25,
                generated_at=run.scheduled_at,
                idempotency_key=run.id,
            )
            await self._runs.complete(
                run.id,
                status=RunStatus.PARTIAL if receipt.partial else RunStatus.SUCCEEDED,
                finished_at=self._clock(),
                report_id=receipt.report_id,
                result_sha256=receipt.result_sha256,
                artifact_count=len(receipt.artifacts),
                source_error_count=len(receipt.source_errors),
            )
        except (ValueError, ReportGenerationError):
            await self._runs.retry_or_fail(
                run.id,
                now=self._clock(),
                max_attempts=self._limits.max_attempts,
                retryable=False,
                error_code="report_contract_failed",
            )
        except Exception:
            await self._runs.retry_or_fail(
                run.id,
                now=self._clock(),
                max_attempts=self._limits.max_attempts,
                retryable=True,
                error_code="report_execution_failed",
            )
