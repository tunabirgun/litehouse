from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from litehouse.domain import canonical_json
from litehouse.infrastructure.vault.paths import VaultPathError, VaultRoot

VAULT_POINTER_SCHEMA = "litehouse.vault-pointer.v1"


class VaultPointerError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class VaultPointer:
    active_vault_root: Path
    previous_vault_root: Path


def write_vault_pointer(
    config_path: Path,
    *,
    active_vault_root: Path,
    previous_vault_root: Path,
) -> VaultPointer:
    active = VaultRoot.from_user_path(active_vault_root, create=False).path
    previous = VaultRoot.from_user_path(previous_vault_root, create=False).path
    if active == previous:
        raise VaultPointerError("Active and previous vault roots must differ.")
    if not active.is_dir() or not previous.is_dir():
        raise VaultPointerError("Vault pointer roots must be existing directories.")
    if not config_path.is_absolute() or ".." in config_path.parts:
        raise VaultPointerError("Vault pointer path must be an absolute local path.")
    try:
        config_root = VaultRoot.from_user_path(config_path.parent)
    except VaultPathError as error:
        raise VaultPointerError("Vault pointer directory is unsafe.") from error
    normalized_path = config_root.resolve_relative(config_path.name)
    if normalized_path.is_symlink():
        raise VaultPointerError("Vault pointer file cannot be a symlink.")
    document = {
        "active_vault_root": str(active),
        "previous_vault_root": str(previous),
        "schema": VAULT_POINTER_SCHEMA,
    }
    descriptor, temporary_name = tempfile.mkstemp(
        dir=config_root.path,
        prefix=f".{config_path.name}.",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write((canonical_json(document) + "\n").encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, normalized_path)
        directory_descriptor = os.open(config_root.path, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        raise VaultPointerError("Vault pointer could not be written atomically.") from error
    finally:
        temporary.unlink(missing_ok=True)
    return VaultPointer(active_vault_root=active, previous_vault_root=previous)


def read_vault_pointer(config_path: Path) -> VaultPointer:
    try:
        if config_path.is_symlink() or not config_path.is_file():
            raise VaultPointerError("Vault pointer is not a regular file.")
        if config_path.stat().st_size > 8 * 1024:
            raise VaultPointerError("Vault pointer is too large.")
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise VaultPointerError("Vault pointer could not be read.") from error
    if not isinstance(document, dict) or set(document) != {
        "active_vault_root",
        "previous_vault_root",
        "schema",
    }:
        raise VaultPointerError("Vault pointer contract is invalid.")
    if document["schema"] != VAULT_POINTER_SCHEMA:
        raise VaultPointerError("Vault pointer schema is unsupported.")
    try:
        active = VaultRoot.from_user_path(Path(document["active_vault_root"]), create=False)
        previous = VaultRoot.from_user_path(
            Path(document["previous_vault_root"]), create=False
        )
    except (TypeError, VaultPathError) as error:
        raise VaultPointerError("Vault pointer roots are unsafe.") from error
    if not active.path.is_dir() or not previous.path.is_dir():
        raise VaultPointerError("Vault pointer roots must exist.")
    return VaultPointer(active.path, previous.path)
