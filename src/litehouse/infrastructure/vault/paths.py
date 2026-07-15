from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class VaultPathError(ValueError):
    pass


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            if current.is_symlink():
                raise VaultPathError(f"Vault paths cannot contain symlinks: {current}")
        except OSError as error:
            raise VaultPathError(f"Vault path cannot be inspected: {current}") from error


@dataclass(frozen=True, slots=True)
class VaultRoot:
    path: Path

    @classmethod
    def from_user_path(cls, path: Path, *, create: bool = True) -> VaultRoot:
        if not path.is_absolute():
            raise VaultPathError("A custom vault root must be an absolute local path.")
        if ".." in path.parts:
            raise VaultPathError("Vault roots cannot contain parent traversal.")
        normalized = Path(os.path.normpath(path))
        _reject_symlink_components(normalized)
        if normalized.exists() and not normalized.is_dir():
            raise VaultPathError("Vault root must be a directory.")
        if create:
            normalized.mkdir(mode=0o700, parents=True, exist_ok=True)
            _reject_symlink_components(normalized)
        return cls(normalized.resolve(strict=create))

    @classmethod
    def under_app_data(cls, app_data_dir: Path, *, create: bool = True) -> VaultRoot:
        base = app_data_dir.expanduser().resolve(strict=False)
        return cls.from_user_path(base / "vault", create=create)

    def resolve_relative(self, relative_path: str | Path, *, must_exist: bool = False) -> Path:
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise VaultPathError("Vault paths must be relative and cannot contain traversal.")
        _reject_symlink_components(self.path)
        candidate = self.path.joinpath(relative)
        _reject_symlink_components(candidate)
        resolved = candidate.resolve(strict=must_exist)
        if resolved != self.path and self.path not in resolved.parents:
            raise VaultPathError("Path escapes the selected vault root.")
        return resolved
