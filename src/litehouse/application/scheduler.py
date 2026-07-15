from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger  # type: ignore[import-untyped]

from litehouse.application.schemas import (
    CronSchedule,
    IntervalSchedule,
    IntervalUnit,
    WatchSpecification,
)
from litehouse.domain import Run
from litehouse.infrastructure.db.repositories import RunRepository

_UNIT_DURATION = {
    IntervalUnit.MINUTES: timedelta(minutes=1),
    IntervalUnit.HOURS: timedelta(hours=1),
    IntervalUnit.DAYS: timedelta(days=1),
    IntervalUnit.WEEKS: timedelta(weeks=1),
}


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Scheduler timestamps must include a UTC offset.")
    return value.astimezone(UTC)


class SchedulePlanner:
    def next_after(self, specification: WatchSpecification, after: datetime) -> datetime:
        reference = _as_utc(after)
        schedule = specification.schedule
        if isinstance(schedule, IntervalSchedule):
            return self._next_interval(schedule, reference)
        return self._next_cron(schedule, specification.timezone, reference)

    def occurrences_between(
        self,
        specification: WatchSpecification,
        *,
        start_exclusive: datetime,
        end_inclusive: datetime,
        limit: int = 1000,
    ) -> tuple[datetime, ...]:
        if limit < 1 or limit > 1000:
            raise ValueError("Occurrence limit must be between 1 and 1000.")
        start = _as_utc(start_exclusive)
        end = _as_utc(end_inclusive)
        if end < start:
            raise ValueError("Schedule window ends before it starts.")
        occurrences: list[datetime] = []
        cursor = start
        while len(occurrences) < limit:
            occurrence = self.next_after(specification, cursor)
            if occurrence > end:
                break
            occurrences.append(occurrence)
            cursor = occurrence
        return tuple(occurrences)

    @staticmethod
    def _next_interval(schedule: IntervalSchedule, after: datetime) -> datetime:
        anchor = _as_utc(schedule.start_at)
        period = _UNIT_DURATION[schedule.unit] * schedule.every
        if after < anchor:
            return anchor
        elapsed_periods = (after - anchor) // period
        return anchor + (elapsed_periods + 1) * period

    @staticmethod
    def _next_cron(schedule: CronSchedule, timezone: str, after: datetime) -> datetime:
        zone = ZoneInfo(timezone)
        trigger = CronTrigger.from_crontab(schedule.expression, timezone=zone)
        reference = (after + timedelta(microseconds=1)).astimezone(zone)
        next_fire = trigger.get_next_fire_time(None, reference)
        if next_fire is None:
            raise ValueError("Schedule has no future occurrence.")
        return _as_utc(next_fire)


@dataclass(frozen=True, slots=True)
class QueueResult:
    run: Run
    created: bool


class SchedulerService:
    def __init__(
        self,
        runs: RunRepository,
        planner: SchedulePlanner | None = None,
    ) -> None:
        self._runs = runs
        self._planner = planner or SchedulePlanner()

    async def queue_occurrence(
        self,
        watch_revision_id: str,
        scheduled_at: datetime,
    ) -> QueueResult:
        run, created = await self._runs.queue(watch_revision_id, scheduled_at)
        return QueueResult(run=run, created=created)

    async def queue_due(
        self,
        *,
        watch_revision_id: str,
        specification: WatchSpecification,
        start_exclusive: datetime,
        end_inclusive: datetime,
        limit: int = 1000,
    ) -> tuple[QueueResult, ...]:
        occurrences = self._planner.occurrences_between(
            specification,
            start_exclusive=start_exclusive,
            end_inclusive=end_inclusive,
            limit=limit,
        )
        return tuple(
            [
                await self.queue_occurrence(watch_revision_id, occurrence)
                for occurrence in occurrences
            ]
        )
