from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from litehouse.infrastructure.reports.models import ReportDocument, UnsupportedClaimPolicy

from .models import (
    LatexBuildManifest,
    LatexBuildResult,
    LatexCompilationError,
    LatexCompilerUnavailableError,
)
from .renderer import _ASSET_DIR, render_latex
from .runtime import (
    TECTONIC_BUNDLE_URL,
    TECTONIC_VERSION,
    TectonicRuntimeError,
    resolve_tectonic_runtime,
)
from .verify import audit_compiler_log, audit_pdf

_XELATEX_ARGUMENTS = (
    "-no-shell-escape",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-jobname=report",
    "report.tex",
)
_COMPILER_PASSES = 2
_TIMEOUT_SECONDS = 90


@dataclass(frozen=True, slots=True)
class _CompilerSpec:
    name: str
    path: str
    arguments: tuple[str, ...]
    invocations: int
    environment: dict[str, str]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_copy(source: Path, destination: Path) -> None:
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary_path = Path(temporary)
    try:
        with source.open("rb") as source_handle, os.fdopen(descriptor, "wb") as target_handle:
            shutil.copyfileobj(source_handle, target_handle, length=1024 * 1024)
            target_handle.flush()
            os.fsync(target_handle.fileno())
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def _atomic_write_text(content: str, destination: Path) -> None:
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def _compiler_spec() -> _CompilerSpec:
    packaged_data_dir = os.environ.get("LITEHOUSE_DATA_DIR")
    if packaged_data_dir:
        try:
            binary, cache = resolve_tectonic_runtime(Path(packaged_data_dir))
        except TectonicRuntimeError as error:
            raise LatexCompilerUnavailableError(
                "The verified Tectonic runtime must be installed with user confirmation."
            ) from error
        arguments = (
            "-X",
            "compile",
            "--bundle",
            TECTONIC_BUNDLE_URL,
            "--untrusted",
            "--only-cached",
            "--keep-logs",
            "--reruns",
            "1",
            "--outdir",
            ".",
            "report.tex",
        )
        return _CompilerSpec(
            f"tectonic@{TECTONIC_VERSION}",
            str(binary),
            arguments,
            1,
            {
                "TECTONIC_CACHE_DIR": str(cache),
                "TECTONIC_UNTRUSTED_MODE": "1",
            },
        )

    path = shutil.which("xelatex")
    if path is None:
        raise LatexCompilerUnavailableError(
            "XeLaTeX is required for development PDF builds."
        )
    return _CompilerSpec("xelatex", path, _XELATEX_ARGUMENTS, _COMPILER_PASSES, {})


def _compiler_environment(
    generated_epoch: int,
    temp_dir: Path,
    overrides: dict[str, str],
) -> dict[str, str]:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "SOURCE_DATE_EPOCH": str(max(0, generated_epoch)),
        "FORCE_SOURCE_DATE": "1",
        "TZ": "UTC",
        "TMPDIR": str(temp_dir),
        "TEMP": str(temp_dir),
        "TMP": str(temp_dir),
        "openout_any": "p",
        "openin_any": "p",
        "shell_escape": "f",
        "MIKTEX_ENABLEINSTALLER": "0",
    }
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    environment.update(overrides)
    return environment


def _sanitized_error(output: str, temp_dir: Path, compiler_name: str) -> str:
    normalized = output.replace(str(temp_dir), "<build-dir>")
    normalized = normalized.replace(str(Path.home()), "<home>")
    useful = [
        line.strip()
        for line in normalized.splitlines()
        if line.startswith("!")
        or re.search(r"report\.tex:\d+:", line)
        or "Emergency stop" in line
        or "Fatal error" in line
    ]
    summary = "\n".join(useful[-12:]) or f"{compiler_name} stopped without a diagnostic line."
    return summary[:2000]


def build_latex_report(
    document: ReportDocument,
    output_dir: Path,
    *,
    unsupported_policy: UnsupportedClaimPolicy = UnsupportedClaimPolicy.REFUSE,
) -> LatexBuildResult:
    source = render_latex(document, unsupported_policy=unsupported_policy)
    compiler = _compiler_spec()
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".litehouse-latex-") as temporary:
        temp_dir = Path(temporary)
        fonts_dir = temp_dir / "fonts"
        fonts_dir.mkdir()
        for asset_name in source.asset_sha256:
            target = (
                temp_dir / asset_name if asset_name.endswith(".pdf") else fonts_dir / asset_name
            )
            shutil.copyfile(_ASSET_DIR / asset_name, target)
        tex_path = temp_dir / "report.tex"
        tex_path.write_text(source.content, encoding="utf-8", newline="\n")
        environment = _compiler_environment(
            int(document.generated_at.timestamp()), temp_dir, compiler.environment
        )
        combined_output: list[str] = []
        argv = (compiler.path, *compiler.arguments)
        for _ in range(compiler.invocations):
            try:
                completed = subprocess.run(  # noqa: S603
                    argv,
                    cwd=temp_dir,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    timeout=_TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise LatexCompilationError(
                    f"{compiler.name} exceeded the {_TIMEOUT_SECONDS}-second build limit."
                ) from error
            output = completed.stdout + "\n" + completed.stderr
            combined_output.append(output)
            if completed.returncode != 0:
                raise LatexCompilationError(_sanitized_error(output, temp_dir, compiler.name))
        pdf_path = temp_dir / "report.pdf"
        log_path = temp_dir / "report.log"
        if not pdf_path.is_file() or not log_path.is_file():
            raise LatexCompilationError(
                f"{compiler.name} did not produce the expected PDF and log."
            )
        warnings = audit_compiler_log(log_path.read_text(encoding="utf-8", errors="replace"))
        source_labels = tuple(f"W{index}" for index in range(1, len(document.references) + 1))
        pdf_audit = audit_pdf(pdf_path, expected_source_labels=source_labels)
        destination_tex = output_dir / "report.tex"
        destination_pdf = output_dir / "report.pdf"
        destination_manifest = output_dir / "report.manifest.json"
        _atomic_copy(tex_path, destination_tex)
        _atomic_copy(pdf_path, destination_pdf)
        manifest = LatexBuildManifest(
            report_id=document.id,
            generated_at=document.generated_at.isoformat(),
            citation_style=document.citation_style.value,
            input_sha256=source.input_sha256,
            template_sha256=source.template_sha256,
            tex_sha256=_sha256_file(destination_tex),
            pdf_sha256=_sha256_file(destination_pdf),
            logo_sha256=source.logo_sha256,
            asset_sha256=source.asset_sha256,
            evidence_sha256=source.evidence_sha256,
            compiler=compiler.name,
            compiler_arguments=compiler.arguments,
            compiler_passes=compiler.invocations,
            page_count=pdf_audit.page_count,
        )
        _atomic_write_text(manifest.to_json(), destination_manifest)
    return LatexBuildResult(
        tex_path=destination_tex,
        pdf_path=destination_pdf,
        manifest_path=destination_manifest,
        manifest=manifest,
        compiler_warnings=warnings,
    )
