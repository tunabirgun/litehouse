from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError

from litehouse.domain import Run, RunStatus, Watch, WatchRevision
from litehouse.domain.entities import new_id, utc_now
from litehouse.infrastructure.db.models import RunModel, WatchModel, WatchRevisionModel
from litehouse.infrastructure.db.session import SessionFactory


class WatchNotFoundError(LookupError):
    pass


class ConcurrentRevisionError(RuntimeError):
    pass


class WatchRevisionNotFoundError(LookupError):
    pass


class RunStateConflictError(RuntimeError):
    pass


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class WatchRepository:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    async def create(
        self,
        *,
        name: str,
        specification: Mapping[str, object],
        enabled: bool = True,
    ) -> Watch:
        watch_id = new_id()
        created_at = utc_now()
        revision = WatchRevision(
            watch_id=watch_id,
            revision_number=1,
            specification=specification,
            created_at=created_at,
        )
        watch = Watch(
            id=watch_id,
            name=name,
            enabled=enabled,
            active_revision=revision,
            created_at=created_at,
        )
        async with self._sessions() as session, session.begin():
            watch_row = WatchModel(
                id=watch.id,
                name=watch.name,
                enabled=watch.enabled,
                active_revision_id=None,
                created_at=watch.created_at,
            )
            session.add(watch_row)
            await session.flush()
            session.add(self._revision_row(revision))
            await session.flush()
            watch_row.active_revision_id = revision.id
        return watch

    async def get(self, watch_id: str) -> Watch:
        async with self._sessions() as session:
            watch_row = await session.get(WatchModel, watch_id)
            if watch_row is None or watch_row.active_revision_id is None:
                raise WatchNotFoundError(watch_id)
            revision_row = await session.get(WatchRevisionModel, watch_row.active_revision_id)
            if revision_row is None:
                raise RuntimeError("Watch points to a missing revision.")
            return self._watch(watch_row, revision_row)

    async def list(self) -> Sequence[Watch]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(WatchModel).order_by(WatchModel.created_at, WatchModel.id)
                )
            ).scalars()
            watches: list[Watch] = []
            for watch_row in rows:
                if watch_row.active_revision_id is None:
                    continue
                revision_row = await session.get(WatchRevisionModel, watch_row.active_revision_id)
                if revision_row is None:
                    raise RuntimeError("Watch points to a missing revision.")
                watches.append(self._watch(watch_row, revision_row))
            return watches

    async def list_enabled(self, *, limit: int = 100) -> Sequence[Watch]:
        if limit < 1 or limit > 200:
            raise ValueError("Enabled watch limit must be between 1 and 200.")
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(WatchModel)
                    .where(WatchModel.enabled.is_(True))
                    .order_by(WatchModel.created_at, WatchModel.id)
                    .limit(limit)
                )
            ).scalars()
            watches: list[Watch] = []
            for watch_row in rows:
                if watch_row.active_revision_id is None:
                    continue
                revision_row = await session.get(
                    WatchRevisionModel, watch_row.active_revision_id
                )
                if revision_row is None:
                    raise RuntimeError("Watch points to a missing revision.")
                watches.append(self._watch(watch_row, revision_row))
            return watches

    async def get_revision(self, revision_id: str) -> WatchRevision:
        async with self._sessions() as session:
            row = await session.get(WatchRevisionModel, revision_id)
            if row is None:
                raise WatchRevisionNotFoundError(revision_id)
            return self._revision(row)

    async def update_revision(
        self,
        watch_id: str,
        specification: Mapping[str, object],
        *,
        expected_revision_number: int | None = None,
    ) -> Watch:
        async with self._sessions() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            try:
                watch_row = await session.get(WatchModel, watch_id)
                if watch_row is None or watch_row.active_revision_id is None:
                    raise WatchNotFoundError(watch_id)
                active_row = await session.get(WatchRevisionModel, watch_row.active_revision_id)
                if active_row is None:
                    raise RuntimeError("Watch points to a missing revision.")
                if (
                    expected_revision_number is not None
                    and active_row.revision_number != expected_revision_number
                ):
                    raise ConcurrentRevisionError(watch_id)
                revision = WatchRevision(
                    watch_id=watch_id,
                    revision_number=active_row.revision_number + 1,
                    specification=specification,
                )
                session.add(self._revision_row(revision))
                await session.flush()
                watch_row.active_revision_id = revision.id
                await session.commit()
            except IntegrityError as error:
                await session.rollback()
                raise ConcurrentRevisionError(watch_id) from error
            except BaseException:
                await session.rollback()
                raise
            return Watch(
                id=watch_row.id,
                name=watch_row.name,
                enabled=watch_row.enabled,
                active_revision=revision,
                created_at=_utc(watch_row.created_at),
            )

    async def revisions(self, watch_id: str) -> Sequence[WatchRevision]:
        async with self._sessions() as session:
            exists = await session.get(WatchModel, watch_id)
            if exists is None:
                raise WatchNotFoundError(watch_id)
            rows = (
                await session.execute(
                    select(WatchRevisionModel)
                    .where(WatchRevisionModel.watch_id == watch_id)
                    .order_by(WatchRevisionModel.revision_number)
                )
            ).scalars()
            return [self._revision(row) for row in rows]

    @staticmethod
    def _revision_row(revision: WatchRevision) -> WatchRevisionModel:
        return WatchRevisionModel(
            id=revision.id,
            watch_id=revision.watch_id,
            revision_number=revision.revision_number,
            specification_json=revision.specification_json,
            specification_sha256=revision.specification_sha256,
            created_at=revision.created_at,
        )

    @staticmethod
    def _revision(row: WatchRevisionModel) -> WatchRevision:
        return WatchRevision.restore(
            id=row.id,
            watch_id=row.watch_id,
            revision_number=row.revision_number,
            specification_json=row.specification_json,
            specification_sha256=row.specification_sha256,
            created_at=_utc(row.created_at),
        )

    @classmethod
    def _watch(cls, watch_row: WatchModel, revision_row: WatchRevisionModel) -> Watch:
        return Watch(
            id=watch_row.id,
            name=watch_row.name,
            enabled=watch_row.enabled,
            active_revision=cls._revision(revision_row),
            created_at=_utc(watch_row.created_at),
        )


class RunRepository:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    async def queue(
        self,
        watch_revision_id: str,
        scheduled_at: datetime,
    ) -> tuple[Run, bool]:
        candidate = Run(
            watch_revision_id=watch_revision_id,
            scheduled_at=_utc(scheduled_at),
        )
        async with self._sessions() as session, session.begin():
            revision = await session.get(WatchRevisionModel, watch_revision_id)
            if revision is None:
                raise WatchRevisionNotFoundError(watch_revision_id)
            await session.execute(
                sqlite_insert(RunModel)
                .values(
                    id=candidate.id,
                    watch_revision_id=candidate.watch_revision_id,
                    status=candidate.status.value,
                    scheduled_at=candidate.scheduled_at,
                    created_at=candidate.created_at,
                    available_at=candidate.available_at,
                    started_at=None,
                    finished_at=None,
                    attempt_count=0,
                    report_id=None,
                    result_sha256=None,
                    artifact_count=0,
                    source_error_count=0,
                    error_code=None,
                )
                .on_conflict_do_nothing(
                    index_elements=["watch_revision_id", "scheduled_at"],
                )
            )
            inserted = await session.get(RunModel, candidate.id)
            if inserted is not None:
                return self._run(inserted), True
            existing = await session.scalar(
                select(RunModel).where(
                    RunModel.watch_revision_id == candidate.watch_revision_id,
                    RunModel.scheduled_at == candidate.scheduled_at,
                )
            )
            if existing is None:
                raise RuntimeError("Run idempotency constraint did not return a row.")
            return self._run(existing), False

    async def get(self, run_id: str) -> Run:
        async with self._sessions() as session:
            row = await session.get(RunModel, run_id)
            if row is None:
                raise LookupError(run_id)
            return self._run(row)

    async def latest_scheduled_at(self, watch_revision_id: str) -> datetime | None:
        async with self._sessions() as session:
            value = await session.scalar(
                select(RunModel.scheduled_at)
                .where(RunModel.watch_revision_id == watch_revision_id)
                .order_by(RunModel.scheduled_at.desc())
                .limit(1)
            )
            return _utc(value) if value is not None else None

    async def claim_due(self, now: datetime, *, limit: int) -> Sequence[Run]:
        if limit < 1 or limit > 16:
            raise ValueError("Run claim limit must be between 1 and 16.")
        instant = _utc(now)
        async with self._sessions() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            try:
                rows = list(
                    (
                        await session.execute(
                            select(RunModel)
                            .where(
                                RunModel.status == RunStatus.QUEUED.value,
                                RunModel.scheduled_at <= instant,
                                RunModel.available_at <= instant,
                            )
                            .order_by(RunModel.available_at, RunModel.scheduled_at, RunModel.id)
                            .limit(limit)
                        )
                    ).scalars()
                )
                for row in rows:
                    row.status = RunStatus.RUNNING.value
                    row.started_at = instant
                    row.finished_at = None
                    row.attempt_count += 1
                    row.error_code = None
                await session.commit()
            except BaseException:
                await session.rollback()
                raise
            return [self._run(row) for row in rows]

    async def complete(
        self,
        run_id: str,
        *,
        status: RunStatus,
        finished_at: datetime,
        report_id: str,
        result_sha256: str,
        artifact_count: int,
        source_error_count: int,
    ) -> Run:
        if status not in {RunStatus.SUCCEEDED, RunStatus.PARTIAL}:
            raise ValueError("Completed runs must be succeeded or partial.")
        async with self._sessions() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            try:
                row = await session.get(RunModel, run_id)
                if row is None or row.status != RunStatus.RUNNING.value:
                    raise RunStateConflictError(run_id)
                row.status = status.value
                row.finished_at = _utc(finished_at)
                row.report_id = report_id
                row.result_sha256 = result_sha256
                row.artifact_count = artifact_count
                row.source_error_count = source_error_count
                row.error_code = None
                await session.commit()
            except BaseException:
                await session.rollback()
                raise
            return self._run(row)

    async def retry_or_fail(
        self,
        run_id: str,
        *,
        now: datetime,
        max_attempts: int,
        retryable: bool,
        error_code: str,
    ) -> Run:
        if max_attempts < 1 or max_attempts > 5:
            raise ValueError("Maximum run attempts must be between 1 and 5.")
        instant = _utc(now)
        safe_code = error_code.strip()[:64] or "report_generation_failed"
        async with self._sessions() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            try:
                row = await session.get(RunModel, run_id)
                if row is None or row.status != RunStatus.RUNNING.value:
                    raise RunStateConflictError(run_id)
                if retryable and row.attempt_count < max_attempts:
                    row.status = RunStatus.QUEUED.value
                    row.available_at = instant + timedelta(
                        seconds=min(300, 2 ** row.attempt_count)
                    )
                    row.started_at = None
                    row.error_code = safe_code
                else:
                    row.status = RunStatus.FAILED.value
                    row.finished_at = instant
                    row.error_code = safe_code
                await session.commit()
            except BaseException:
                await session.rollback()
                raise
            return self._run(row)

    async def recover_stale(
        self,
        *,
        stale_before: datetime,
        now: datetime,
        max_attempts: int,
        limit: int = 16,
    ) -> Sequence[Run]:
        threshold = _utc(stale_before)
        instant = _utc(now)
        async with self._sessions() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            try:
                rows = list(
                    (
                        await session.execute(
                            select(RunModel)
                            .where(
                                RunModel.status == RunStatus.RUNNING.value,
                                RunModel.started_at <= threshold,
                            )
                            .order_by(RunModel.started_at, RunModel.id)
                            .limit(limit)
                        )
                    ).scalars()
                )
                for row in rows:
                    if row.attempt_count < max_attempts:
                        row.status = RunStatus.QUEUED.value
                        row.available_at = instant
                        row.started_at = None
                    else:
                        row.status = RunStatus.FAILED.value
                        row.finished_at = instant
                    row.error_code = "worker_lease_expired"
                await session.commit()
            except BaseException:
                await session.rollback()
                raise
            return [self._run(row) for row in rows]

    async def list(
        self,
        *,
        watch_id: str | None = None,
        limit: int = 100,
    ) -> Sequence[Run]:
        if limit < 1 or limit > 200:
            raise ValueError("Run list limit must be between 1 and 200.")
        statement = select(RunModel)
        if watch_id is not None:
            statement = statement.join(
                WatchRevisionModel,
                RunModel.watch_revision_id == WatchRevisionModel.id,
            ).where(WatchRevisionModel.watch_id == watch_id)
        statement = statement.order_by(RunModel.scheduled_at.desc(), RunModel.id).limit(limit)
        async with self._sessions() as session:
            rows = (await session.execute(statement)).scalars()
            return [self._run(row) for row in rows]

    @staticmethod
    def _run(row: RunModel) -> Run:
        return Run(
            id=row.id,
            watch_revision_id=row.watch_revision_id,
            status=RunStatus(row.status),
            scheduled_at=_utc(row.scheduled_at),
            created_at=_utc(row.created_at),
            available_at=_utc(row.available_at),
            started_at=_utc(row.started_at) if row.started_at is not None else None,
            finished_at=_utc(row.finished_at) if row.finished_at is not None else None,
            attempt_count=row.attempt_count,
            report_id=row.report_id,
            result_sha256=row.result_sha256,
            artifact_count=row.artifact_count,
            source_error_count=row.source_error_count,
        )
