from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict

from litehouse.config import Settings
from litehouse.infrastructure.reports.latex import (
    TectonicConfirmationRequiredError,
    TectonicPlatformUnsupportedError,
    TectonicRuntimeError,
    install_tectonic_runtime,
    tectonic_runtime_status,
)


class TectonicInstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    confirmed: bool


def latex_runtime_router() -> APIRouter:
    router = APIRouter(prefix="/v1/system/latex-runtime", tags=["system"])

    @router.get("")
    async def runtime_status(request: Request) -> dict[str, object]:
        settings: Settings = request.app.state.settings
        result = await asyncio.to_thread(tectonic_runtime_status, settings.data_dir)
        return result.to_dict()

    @router.post("")
    async def install_runtime(
        payload: TectonicInstallRequest,
        request: Request,
    ) -> dict[str, object]:
        settings: Settings = request.app.state.settings
        try:
            result = await asyncio.to_thread(
                install_tectonic_runtime,
                settings.data_dir,
                confirmed=payload.confirmed,
            )
        except TectonicConfirmationRequiredError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Explicit confirmation is required before downloading the compiler.",
            ) from None
        except TectonicPlatformUnsupportedError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="No verified Tectonic runtime is published for this platform.",
            ) from None
        except TectonicRuntimeError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="The verified Tectonic runtime could not be installed.",
            ) from None
        return result.to_dict()

    return router
