from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import urlsplit

_MODEL_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


class EndpointKind(StrEnum):
    LLAMA_CPP_LOCAL = "llama_cpp_local"
    OPENAI_COMPATIBLE_LOCAL = "openai_compatible_local"
    PAID_PROVIDER = "paid_provider"


class EndpointProtocol(StrEnum):
    OPENAI_COMPATIBLE = "openai_compatible"
    ANTHROPIC_MESSAGES = "anthropic_messages"
    GEMINI_GENERATE_CONTENT = "gemini_generate_content"


_PROTOCOL_BASE_PATHS = {
    EndpointProtocol.OPENAI_COMPATIBLE: "/v1",
    EndpointProtocol.ANTHROPIC_MESSAGES: "/v1",
    EndpointProtocol.GEMINI_GENERATE_CONTENT: "/v1beta",
}


@dataclass(frozen=True, slots=True)
class SecretReference:
    reference: str

    def __post_init__(self) -> None:
        if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{2,127}", self.reference) is None:
            raise ValueError("secret reference must be an opaque keychain identifier")


@dataclass(frozen=True, slots=True)
class ModelEndpointConfig:
    kind: EndpointKind
    protocol: EndpointProtocol
    base_url: str
    model: str
    display_name: str
    secret_ref: SecretReference | None = None

    def __post_init__(self) -> None:
        if _MODEL_NAME_PATTERN.fullmatch(self.model) is None:
            raise ValueError("model must be a canonical provider model identifier")
        if not self.display_name.strip() or _has_control_character(self.display_name):
            raise ValueError("display_name must be non-empty and contain no control characters")
        if self.base_url != self.base_url.strip() or _has_control_character(self.base_url):
            raise ValueError("base_url must be canonical")
        parsed = urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("credentials must never be embedded in base_url")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain query parameters or fragments")
        if parsed.path != _PROTOCOL_BASE_PATHS[self.protocol]:
            raise ValueError(
                f"{self.protocol.value} base_url must use exact path "
                f"{_PROTOCOL_BASE_PATHS[self.protocol]}"
            )

        if self.kind is EndpointKind.PAID_PROVIDER:
            if parsed.scheme != "https":
                raise ValueError("paid provider endpoints must use HTTPS")
            if parsed.port not in (None, 443):
                raise ValueError("paid provider endpoints must use port 443")
            if not _is_public_host_syntax(parsed.hostname):
                raise ValueError("paid provider endpoints must use a public host")
            if self.secret_ref is None:
                raise ValueError("paid provider endpoints require an opaque secret reference")
            if (
                self.protocol is EndpointProtocol.ANTHROPIC_MESSAGES
                and parsed.hostname != "api.anthropic.com"
            ):
                raise ValueError("Anthropic Messages must use the official API host")
            if (
                self.protocol is EndpointProtocol.GEMINI_GENERATE_CONTENT
                and parsed.hostname != "generativelanguage.googleapis.com"
            ):
                raise ValueError("Gemini generateContent must use the official API host")
        else:
            if self.protocol is not EndpointProtocol.OPENAI_COMPATIBLE:
                raise ValueError("local model endpoints must use the OpenAI-compatible protocol")
            if not _is_local_host(parsed.hostname):
                raise ValueError("local endpoints must use loopback, private IP, or .local host")
            if self.kind is EndpointKind.LLAMA_CPP_LOCAL and not _is_loopback(parsed.hostname):
                raise ValueError("the bundled llama.cpp sidecar contract is loopback-only")

    @classmethod
    def default_llama_cpp(cls, model: str = "Qwen3-4B") -> ModelEndpointConfig:
        return cls(
            kind=EndpointKind.LLAMA_CPP_LOCAL,
            protocol=EndpointProtocol.OPENAI_COMPATIBLE,
            base_url="http://127.0.0.1:8080/v1",
            model=model,
            display_name="Local llama.cpp",
        )

    def public_metadata(self) -> dict[str, str | None]:
        return {
            "kind": self.kind.value,
            "protocol": self.protocol.value,
            "base_url": self.base_url,
            "model": self.model,
            "display_name": self.display_name,
            "secret_reference": self.secret_ref.reference if self.secret_ref else None,
        }

    @property
    def request_url(self) -> str:
        if self.protocol is EndpointProtocol.OPENAI_COMPATIBLE:
            return f"{self.base_url}/chat/completions"
        if self.protocol is EndpointProtocol.ANTHROPIC_MESSAGES:
            return f"{self.base_url}/messages"
        return f"{self.base_url}/models/{self.model}:generateContent"


def _has_control_character(value: str) -> bool:
    return any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_local_host(host: str) -> bool:
    normalized = host.lower().rstrip(".")
    if normalized == "localhost" or normalized.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    if address.is_unspecified or address.is_multicast or address.is_reserved:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def _is_public_host_syntax(host: str) -> bool:
    normalized = host.lower().rstrip(".")
    if normalized == "localhost" or normalized.endswith(".local"):
        return False
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return "." in normalized
    return (
        address.is_global
        and not address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
    )
