from __future__ import annotations

import hashlib
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import BinaryIO

from litehouse.infrastructure.vault.models import (
    BlobVerification,
    BlobVerificationStatus,
    VaultBlobRef,
)
from litehouse.infrastructure.vault.paths import VaultPathError, VaultRoot

_CHUNK_SIZE = 1024 * 1024


class VaultIntegrityError(ValueError):
    pass


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


class VaultBlobStore:
    def __init__(self, root: VaultRoot) -> None:
        self.root = root

    def put_bytes(self, content: bytes) -> VaultBlobRef:
        digest = hashlib.sha256(content).hexdigest()
        return self._store(digest, len(content), [content])

    def put_file(self, source: Path) -> VaultBlobRef:
        if source.is_symlink() or not source.is_file():
            raise VaultPathError("Artifact input must be a regular non-symlink file.")
        digest, size = _hash_file(source)
        with source.open("rb") as handle:
            return self._store_stream(digest, size, handle)

    def read(self, reference: VaultBlobRef) -> bytes:
        path = self.path_for(reference, must_exist=True)
        content = path.read_bytes()
        if len(content) != reference.size:
            raise VaultIntegrityError("Stored artifact size differs from its vault receipt.")
        actual = hashlib.sha256(content).hexdigest()
        if actual != reference.sha256:
            raise VaultIntegrityError("Stored artifact hash differs from its vault receipt.")
        return content

    def path_for(self, reference: VaultBlobRef, *, must_exist: bool = False) -> Path:
        expected = Path("blobs") / "sha256" / reference.sha256[:2] / reference.sha256
        if reference.relative_path != expected.as_posix():
            raise VaultIntegrityError("Artifact path does not match its content address.")
        return self.root.resolve_relative(reference.relative_path, must_exist=must_exist)

    def verify(self, reference: VaultBlobRef) -> BlobVerification:
        try:
            path = self.path_for(reference, must_exist=True)
        except FileNotFoundError:
            return BlobVerification(BlobVerificationStatus.MISSING, reference.sha256)
        except VaultPathError:
            return BlobVerification(BlobVerificationStatus.CHANGED, reference.sha256)
        actual, size = _hash_file(path)
        if actual != reference.sha256 or size != reference.size:
            return BlobVerification(BlobVerificationStatus.CHANGED, reference.sha256, actual)
        return BlobVerification(BlobVerificationStatus.INTACT, reference.sha256, actual)

    def _store_stream(self, digest: str, size: int, handle: BinaryIO) -> VaultBlobRef:
        def chunks() -> Iterable[bytes]:
            while chunk := handle.read(_CHUNK_SIZE):
                yield chunk

        return self._store(digest, size, chunks())

    def _store(self, digest: str, size: int, chunks: Iterable[bytes]) -> VaultBlobRef:
        relative = Path("blobs") / "sha256" / digest[:2] / digest
        destination = self.root.resolve_relative(relative)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination = self.root.resolve_relative(relative)
        if destination.exists():
            reference = VaultBlobRef(digest, size, relative.as_posix())
            verification = self.verify(reference)
            if verification.status is not BlobVerificationStatus.INTACT:
                raise VaultIntegrityError("Existing content-addressed artifact is corrupted.")
            return reference
        descriptor, temporary_name = tempfile.mkstemp(
            dir=destination.parent,
            prefix=f".{digest}.",
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                written = 0
                for chunk in chunks:
                    output.write(chunk)
                    written += len(chunk)
                output.flush()
                os.fsync(output.fileno())
            temporary_digest, temporary_size = _hash_file(temporary)
            if written != size or temporary_size != size or temporary_digest != digest:
                raise VaultIntegrityError("Artifact changed while it was copied into the vault.")
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        reference = VaultBlobRef(digest, size, relative.as_posix())
        if self.verify(reference).status is not BlobVerificationStatus.INTACT:
            raise VaultIntegrityError("Artifact failed verification after its atomic write.")
        return reference
