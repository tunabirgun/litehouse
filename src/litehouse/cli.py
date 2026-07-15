from __future__ import annotations

import typer
import uvicorn

from litehouse.config import get_settings

app = typer.Typer(no_args_is_help=True, help="Litehouse local research engine.")


@app.command()
def serve() -> None:
    """Run the loopback API."""
    settings = get_settings()
    if settings.api_host not in {"127.0.0.1", "localhost"}:
        raise typer.BadParameter("Litehouse local mode must bind to loopback.")
    uvicorn.run(
        "litehouse.interfaces.http.app:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level="info",
        proxy_headers=False,
        server_header=False,
        workers=1,
    )


if __name__ == "__main__":
    app()
