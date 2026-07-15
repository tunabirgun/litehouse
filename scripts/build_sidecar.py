from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUPPORTED_TARGETS = {
    ("Darwin", "arm64"): "aarch64-apple-darwin",
    ("Darwin", "x86_64"): "x86_64-apple-darwin",
    ("Linux", "aarch64"): "aarch64-unknown-linux-gnu",
    ("Linux", "x86_64"): "x86_64-unknown-linux-gnu",
    ("Windows", "AMD64"): "x86_64-pc-windows-msvc",
    ("Windows", "ARM64"): "aarch64-pc-windows-msvc",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the target-native Litehouse API sidecar.")
    parser.add_argument("--target", required=True, choices=sorted(SUPPORTED_TARGETS.values()))
    args = parser.parse_args()

    host = (platform.system(), platform.machine())
    host_target = SUPPORTED_TARGETS.get(host)
    if host_target != args.target:
        raise SystemExit(
            f"Sidecars must be built natively: host={host!r}, requested={args.target!r}"
        )

    work = ROOT / "build" / "sidecar" / args.target
    dist = work / "dist"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name",
        "litehouse-backend",
        "--paths",
        str(ROOT / "src"),
        "--collect-data",
        "litehouse",
        "--collect-submodules",
        "litehouse",
        "--collect-submodules",
        "keyring",
        "--add-data",
        f"{ROOT / 'migrations'}{os.pathsep}migrations",
        "--hidden-import",
        "aiosqlite",
        "--distpath",
        str(dist),
        "--workpath",
        str(work / "work"),
        "--specpath",
        str(work),
        str(ROOT / "scripts" / "sidecar_entry.py"),
    ]
    environment = os.environ.copy()
    environment["PYTHONHASHSEED"] = "0"
    environment["PYINSTALLER_CONFIG_DIR"] = str(work / "cache")
    subprocess.run(command, cwd=ROOT, env=environment, check=True)  # noqa: S603

    extension = ".exe" if platform.system() == "Windows" else ""
    source = dist / f"litehouse-backend{extension}"
    destination_dir = ROOT / "src-tauri" / "binaries"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"litehouse-backend-{args.target}{extension}"
    shutil.copy2(source, destination)
    destination.chmod(0o755)
    print(f"{destination.relative_to(ROOT)} sha256={_sha256(destination)}")


if __name__ == "__main__":
    main()
