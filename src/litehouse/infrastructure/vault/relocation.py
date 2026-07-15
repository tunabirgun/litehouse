from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from litehouse.infrastructure.vault.paths import VaultPathError, VaultRoot

_CHUNK_SIZE = 1024 * 1024
type CopyFile = Callable[[Path, Path], object]
type PointerSwitch = Callable[[Path], None]


class VaultRelocationError(RuntimeError):
    def __init__(self, message: str, *, staging_path: Path | None = None) -> None:
        super().__init__(message)
        self.staging_path = staging_path


@dataclass(frozen=True, slots=True)
class VaultRelocationResult:
    source_root: Path
    destination_root: Path
    files_verified: int
    bytes_copied: int
    source_preserved: bool = True


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _source_files(root: VaultRoot) -> tuple[tuple[Path, ...], tuple[Path, ...]]:
    directories: list[Path] = []
    files: list[Path] = []
    for current_text, directory_names, file_names in os.walk(root.path, followlinks=False):
        current = Path(current_text)
        relative_current = current.relative_to(root.path)
        for directory_name in sorted(directory_names):
            path = current / directory_name
            if path.is_symlink():
                raise VaultPathError(f"Vault relocation refuses directory symlinks: {path}")
            directories.append(relative_current / directory_name)
        for file_name in sorted(file_names):
            path = current / file_name
            if path.is_symlink() or not path.is_file():
                raise VaultPathError(f"Vault relocation requires regular files: {path}")
            files.append(relative_current / file_name)
    return tuple(sorted(directories)), tuple(sorted(files))


def relocate_vault(
    source: VaultRoot,
    destination_path: Path,
    *,
    switch_pointer: PointerSwitch,
    copy_file: CopyFile = shutil.copy2,
) -> VaultRelocationResult:
    destination = VaultRoot.from_user_path(destination_path, create=False).path
    if destination == source.path:
        raise VaultRelocationError("Vault destination must differ from the source.")
    if source.path in destination.parents:
        raise VaultRelocationError("Vault destination cannot be inside the source vault.")
    if destination.exists():
        raise VaultRelocationError("Vault destination must not already exist.")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    VaultRoot.from_user_path(destination.parent)
    staging = destination.parent / f".{destination.name}.relocating-{uuid.uuid4().hex}"
    staging.mkdir(mode=0o700)
    staging_root = VaultRoot.from_user_path(staging)
    try:
        directories, files = _source_files(source)
        for relative in directories:
            staging_root.resolve_relative(relative).mkdir(mode=0o700, parents=True, exist_ok=True)
        receipts: dict[Path, tuple[str, int]] = {}
        total_bytes = 0
        for relative in files:
            source_file = source.resolve_relative(relative, must_exist=True)
            before = _hash_file(source_file)
            destination_file = staging_root.resolve_relative(relative)
            destination_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            copy_file(source_file, destination_file)
            if destination_file.is_symlink() or not destination_file.is_file():
                raise VaultRelocationError(
                    f"Vault copy did not produce a regular file: {relative}",
                    staging_path=staging,
                )
            after = _hash_file(source_file)
            copied = _hash_file(destination_file)
            if before != after or before != copied:
                raise VaultRelocationError(
                    f"Vault file changed or failed verification during copy: {relative}",
                    staging_path=staging,
                )
            with destination_file.open("rb") as handle:
                os.fsync(handle.fileno())
            receipts[relative] = before
            total_bytes += before[1]
        final_directories, final_files = _source_files(source)
        if final_directories != directories or final_files != files:
            raise VaultRelocationError(
                "Vault contents changed while relocation was being verified.",
                staging_path=staging,
            )
        for relative, expected in receipts.items():
            if _hash_file(source.resolve_relative(relative, must_exist=True)) != expected:
                raise VaultRelocationError(
                    f"Vault source changed before destination activation: {relative}",
                    staging_path=staging,
                )
        os.replace(staging, destination)
        destination_root = VaultRoot.from_user_path(destination)
        for relative, expected in receipts.items():
            if _hash_file(destination_root.resolve_relative(relative, must_exist=True)) != expected:
                raise VaultRelocationError(
                    f"Vault file failed verification after destination activation: {relative}",
                    staging_path=destination,
                )
        try:
            switch_pointer(destination_root.path)
        except BaseException as error:
            raise VaultRelocationError(
                "Vault copy verified, but the atomic pointer switch failed; source remains active.",
                staging_path=destination,
            ) from error
        return VaultRelocationResult(
            source_root=source.path,
            destination_root=destination_root.path,
            files_verified=len(receipts),
            bytes_copied=total_bytes,
        )
    except VaultRelocationError:
        raise
    except BaseException as error:
        raise VaultRelocationError(
            "Vault relocation failed before the pointer switch; source remains unchanged.",
            staging_path=staging,
        ) from error
