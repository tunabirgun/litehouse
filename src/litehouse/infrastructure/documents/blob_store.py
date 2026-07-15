from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Protocol

from litehouse.infrastructure.blobs import BlobIntegrityError, BlobRef


class DocumentBlobStore(Protocol):
    def put_verified_file(
        self,
        source: Path,
        *,
        expected_sha256: str,
        size: int,
    ) -> BlobRef: ...


class AtomicDocumentBlobStore:
    """Store a verified file in the shared content-addressed layout."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def put_verified_file(
        self,
        source: Path,
        *,
        expected_sha256: str,
        size: int,
    ) -> BlobRef:
        actual_size, actual_sha256 = self._digest(source)
        if actual_size != size or actual_sha256 != expected_sha256:
            raise BlobIntegrityError("Downloaded document does not match its receipt.")

        relative = Path("sha256") / expected_sha256[:2] / expected_sha256
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            stored_size, stored_sha256 = self._digest(destination)
            if stored_size != size or stored_sha256 != expected_sha256:
                raise BlobIntegrityError("Existing content-addressed blob is corrupted.")
        else:
            descriptor, temporary_name = tempfile.mkstemp(
                dir=destination.parent,
                prefix=f".{expected_sha256}.",
            )
            temporary = Path(temporary_name)
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
                    shutil.copyfileobj(input_file, output, length=1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                copied_size, copied_sha256 = self._digest(temporary)
                if copied_size != size or copied_sha256 != expected_sha256:
                    raise BlobIntegrityError("Copied document does not match its receipt.")
                os.replace(temporary, destination)
                self._fsync_directory(destination.parent)
            finally:
                temporary.unlink(missing_ok=True)

        return BlobRef(
            sha256=expected_sha256,
            size=size,
            relative_path=relative.as_posix(),
        )

    @staticmethod
    def _digest(path: Path) -> tuple[int, str]:
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
        return size, digest.hexdigest()

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
