from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, StringConstraints

from litehouse.config import Settings
from litehouse.infrastructure.vault.paths import VaultPathError
from litehouse.infrastructure.vault.pointer import VaultPointerError, write_vault_pointer
from litehouse.infrastructure.vault.relocation import VaultRelocationError, relocate_vault
from litehouse.infrastructure.vault.store import VaultBlobStore

AbsolutePathText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=4_096),
]


class VaultRelocationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    destination_root: AbsolutePathText
    confirmed: Literal[True]


class VaultRelocationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_root: str
    destination_root: str
    files_verified: int
    bytes_verified: int
    source_preserved: Literal[True] = True
    restart_required: Literal[True] = True


async def _stop_background_writer(request: Request) -> None:
    worker = getattr(request.app.state, "report_worker", None)
    task: asyncio.Task[None] | None = getattr(
        request.app.state,
        "report_worker_task",
        None,
    )
    if worker is None or task is None or task.done():
        return
    worker.stop()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=5)
    except TimeoutError:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def _restart_background_writer(request: Request) -> None:
    if not getattr(request.app.state, "scheduler_enabled", False):
        return
    factory = request.app.state.report_worker_factory
    worker = factory()
    task = asyncio.create_task(
        worker.run(poll_seconds=request.app.state.report_worker_poll_seconds),
        name="litehouse-report-worker",
    )
    request.app.state.report_worker = worker
    request.app.state.report_worker_task = task


def create_vault_relocation_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/v1/system/vault", tags=["system"])

    @router.post(
        "/relocate",
        response_model=VaultRelocationResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def relocate(
        payload: VaultRelocationRequest,
        request: Request,
    ) -> VaultRelocationResponse:
        if request.url.query:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Request validation failed.",
            )
        lifecycle_lock: asyncio.Lock = request.app.state.vault_lifecycle_lock
        async with lifecycle_lock:
            if request.app.state.vault_relocation_maintenance:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A vault relocation already requires an application restart.",
                )
            request.app.state.vault_relocation_maintenance = True
            await _stop_background_writer(request)
            blobs: VaultBlobStore = request.app.state.library_blobs
            source = blobs.root
            pointer_path = settings.data_dir.resolve() / "config" / "vault-pointer.json"

            def switch_pointer(destination: Path) -> None:
                write_vault_pointer(
                    pointer_path,
                    active_vault_root=destination,
                    previous_vault_root=source.path,
                )

            try:
                result = await asyncio.to_thread(
                    relocate_vault,
                    source,
                    Path(payload.destination_root),
                    switch_pointer=switch_pointer,
                )
            except (VaultRelocationError, VaultPathError, VaultPointerError):
                request.app.state.vault_relocation_maintenance = False
                _restart_background_writer(request)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "Vault relocation failed safely. The source vault remains active and "
                        "was not deleted."
                    ),
                ) from None
            return VaultRelocationResponse(
                source_root=str(result.source_root),
                destination_root=str(result.destination_root),
                files_verified=result.files_verified,
                bytes_verified=result.bytes_copied,
            )

    return router
