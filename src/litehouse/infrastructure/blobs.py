from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


class BlobIntegrityError(ValueError):
    """Raised when stored bytes do not match their content address."""


@dataclass(frozen=True, slots=True)
class BlobRef:
    sha256: str
    size: int
    relative_path: str


class BlobStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def put(self, content: bytes) -> BlobRef:
        digest = hashlib.sha256(content).hexdigest()
        relative = Path("sha256") / digest[:2] / digest
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists():
            self._assert_digest(destination, digest)
        else:
            descriptor, temporary_name = tempfile.mkstemp(
                dir=destination.parent,
                prefix=f".{digest}.",
            )
            temporary = Path(temporary_name)
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)

        return BlobRef(
            sha256=digest,
            size=len(content),
            relative_path=relative.as_posix(),
        )

    def read(self, reference: BlobRef) -> bytes:
        path = self._resolve(reference.relative_path)
        content = path.read_bytes()
        if len(content) != reference.size:
            raise BlobIntegrityError("Stored blob size does not match its receipt.")
        actual = hashlib.sha256(content).hexdigest()
        if actual != reference.sha256:
            raise BlobIntegrityError("Stored blob hash does not match its receipt.")
        return content

    def verify(self, reference: BlobRef) -> bool:
        try:
            self.read(reference)
        except (BlobIntegrityError, FileNotFoundError):
            return False
        return True

    def _resolve(self, relative_path: str) -> Path:
        candidate = (self.root / relative_path).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise BlobIntegrityError("Blob path escapes the content store.")
        return candidate

    @staticmethod
    def _assert_digest(path: Path, expected: str) -> None:
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise BlobIntegrityError("Existing content-addressed blob is corrupted.")
