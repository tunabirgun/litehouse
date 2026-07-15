from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Protocol

from alembic import command
from alembic.config import Config
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from litehouse.infrastructure.db.models import Base

type SessionFactory = async_sessionmaker[AsyncSession]


class _Cursor(Protocol):
    def execute(self, statement: str) -> object: ...

    def close(self) -> None: ...


class _DBAPIConnection(Protocol):
    def cursor(self) -> _Cursor: ...


def create_sqlite_engine(database_path: Path, *, echo: bool = False) -> AsyncEngine:
    path = database_path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}", echo=echo)

    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(
        dbapi_connection: _DBAPIConnection,
        _connection_record: object,
    ) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()

    return engine


def create_session_factory(engine: AsyncEngine) -> SessionFactory:
    return async_sessionmaker(engine, expire_on_commit=False)


def _migration_directory() -> Path:
    candidates: list[Path] = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if isinstance(bundle_root, str):
        candidates.append(Path(bundle_root) / "migrations")
    package_root = Path(__file__).resolve().parents[2]
    candidates.extend(
        (
            package_root / "_migrations",
            Path(__file__).resolve().parents[4] / "migrations",
        )
    )
    for candidate in candidates:
        if (candidate / "env.py").is_file() and (candidate / "versions").is_dir():
            return candidate
    raise RuntimeError("The signed database migration bundle is unavailable.")


def _upgrade_database(url: str, migration_directory: Path) -> None:
    configuration = Config()
    configuration.set_main_option("script_location", str(migration_directory))
    configuration.set_main_option("sqlalchemy.url", url)
    command.upgrade(configuration, "head")


async def init_database(engine: AsyncEngine) -> None:
    await asyncio.to_thread(
        _upgrade_database,
        engine.url.render_as_string(hide_password=False),
        _migration_directory(),
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
