from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PLACEHOLDER = "__LITEHOUSE_TAURI_UPDATER_PUBLIC_KEY__"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: write_release_config.py OUTPUT")
    public_key = os.environ.get("TAURI_UPDATER_PUBLIC_KEY", "").strip()
    if not public_key or public_key == PLACEHOLDER or len(public_key) < 40:
        raise SystemExit("TAURI_UPDATER_PUBLIC_KEY is missing or invalid")

    root = Path(__file__).resolve().parents[1]
    template = root / "src-tauri" / "tauri.release.conf.json"
    payload = json.loads(template.read_text(encoding="utf-8"))
    payload["plugins"]["updater"]["pubkey"] = public_key
    configured = json.dumps(payload, indent=2, sort_keys=True)
    output = Path(sys.argv[1]).resolve()
    output.write_text(configured + "\n", encoding="utf-8")
    output.chmod(0o600)


if __name__ == "__main__":
    main()
