from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from litehouse.domain import canonical_json

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class LatexReportError(RuntimeError):
    pass


class LatexCompilerUnavailableError(LatexReportError):
    pass


class LatexCompilationError(LatexReportError):
    pass


class LatexVerificationError(LatexReportError):
    pass


@dataclass(frozen=True, slots=True)
class LatexSource:
    content: str
    input_sha256: str
    template_sha256: str
    logo_sha256: str
    asset_sha256: dict[str, str]
    evidence_sha256: dict[str, str]


@dataclass(frozen=True, slots=True, kw_only=True)
class LatexBuildManifest:
    report_id: str
    generated_at: str
    citation_style: str
    input_sha256: str
    template_sha256: str
    tex_sha256: str
    pdf_sha256: str
    logo_sha256: str
    asset_sha256: dict[str, str]
    evidence_sha256: dict[str, str]
    compiler: str
    compiler_arguments: tuple[str, ...]
    compiler_passes: int
    page_count: int
    schema_version: int = 1

    def __post_init__(self) -> None:
        hashes = (
            self.input_sha256,
            self.template_sha256,
            self.tex_sha256,
            self.pdf_sha256,
            self.logo_sha256,
            *self.asset_sha256.values(),
            *self.evidence_sha256.values(),
        )
        if any(_SHA256.fullmatch(value) is None for value in hashes):
            raise ValueError("Manifest SHA-256 values must be lowercase hexadecimal.")
        if self.schema_version != 1 or self.compiler_passes < 1 or self.page_count < 1:
            raise ValueError("Manifest version, compiler passes, and page count are invalid.")

    def to_json(self) -> str:
        return canonical_json(
            {
                "asset_sha256": dict(sorted(self.asset_sha256.items())),
                "citation_style": self.citation_style,
                "compiler": self.compiler,
                "compiler_arguments": list(self.compiler_arguments),
                "compiler_passes": self.compiler_passes,
                "evidence_sha256": dict(sorted(self.evidence_sha256.items())),
                "generated_at": self.generated_at,
                "input_sha256": self.input_sha256,
                "logo_sha256": self.logo_sha256,
                "page_count": self.page_count,
                "pdf_sha256": self.pdf_sha256,
                "report_id": self.report_id,
                "schema_version": self.schema_version,
                "template_sha256": self.template_sha256,
                "tex_sha256": self.tex_sha256,
            }
        ) + "\n"

    @classmethod
    def from_json(cls, content: str) -> LatexBuildManifest:
        payload = json.loads(content)
        if not isinstance(payload, dict):
            raise LatexVerificationError("The report manifest is not a JSON object.")
        try:
            return cls(
                report_id=str(payload["report_id"]),
                generated_at=str(payload["generated_at"]),
                citation_style=str(payload["citation_style"]),
                input_sha256=str(payload["input_sha256"]),
                template_sha256=str(payload["template_sha256"]),
                tex_sha256=str(payload["tex_sha256"]),
                pdf_sha256=str(payload["pdf_sha256"]),
                logo_sha256=str(payload["logo_sha256"]),
                asset_sha256={str(k): str(v) for k, v in dict(payload["asset_sha256"]).items()},
                evidence_sha256={
                    str(k): str(v) for k, v in dict(payload["evidence_sha256"]).items()
                },
                compiler=str(payload["compiler"]),
                compiler_arguments=tuple(str(v) for v in payload["compiler_arguments"]),
                compiler_passes=int(payload["compiler_passes"]),
                page_count=int(payload["page_count"]),
                schema_version=int(payload["schema_version"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise LatexVerificationError("The report manifest is malformed.") from error

    @classmethod
    def read(cls, path: Path) -> LatexBuildManifest:
        try:
            return cls.from_json(path.read_text(encoding="utf-8"))
        except OSError as error:
            raise LatexVerificationError("The report manifest could not be read.") from error


@dataclass(frozen=True, slots=True)
class LatexBuildResult:
    tex_path: Path
    pdf_path: Path
    manifest_path: Path
    manifest: LatexBuildManifest
    compiler_warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PdfAuditResult:
    page_count: int
    page_text: tuple[str, ...]
    overfull_points: tuple[float, ...]
    underfull_badness: tuple[int, ...]
    raster_ink_fraction: tuple[float, ...]
