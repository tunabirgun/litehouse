from __future__ import annotations

import asyncio
import json
import socket
import sys
from collections.abc import Coroutine
from typing import Any

import uvicorn

from litehouse.config import get_settings
from litehouse.interfaces.http.app import app as http_app


async def _shutdown_on_stdin(server: uvicorn.Server) -> None:
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line or line.strip() == "shutdown":
            server.should_exit = True
            return


async def _serve() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(2048)
    listener.setblocking(False)
    port = listener.getsockname()[1]

    config = uvicorn.Config(
        http_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        proxy_headers=False,
        server_header=False,
        workers=1,
    )
    server = uvicorn.Server(config)
    shutdown_task = asyncio.create_task(_shutdown_on_stdin(server))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        while not server.started and not server_task.done():  # noqa: ASYNC110
            await asyncio.sleep(0.01)
        if server_task.done():
            await server_task
        print(json.dumps({"event": "ready", "port": port}, separators=(",", ":")), flush=True)
        await server_task
    finally:
        shutdown_task.cancel()
        await asyncio.gather(shutdown_task, return_exceptions=True)
        listener.close()


def main() -> None:
    settings = get_settings()
    if settings.api_host != "127.0.0.1":
        raise RuntimeError("The desktop sidecar must bind to IPv4 loopback.")
    runner: Coroutine[Any, Any, None] = _serve()
    asyncio.run(runner)


if __name__ == "__main__":
    main()
