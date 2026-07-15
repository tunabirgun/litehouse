from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import queue
import secrets
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path

from litehouse.infrastructure.db.session import (
    create_session_factory,
    create_sqlite_engine,
    init_database,
)
from litehouse.infrastructure.vault.models import (
    ArtifactKind,
    ArtifactSource,
    LibraryItemKind,
)
from litehouse.infrastructure.vault.paths import VaultRoot
from litehouse.infrastructure.vault.repository import VaultRepository
from litehouse.infrastructure.vault.store import VaultBlobStore

ROOT = Path(__file__).resolve().parents[1]


async def _seed_reader_fixture(data_dir: Path) -> tuple[str, str, bytes, str]:
    pdf = b"%PDF-1.4\n% Litehouse packaged reader fixture\n%%EOF\n"
    engine = create_sqlite_engine(data_dir / "litehouse.sqlite3")
    try:
        await init_database(engine)
        repository = VaultRepository(
            create_session_factory(engine),
            VaultBlobStore(VaultRoot.from_user_path(data_dir / "vault")),
        )
        item = await repository.add_library_item(
            title="Packaged reader smoke fixture",
            kind=LibraryItemKind.IMPORT,
        )
        artifact = await repository.add_artifact_bytes(
            library_item_id=item.id,
            kind=ArtifactKind.ARTICLE_PDF,
            media_type="application/pdf",
            content=pdf,
            source=ArtifactSource(name="Litehouse smoke fixture"),
        )
        return item.id, artifact.id, pdf, hashlib.sha256(pdf).hexdigest()
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test a target-native Litehouse sidecar.")
    parser.add_argument("--target", required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    extension = ".exe" if os.name == "nt" else ""
    binary = ROOT / "src-tauri" / "binaries" / f"litehouse-backend-{args.target}{extension}"
    data_dir = args.data_dir.expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    item_id, artifact_id, expected_pdf, expected_sha256 = asyncio.run(
        _seed_reader_fixture(data_dir)
    )

    environment = {
        name: value
        for name, value in os.environ.items()
        if name
        in {
            "DBUS_SESSION_BUS_ADDRESS",
            "HOME",
            "LANG",
            "LC_ALL",
            "LOCALAPPDATA",
            "PATH",
            "SSL_CERT_DIR",
            "SSL_CERT_FILE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "TMPDIR",
            "USERPROFILE",
            "WINDIR",
            "XDG_RUNTIME_DIR",
        }
    }
    session_token = secrets.token_urlsafe(32)
    environment.update(
        {
            "LITEHOUSE_API_HOST": "127.0.0.1",
            "LITEHOUSE_DATA_DIR": str(data_dir),
            "LITEHOUSE_SESSION_TOKEN": session_token,
            "LITEHOUSE_ALLOWED_HOSTS": '["127.0.0.1"]',
            "LITEHOUSE_ALLOWED_ORIGINS": "[]",
            "LITEHOUSE_DEVELOPMENT_MODE": "false",
            "NO_PROXY": "127.0.0.1,localhost",
        }
    )
    process = subprocess.Popen(  # noqa: S603
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    try:
        stdout = process.stdout
        if stdout is None:
            raise RuntimeError("Sidecar stdout is unavailable.")
        readiness: queue.Queue[str] = queue.Queue(maxsize=1)
        reader = threading.Thread(
            target=lambda: readiness.put(stdout.readline()),
            daemon=True,
        )
        reader.start()
        ready_line = readiness.get(timeout=30).strip()
        ready = json.loads(ready_line)
        if ready.get("event") != "ready" or not isinstance(ready.get("port"), int):
            raise RuntimeError("Sidecar readiness message is invalid.")
        with urllib.request.urlopen(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/health",
            timeout=10,
        ) as response:
            health = json.loads(response.read())
            if response.status != 200 or health.get("status") != "ok":
                raise RuntimeError("Sidecar health check failed.")
        protected_pdf_request = urllib.request.Request(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/library/artifacts/smoke/content",
            headers={"Accept": "application/pdf"},
        )
        try:
            urllib.request.urlopen(protected_pdf_request, timeout=10)  # noqa: S310
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise RuntimeError(
                    "Packaged PDF content route did not require authentication."
                ) from error
        else:
            raise RuntimeError("Packaged PDF content route accepted an unauthenticated request.")
        reader_request = urllib.request.Request(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/library/items/{item_id}/reader",
            headers={"Authorization": f"Bearer {session_token}"},
        )
        with urllib.request.urlopen(reader_request, timeout=10) as response:  # noqa: S310
            reader = json.loads(response.read())
            if (
                response.status != 200
                or reader.get("item", {}).get("id") != item_id
                or reader.get("artifact", {}).get("id") != artifact_id
                or reader.get("artifact", {}).get("sha256") != expected_sha256
            ):
                raise RuntimeError("Packaged reader metadata route failed.")
        pdf_request = urllib.request.Request(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/library/artifacts/{artifact_id}/content",
            headers={
                "Accept": "application/pdf",
                "Authorization": f"Bearer {session_token}",
            },
        )
        with urllib.request.urlopen(pdf_request, timeout=10) as response:  # noqa: S310
            content = response.read()
            if (
                response.status != 200
                or content != expected_pdf
                or response.headers.get_content_type() != "application/pdf"
                or response.headers.get("Content-Length") != str(len(expected_pdf))
                or response.headers.get("Cache-Control") != "no-store"
                or response.headers.get("X-Litehouse-Content-SHA256") != expected_sha256
            ):
                raise RuntimeError("Packaged PDF content receipt failed.")
        export_request = urllib.request.Request(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/library/artifacts/{artifact_id}/export",
            headers={"Authorization": f"Bearer {session_token}"},
        )
        with urllib.request.urlopen(export_request, timeout=10) as response:  # noqa: S310
            content = response.read()
            if (
                response.status != 200
                or content != expected_pdf
                or response.headers.get_content_type() != "application/pdf"
                or response.headers.get("Content-Length") != str(len(expected_pdf))
                or response.headers.get("X-Litehouse-Artifact-ID") != artifact_id
                or response.headers.get("X-Litehouse-Content-SHA256") != expected_sha256
            ):
                raise RuntimeError("Packaged artifact export receipt failed.")
        acquisition_url = (
            f"http://127.0.0.1:{ready['port']}/v1/library/open-access/acquisitions"
        )
        malicious_payload = json.dumps(
            {
                "provider": "arxiv",
                "repository_id": "2607.01234",
                "title": "Packaged policy smoke",
                "download_url": "https://example.invalid/file.pdf",
            }
        ).encode()
        unauthenticated_acquisition = urllib.request.Request(  # noqa: S310
            acquisition_url,
            data=malicious_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(unauthenticated_acquisition, timeout=10)  # noqa: S310
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise RuntimeError(
                    "Packaged acquisition route did not require authentication."
                ) from error
        else:
            raise RuntimeError("Packaged acquisition route accepted an unauthenticated request.")
        rejected_acquisition = urllib.request.Request(  # noqa: S310
            acquisition_url,
            data=malicious_payload,
            headers={
                "Authorization": f"Bearer {session_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            urllib.request.urlopen(rejected_acquisition, timeout=10)  # noqa: S310
        except urllib.error.HTTPError as error:
            if error.code != 422:
                raise RuntimeError("Packaged acquisition policy did not fail closed.") from error
        else:
            raise RuntimeError("Packaged acquisition policy accepted an arbitrary URL field.")
        runtime_request = urllib.request.Request(  # noqa: S310
            f"http://127.0.0.1:{ready['port']}/v1/system/latex-runtime",
            headers={"Authorization": f"Bearer {session_token}"},
        )
        with urllib.request.urlopen(runtime_request, timeout=10) as response:  # noqa: S310
            runtime = json.loads(response.read())
            if (
                response.status != 200
                or runtime.get("version") != "0.16.9"
                or len(runtime.get("bundle_digest", "")) != 64
            ):
                raise RuntimeError("Packaged LaTeX runtime status check failed.")
        relocation_url = f"http://127.0.0.1:{ready['port']}/v1/system/vault/relocate"
        relocation_destination = data_dir / "relocated-vault"
        relocation_payload = json.dumps(
            {
                "confirmed": True,
                "destination_root": str(relocation_destination),
            }
        ).encode()
        unauthenticated_relocation = urllib.request.Request(  # noqa: S310
            relocation_url,
            data=relocation_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(unauthenticated_relocation, timeout=10)  # noqa: S310
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise RuntimeError(
                    "Packaged vault relocation route did not require authentication."
                ) from error
        else:
            raise RuntimeError("Packaged vault relocation accepted an unauthenticated request.")
        relocation_request = urllib.request.Request(  # noqa: S310
            relocation_url,
            data=relocation_payload,
            headers={
                "Authorization": f"Bearer {session_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(relocation_request, timeout=30) as response:  # noqa: S310
            relocation = json.loads(response.read())
            if (
                response.status != 201
                or relocation.get("destination_root") != str(relocation_destination.resolve())
                or relocation.get("source_root") != str((data_dir / "vault").resolve())
                or relocation.get("files_verified") != 1
                or relocation.get("bytes_verified") != len(expected_pdf)
                or relocation.get("source_preserved") is not True
                or relocation.get("restart_required") is not True
            ):
                raise RuntimeError("Packaged vault relocation receipt failed.")
        relocated_pdf = (
            relocation_destination
            / "blobs"
            / "sha256"
            / expected_sha256[:2]
            / expected_sha256
        )
        if relocated_pdf.read_bytes() != expected_pdf or not (data_dir / "vault").is_dir():
            raise RuntimeError("Packaged vault relocation did not preserve verified bytes.")
        pointer = json.loads((data_dir / "config" / "vault-pointer.json").read_text())
        if (
            pointer.get("active_vault_root") != str(relocation_destination.resolve())
            or pointer.get("previous_vault_root") != str((data_dir / "vault").resolve())
        ):
            raise RuntimeError("Packaged vault relocation pointer failed.")
        if process.stdin is None:
            raise RuntimeError("Sidecar stdin is unavailable.")
        process.stdin.write("shutdown\n")
        process.stdin.flush()
        if process.wait(timeout=15) != 0:
            raise RuntimeError("Sidecar returned a nonzero status.")
        print(f"sidecar-smoke target={args.target} status=ok")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
