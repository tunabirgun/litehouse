from __future__ import annotations

from typing import Annotated, Self

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, SecretStr, StringConstraints

from litehouse.interfaces.http.provider_settings_service import (
    CredentialState,
    ProviderChoice,
    ProviderConfiguration,
    ProviderSettingsError,
    ProviderSettingsService,
    ProviderSettingsSnapshot,
)

ProviderModel = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$"),
]
ProviderUrl = Annotated[str, StringConstraints(min_length=1, max_length=2048)]
ProviderDisplayName = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class ProviderSettingsContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProviderConfigurationRequest(ProviderSettingsContract):
    provider: ProviderChoice
    base_url: ProviderUrl | None = None
    model: ProviderModel | None = None
    display_name: ProviderDisplayName | None = None

    def to_domain(self) -> ProviderConfiguration:
        if self.provider is ProviderChoice.INTEGRATED:
            if any(value is not None for value in (self.base_url, self.model, self.display_name)):
                raise ValueError("integrated provider configuration has no user endpoint fields")
            return ProviderConfiguration.integrated()
        if self.base_url is None or self.model is None or self.display_name is None:
            raise ValueError("provider endpoint fields are required")
        return ProviderConfiguration(
            provider=self.provider,
            base_url=self.base_url,
            model=self.model,
            display_name=self.display_name,
        )


class ProviderSecretRequest(ProviderSettingsContract):
    provider: ProviderChoice
    # Bounds are checked after SecretStr has masked repr/serialization so validation
    # responses can never echo the submitted credential.
    secret: SecretStr


class ProviderSecretDeleteRequest(ProviderSettingsContract):
    provider: ProviderChoice


class ProviderSettingsResponse(ProviderSettingsContract):
    provider: ProviderChoice
    protocol: str | None
    base_url: str | None
    model: str | None
    display_name: str
    configuration_valid: bool
    credential_state: CredentialState

    @classmethod
    def from_snapshot(cls, snapshot: ProviderSettingsSnapshot) -> Self:
        configuration = snapshot.configuration
        protocol = (
            None
            if configuration.provider is ProviderChoice.INTEGRATED
            else configuration.endpoint_config().protocol.value
        )
        return cls(
            provider=configuration.provider,
            protocol=protocol,
            base_url=configuration.base_url or None,
            model=configuration.model or None,
            display_name=configuration.display_name,
            configuration_valid=snapshot.configuration_valid,
            credential_state=snapshot.credential_state,
        )


def _service(request: Request) -> ProviderSettingsService:
    service: ProviderSettingsService = request.app.state.provider_settings_service
    return service


def _http_error(error: ProviderSettingsError) -> HTTPException:
    if error.code == "provider_not_selected":
        status_code = status.HTTP_409_CONFLICT
    elif error.code.startswith("credential_store") or error.retryable:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    else:
        status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    return HTTPException(status_code=status_code, detail=error.safe_message)


def create_provider_settings_router() -> APIRouter:
    router = APIRouter(prefix="/v1/model-provider", tags=["models"])

    @router.get("", response_model=ProviderSettingsResponse)
    async def get_provider_settings(request: Request) -> ProviderSettingsResponse:
        return ProviderSettingsResponse.from_snapshot(await _service(request).snapshot())

    @router.post("/config", response_model=ProviderSettingsResponse)
    async def configure_provider(
        payload: ProviderConfigurationRequest,
        request: Request,
    ) -> ProviderSettingsResponse:
        try:
            configuration = payload.to_domain()
            snapshot = await _service(request).configure(configuration)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The model provider configuration is invalid.",
            ) from None
        except ProviderSettingsError as error:
            raise _http_error(error) from None
        return ProviderSettingsResponse.from_snapshot(snapshot)

    @router.post("/secret", response_model=ProviderSettingsResponse)
    async def store_provider_secret(
        payload: ProviderSecretRequest,
        request: Request,
    ) -> ProviderSettingsResponse:
        try:
            snapshot = await _service(request).set_secret(
                payload.provider,
                payload.secret.get_secret_value(),
            )
        except ProviderSettingsError as error:
            raise _http_error(error) from None
        return ProviderSettingsResponse.from_snapshot(snapshot)

    @router.post("/secret/delete", response_model=ProviderSettingsResponse)
    async def delete_provider_secret(
        payload: ProviderSecretDeleteRequest,
        request: Request,
    ) -> ProviderSettingsResponse:
        try:
            snapshot = await _service(request).delete_secret(payload.provider)
        except ProviderSettingsError as error:
            raise _http_error(error) from None
        return ProviderSettingsResponse.from_snapshot(snapshot)

    return router
