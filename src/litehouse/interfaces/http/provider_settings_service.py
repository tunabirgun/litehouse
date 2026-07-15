from __future__ import annotations

import asyncio
import json
import os
import secrets
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol, cast

import keyring
from keyring.errors import KeyringError, PasswordDeleteError

from litehouse.domain import canonical_json
from litehouse.infrastructure.models.endpoints import (
    EndpointKind,
    EndpointProtocol,
    ModelEndpointConfig,
    SecretReference,
)
from litehouse.infrastructure.models.providers import (
    EvidenceSynthesisClient as ProviderEvidenceSynthesisClient,
)
from litehouse.infrastructure.models.providers import SecretResolver, SynthesisRequest
from litehouse.interfaces.http.local_model_service import (
    LocalModelRuntimeService,
    parse_report_evidence_prompt,
)

_CONFIG_VERSION = 1
_CREDENTIAL_SERVICE = "dev.litehouse.model-providers"
_MAX_CONFIG_BYTES = 64 * 1024
_MAX_SECRET_CHARACTERS = 8192


class ProviderSettingsError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = retryable


class ProviderChoice(StrEnum):
    INTEGRATED = "integrated"
    LOCAL_COMPATIBLE = "local-compatible"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    CUSTOM = "custom"

    @property
    def requires_secret(self) -> bool:
        return self in {
            ProviderChoice.OPENAI,
            ProviderChoice.ANTHROPIC,
            ProviderChoice.GEMINI,
            ProviderChoice.CUSTOM,
        }


class CredentialState(StrEnum):
    NOT_REQUIRED = "not_required"
    STORED = "stored"
    MISSING = "missing"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class ProviderConfiguration:
    provider: ProviderChoice
    base_url: str
    model: str
    display_name: str

    def __post_init__(self) -> None:
        if self.provider is ProviderChoice.INTEGRATED:
            if self.base_url or self.model:
                raise ValueError("integrated provider configuration must not include an endpoint")
            if self.display_name != "Integrated llama.cpp":
                raise ValueError("integrated provider display name is fixed")
            return
        self.endpoint_config()

    @classmethod
    def integrated(cls) -> ProviderConfiguration:
        return cls(
            provider=ProviderChoice.INTEGRATED,
            base_url="",
            model="",
            display_name="Integrated llama.cpp",
        )

    @property
    def secret_reference(self) -> SecretReference | None:
        if not self.provider.requires_secret:
            return None
        return SecretReference(f"litehouse.provider.{self.provider.value}.primary")

    def endpoint_config(self) -> ModelEndpointConfig:
        if self.provider is ProviderChoice.INTEGRATED:
            raise ValueError("the integrated provider endpoint is managed by its verified runtime")
        secret_ref = self.secret_reference
        if self.provider is ProviderChoice.LOCAL_COMPATIBLE:
            kind = EndpointKind.OPENAI_COMPATIBLE_LOCAL
            protocol = EndpointProtocol.OPENAI_COMPATIBLE
        elif self.provider is ProviderChoice.ANTHROPIC:
            kind = EndpointKind.PAID_PROVIDER
            protocol = EndpointProtocol.ANTHROPIC_MESSAGES
        elif self.provider is ProviderChoice.GEMINI:
            kind = EndpointKind.PAID_PROVIDER
            protocol = EndpointProtocol.GEMINI_GENERATE_CONTENT
        else:
            kind = EndpointKind.PAID_PROVIDER
            protocol = EndpointProtocol.OPENAI_COMPATIBLE
        endpoint = ModelEndpointConfig(
            kind=kind,
            protocol=protocol,
            base_url=self.base_url,
            model=self.model,
            display_name=self.display_name,
            secret_ref=secret_ref,
        )
        if self.provider is ProviderChoice.OPENAI and self.base_url != "https://api.openai.com/v1":
            raise ValueError("OpenAI must use the official API endpoint")
        return endpoint


@dataclass(frozen=True, slots=True)
class ProviderSettingsSnapshot:
    configuration: ProviderConfiguration
    configuration_valid: bool
    credential_state: CredentialState


class CredentialStore(SecretResolver, Protocol):
    async def status(self, reference: SecretReference) -> CredentialState: ...

    async def set(self, reference: SecretReference, secret: str) -> None: ...

    async def delete(self, reference: SecretReference) -> None: ...


class KeyringCredentialStore:
    """OS credential-store adapter with no plaintext fallback."""

    async def status(self, reference: SecretReference) -> CredentialState:
        try:
            secret = await asyncio.to_thread(self._get, reference)
        except ProviderSettingsError:
            return CredentialState.UNAVAILABLE
        return CredentialState.STORED if secret is not None else CredentialState.MISSING

    async def set(self, reference: SecretReference, secret: str) -> None:
        _validate_secret(secret)
        await asyncio.to_thread(self._set, reference, secret)

    async def delete(self, reference: SecretReference) -> None:
        await asyncio.to_thread(self._delete, reference)

    async def resolve(self, reference: SecretReference) -> str:
        secret = await asyncio.to_thread(self._get, reference)
        if secret is None:
            raise ProviderSettingsError(
                "credential_missing",
                "The model provider credential has not been stored.",
            )
        return secret

    @staticmethod
    def _require_secure_backend() -> None:
        try:
            backend = keyring.get_keyring()
            priority = float(backend.priority)
            module = type(backend).__module__
        except Exception:
            raise ProviderSettingsError(
                "credential_store_unavailable",
                "The operating-system credential store is unavailable.",
                retryable=True,
            ) from None
        if priority < 1 or module in {"keyring.backends.fail", "keyring.backends.null"}:
            raise ProviderSettingsError(
                "credential_store_unavailable",
                "The operating-system credential store is unavailable.",
                retryable=True,
            )

    @classmethod
    def _get(cls, reference: SecretReference) -> str | None:
        cls._require_secure_backend()
        try:
            return keyring.get_password(_CREDENTIAL_SERVICE, reference.reference)
        except KeyringError:
            raise ProviderSettingsError(
                "credential_store_unavailable",
                "The operating-system credential store is unavailable.",
                retryable=True,
            ) from None

    @classmethod
    def _set(cls, reference: SecretReference, secret: str) -> None:
        cls._require_secure_backend()
        try:
            keyring.set_password(_CREDENTIAL_SERVICE, reference.reference, secret)
        except KeyringError:
            raise ProviderSettingsError(
                "credential_store_unavailable",
                "The operating-system credential store refused the credential.",
                retryable=True,
            ) from None

    @classmethod
    def _delete(cls, reference: SecretReference) -> None:
        cls._require_secure_backend()
        try:
            keyring.delete_password(_CREDENTIAL_SERVICE, reference.reference)
        except PasswordDeleteError:
            # Deleting a credential that no longer exists is an idempotent success.
            if cls._get(reference) is None:
                return
            raise ProviderSettingsError(
                "credential_delete_failed",
                "The operating-system credential store refused the deletion.",
                retryable=True,
            ) from None
        except KeyringError:
            raise ProviderSettingsError(
                "credential_store_unavailable",
                "The operating-system credential store is unavailable.",
                retryable=True,
            ) from None


class ProviderReportSynthesisHook:
    def __init__(self, service: ProviderSettingsService) -> None:
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


class ProviderSettingsService:
    def __init__(
        self,
        *,
        config_path: Path,
        local_model: LocalModelRuntimeService,
        credentials: CredentialStore | None = None,
    ) -> None:
        expanded = config_path.expanduser()
        self._config_path = expanded.parent.resolve() / expanded.name
        self._local_model = local_model
        self._credentials = credentials or KeyringCredentialStore()
        self._lock = asyncio.Lock()
        self._configuration, self._configuration_valid = self._load_configuration()

    async def snapshot(self) -> ProviderSettingsSnapshot:
        async with self._lock:
            configuration = self._configuration
            configuration_valid = self._configuration_valid
        credential_state = await self._credential_state(configuration)
        return ProviderSettingsSnapshot(
            configuration=configuration,
            configuration_valid=configuration_valid,
            credential_state=credential_state,
        )

    async def configure(self, configuration: ProviderConfiguration) -> ProviderSettingsSnapshot:
        async with self._lock:
            await asyncio.to_thread(self._persist_configuration, configuration)
            self._configuration = configuration
            self._configuration_valid = True
        return await self.snapshot()

    async def set_secret(self, provider: ProviderChoice, secret: str) -> ProviderSettingsSnapshot:
        _validate_secret(secret)
        configuration = await self._require_selected(provider)
        reference = configuration.secret_reference
        if reference is None:
            raise ProviderSettingsError(
                "credential_not_required",
                "The selected provider does not use a stored credential.",
            )
        await self._credentials.set(reference, secret)
        return await self.snapshot()

    async def delete_secret(self, provider: ProviderChoice) -> ProviderSettingsSnapshot:
        configuration = await self._require_selected(provider)
        reference = configuration.secret_reference
        if reference is None:
            raise ProviderSettingsError(
                "credential_not_required",
                "The selected provider does not use a stored credential.",
            )
        await self._credentials.delete(reference)
        return await self.snapshot()

    async def evidence_client(self) -> ProviderEvidenceSynthesisClient:
        async with self._lock:
            configuration = self._configuration
            configuration_valid = self._configuration_valid
        if not configuration_valid:
            raise ProviderSettingsError(
                "provider_configuration_invalid",
                "The model provider configuration is invalid.",
            )
        if configuration.provider is ProviderChoice.INTEGRATED:
            return await self._local_model.evidence_client()
        endpoint = configuration.endpoint_config()
        return ProviderEvidenceSynthesisClient(
            endpoint,
            secret_resolver=self._credentials if endpoint.secret_ref is not None else None,
        )

    def report_synthesis_client(self) -> ProviderReportSynthesisHook:
        return ProviderReportSynthesisHook(self)

    async def _require_selected(self, provider: ProviderChoice) -> ProviderConfiguration:
        async with self._lock:
            configuration = self._configuration
        if configuration.provider is not provider:
            raise ProviderSettingsError(
                "provider_not_selected",
                "Configure and select the provider before changing its credential.",
            )
        return configuration

    async def _credential_state(
        self, configuration: ProviderConfiguration
    ) -> CredentialState:
        reference = configuration.secret_reference
        if reference is None:
            return CredentialState.NOT_REQUIRED
        return await self._credentials.status(reference)

    def _load_configuration(self) -> tuple[ProviderConfiguration, bool]:
        if not self._config_path.exists():
            return ProviderConfiguration.integrated(), True
        try:
            if self._config_path.is_symlink():
                raise ValueError("configuration file must not be a symbolic link")
            encoded = self._config_path.read_bytes()
            if len(encoded) > _MAX_CONFIG_BYTES:
                raise ValueError("provider configuration exceeds the size limit")
            raw: object = json.loads(encoded)
            if not isinstance(raw, dict) or set(raw) != {
                "version",
                "provider",
                "base_url",
                "model",
                "display_name",
            }:
                raise ValueError("provider configuration shape is invalid")
            document = cast(dict[str, object], raw)
            if document["version"] != _CONFIG_VERSION:
                raise ValueError("provider configuration version is invalid")
            configuration = ProviderConfiguration(
                provider=ProviderChoice(str(document["provider"])),
                base_url=_require_string(document["base_url"]),
                model=_require_string(document["model"]),
                display_name=_require_string(document["display_name"]),
            )
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return ProviderConfiguration.integrated(), False
        return configuration, True

    def _persist_configuration(self, configuration: ProviderConfiguration) -> None:
        directory = self._config_path.parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or self._config_path.is_symlink():
            raise ProviderSettingsError(
                "provider_configuration_write_failed",
                "The provider configuration could not be saved safely.",
            )
        payload = (
            canonical_json(
                {
                    "base_url": configuration.base_url,
                    "display_name": configuration.display_name,
                    "model": configuration.model,
                    "provider": configuration.provider.value,
                    "version": _CONFIG_VERSION,
                }
            )
            + "\n"
        ).encode("utf-8")
        temporary = directory / f".{self._config_path.name}.{secrets.token_hex(8)}.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(temporary, flags, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._config_path)
            try:
                self._config_path.chmod(0o600)
            except OSError:
                if os.name != "nt":
                    raise
            _fsync_directory(directory)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise ProviderSettingsError(
                "provider_configuration_write_failed",
                "The provider configuration could not be saved safely.",
            ) from None


def _validate_secret(secret: str) -> None:
    if (
        not secret
        or len(secret) > _MAX_SECRET_CHARACTERS
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in secret)
    ):
        raise ProviderSettingsError(
            "credential_invalid",
            "The model provider credential is invalid.",
        )


def _require_string(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("provider configuration value must be a string")
    return value


def _fsync_directory(directory: Path) -> None:
    if not hasattr(os, "O_DIRECTORY"):
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)
