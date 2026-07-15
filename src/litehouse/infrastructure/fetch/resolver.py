from __future__ import annotations

import asyncio
import socket
from typing import Protocol


class ResolutionError(RuntimeError):
    """Raised when an official source cannot be resolved safely."""


class Resolver(Protocol):
    async def resolve(self, host: str, port: int) -> tuple[str, ...]: ...


class SystemResolver:
    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        loop = asyncio.get_running_loop()
        try:
            answers = await loop.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        except OSError as error:
            raise ResolutionError("Official source DNS resolution failed.") from error

        addresses = tuple(dict.fromkeys(str(answer[4][0]) for answer in answers))
        if not addresses:
            raise ResolutionError("Official source DNS resolution returned no addresses.")
        return addresses
