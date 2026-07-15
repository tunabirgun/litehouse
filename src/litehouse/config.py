from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LITEHOUSE_",
        env_file=".env",
        extra="ignore",
    )

    api_host: str = "127.0.0.1"
    api_port: int = Field(default=8765, ge=1024, le=65535)
    data_dir: Path = Path("var")
    vault_root: Path | None = None
    database_name: str = "litehouse.sqlite3"
    development_mode: bool = False
    scheduler_enabled: bool = True
    scheduler_poll_seconds: float = Field(default=15.0, ge=0.1, le=3600)
    scheduler_concurrency: int = Field(default=2, ge=1, le=4)
    scheduler_catch_up_runs: int = Field(default=4, ge=1, le=24)
    scheduler_catch_up_hours: int = Field(default=24, ge=1, le=168)
    scheduler_run_max_attempts: int = Field(default=3, ge=1, le=5)
    scheduler_lease_seconds: int = Field(default=300, ge=30, le=3600)
    session_token: SecretStr = Field(
        default_factory=lambda: SecretStr(secrets.token_urlsafe(32)),
    )
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost")
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    )

    @field_validator("api_host")
    @classmethod
    def validate_api_host(cls, value: str) -> str:
        if value not in _LOOPBACK_HOSTS:
            raise ValueError("The local API must bind to a loopback host.")
        return value

    @field_validator("session_token")
    @classmethod
    def validate_session_token(cls, value: SecretStr) -> SecretStr:
        token = value.get_secret_value()
        if (
            len(token) < 32
            or not token.isascii()
            or any(character.isspace() for character in token)
        ):
            raise ValueError("The session token must be a 32-character or longer ASCII token.")
        return value

    @field_validator("allowed_hosts")
    @classmethod
    def validate_allowed_hosts(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if not values or any(value not in _LOOPBACK_HOSTS for value in values):
            raise ValueError("Allowed hosts must be explicit loopback host names.")
        if len(set(values)) != len(values):
            raise ValueError("Allowed hosts must be unique.")
        return values

    @field_validator("allowed_origins")
    @classmethod
    def validate_allowed_origins(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(values)) != len(values):
            raise ValueError("Allowed origins must be unique.")
        for value in values:
            parsed = urlsplit(value)
            if (
                parsed.scheme not in {"http", "https", "tauri"}
                or parsed.hostname not in _LOOPBACK_HOSTS
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("Allowed origins must be exact loopback origins.")
        return values

    @property
    def database_path(self) -> Path:
        return self.data_dir / self.database_name

    @property
    def reports_path(self) -> Path:
        return self.data_dir / "reports"

    @property
    def vault_path(self) -> Path:
        return self.vault_root if self.vault_root is not None else self.data_dir / "vault"


@lru_cache
def get_settings() -> Settings:
    return Settings()
