from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime

from litehouse.application.scheduler import QueueResult, SchedulePlanner, SchedulerService
from litehouse.application.schemas import WatchSpecification
from litehouse.domain import Run, Watch
from litehouse.domain.entities import utc_now
from litehouse.infrastructure.db.repositories import RunRepository, WatchRepository


class WatchService:
    def __init__(
        self,
        watches: WatchRepository,
        runs: RunRepository,
        *,
        planner: SchedulePlanner | None = None,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self._watches = watches
        self._runs = runs
        self._planner = planner or SchedulePlanner()
        self._scheduler = SchedulerService(runs, self._planner)
        self._now = now

    async def create_watch(
        self,
        *,
        name: str,
        specification: WatchSpecification,
        enabled: bool,
    ) -> Watch:
        return await self._watches.create(
            name=name,
            specification=specification.canonical_payload(),
            enabled=enabled,
        )

    async def get_watch(self, watch_id: str) -> Watch:
        return await self._watches.get(watch_id)

    async def list_watches(self) -> Sequence[Watch]:
        return await self._watches.list()

    async def revise_watch(
        self,
        *,
        watch_id: str,
        base_revision_number: int,
        specification: WatchSpecification,
    ) -> Watch:
        return await self._watches.update_revision(
            watch_id,
            specification.canonical_payload(),
            expected_revision_number=base_revision_number,
        )

    async def queue_run(
        self,
        *,
        watch_id: str,
        scheduled_at: datetime | None,
    ) -> QueueResult:
        watch = await self._watches.get(watch_id)
        specification = WatchSpecification.model_validate(watch.active_revision.specification)
        occurrence = scheduled_at or self._planner.next_after(specification, self._now())
        return await self._scheduler.queue_occurrence(watch.active_revision.id, occurrence)

    async def list_runs(
        self,
        *,
        watch_id: str | None,
        limit: int,
    ) -> Sequence[Run]:
        if watch_id is not None:
            await self._watches.get(watch_id)
        return await self._runs.list(watch_id=watch_id, limit=limit)
