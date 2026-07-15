from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from litehouse.infrastructure.reports.models import ReportDocument

from .models import LatexBuildManifest, LatexVerificationError, PdfAuditResult
from .renderer import _ASSET_DIR, render_latex, report_input_sha256

_OVERFULL = re.compile(r"Overfull \\[hv]box \((?P<points>[0-9.]+)pt too (?:wide|high)\)")
_UNDERFULL = re.compile(r"Underfull \\[hv]box \(badness (?P<badness>\d+)\)")
_MAX_OVERFULL_POINTS = 1.0
_MAX_UNDERFULL_WARNINGS = 12
_A4_WIDTH_POINTS = 595.276
_A4_HEIGHT_POINTS = 841.89
_A4_TOLERANCE_POINTS = 1.0


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise LatexVerificationError(f"Could not read {path.name} for verification.") from error
    return digest.hexdigest()


def audit_compiler_log(content: str) -> tuple[str, ...]:
    overfull = tuple(float(match.group("points")) for match in _OVERFULL.finditer(content))
    underfull = tuple(int(match.group("badness")) for match in _UNDERFULL.finditer(content))
    if overfull and max(overfull) > _MAX_OVERFULL_POINTS:
        raise LatexVerificationError(
            f"The report contains an overfull box of {max(overfull):.2f} pt; "
            f"the limit is {_MAX_OVERFULL_POINTS:.2f} pt."
        )
    if len(underfull) > _MAX_UNDERFULL_WARNINGS:
        raise LatexVerificationError(
            f"The report contains {len(underfull)} underfull boxes; "
            f"the limit is {_MAX_UNDERFULL_WARNINGS}."
        )
    warnings = [f"overfull:{points:.3f}pt" for points in overfull]
    warnings.extend(f"underfull:badness={badness}" for badness in underfull)
    return tuple(warnings)


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise LatexVerificationError(f"{name} is required for PDF verification.")
    return path


def _run(argv: tuple[str, ...], *, timeout: int = 45) -> str:
    try:
        completed = subprocess.run(  # noqa: S603
            argv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise LatexVerificationError(f"{Path(argv[0]).name} timed out.") from error
    if completed.returncode != 0:
        raise LatexVerificationError(f"{Path(argv[0]).name} could not inspect the report.")
    return completed.stdout


def _pdf_boxes(info: str) -> tuple[int, tuple[float, float], tuple[float, float]]:
    page_match = re.search(r"^Pages:\s+(\d+)$", info, re.MULTILINE)
    size_match = re.search(r"^Page size:\s+([0-9.]+) x ([0-9.]+) pts", info, re.MULTILINE)
    media_match = re.search(
        r"^MediaBox:\s+[0-9.-]+\s+[0-9.-]+\s+([0-9.]+)\s+([0-9.]+)$",
        info,
        re.MULTILINE,
    )
    crop_match = re.search(
        r"^CropBox:\s+[0-9.-]+\s+[0-9.-]+\s+([0-9.]+)\s+([0-9.]+)$",
        info,
        re.MULTILINE,
    )
    if page_match is None or size_match is None or media_match is None or crop_match is None:
        raise LatexVerificationError("pdfinfo did not return page and box metadata.")
    return (
        int(page_match.group(1)),
        (float(media_match.group(1)), float(media_match.group(2))),
        (float(crop_match.group(1)), float(crop_match.group(2))),
    )


def _read_pgm(path: Path) -> tuple[int, int, bytes]:
    content = path.read_bytes()
    if not content.startswith(b"P5"):
        raise LatexVerificationError("Poppler returned an unexpected raster format.")
    index = 2
    tokens: list[bytes] = []
    while len(tokens) < 3:
        while index < len(content) and content[index] in b" \t\r\n":
            index += 1
        if index < len(content) and content[index] == 35:
            index = content.find(b"\n", index) + 1
            continue
        end = index
        while end < len(content) and content[end] not in b" \t\r\n":
            end += 1
        tokens.append(content[index:end])
        index = end
    while index < len(content) and content[index] in b" \t\r\n":
        index += 1
    width, height, maximum = (int(token) for token in tokens)
    if maximum != 255 or len(content[index:]) != width * height:
        raise LatexVerificationError("The page raster is truncated or uses an unsupported depth.")
    return width, height, content[index:]


def _raster_audit(pdf_path: Path, pages: int) -> tuple[float, ...]:
    pdftoppm = _tool("pdftoppm")
    fractions: list[float] = []
    with tempfile.TemporaryDirectory(prefix=".litehouse-pdf-audit-") as temporary:
        temp_dir = Path(temporary)
        for page in range(1, pages + 1):
            prefix = temp_dir / f"page-{page}"
            _run(
                (
                    pdftoppm,
                    "-f",
                    str(page),
                    "-l",
                    str(page),
                    "-r",
                    "36",
                    "-gray",
                    "-singlefile",
                    str(pdf_path),
                    str(prefix),
                )
            )
            width, height, pixels = _read_pgm(prefix.with_suffix(".pgm"))
            ink = sum(pixel < 245 for pixel in pixels)
            fraction = ink / len(pixels)
            if fraction < 0.002:
                raise LatexVerificationError(f"Page {page} is blank or nearly blank.")
            border = 2
            edge_ink = 0
            for y in range(height):
                for x in range(width):
                    if x < border or x >= width - border or y < border or y >= height - border:
                        edge_ink += pixels[y * width + x] < 235
            if edge_ink:
                raise LatexVerificationError(f"Page {page} has ink at the raster boundary.")
            fractions.append(fraction)
    return tuple(fractions)


def audit_pdf(
    pdf_path: Path,
    *,
    expected_source_labels: tuple[str, ...] = (),
) -> PdfAuditResult:
    pdfinfo = _tool("pdfinfo")
    pdftotext = _tool("pdftotext")
    info = _run((pdfinfo, "-box", str(pdf_path)))
    pages, media_box, crop_box = _pdf_boxes(info)
    if abs(media_box[0] - _A4_WIDTH_POINTS) > _A4_TOLERANCE_POINTS or abs(
        media_box[1] - _A4_HEIGHT_POINTS
    ) > _A4_TOLERANCE_POINTS:
        raise LatexVerificationError("The report is not A4 size.")
    if media_box != crop_box:
        raise LatexVerificationError("MediaBox and CropBox differ; page clipping is possible.")
    page_text: list[str] = []
    section_headings = (
        "Scope and integrity",
        "Supported findings",
        "System notes",
        "Unsupported claims",
        "Sources",
        "Evidence ledger",
        "Evidence excerpts",
        "Verification",
    )
    for page in range(1, pages + 1):
        text = _run(
            (
                pdftotext,
                "-f",
                str(page),
                "-l",
                str(page),
                "-layout",
                str(pdf_path),
                "-",
            )
        )
        page_text.append(text)
        if len(re.sub(r"\s+", "", text)) < 80:
            raise LatexVerificationError(f"Page {page} has too little readable content.")
        if f"Page {page} of {pages}" not in text:
            raise LatexVerificationError(f"Page {page} lacks the expected page number.")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for heading in section_headings:
            if heading in lines[-4:]:
                raise LatexVerificationError(
                    f"Heading '{heading}' is orphaned at the bottom of page {page}."
                )
        if "Evidence ledger" in text or "Evidence ledger, continued" in text:
            required = ("Claim", "Source", "Relation", "Scope", "Locator", "Evidence SHA-256")
            if not all(label in text for label in required):
                raise LatexVerificationError(
                    f"Evidence table headers did not repeat on page {page}."
                )
    joined = "\n".join(page_text)
    for required_text in ("Litehouse", "Sources", "Evidence ledger", "Verification"):
        if required_text not in joined:
            raise LatexVerificationError(f"The PDF lacks required text: {required_text}.")
    for label in expected_source_labels:
        if f"[{label}]" not in joined:
            raise LatexVerificationError(f"The PDF lacks source reference [{label}].")
    raster_fractions = _raster_audit(pdf_path, pages)
    return PdfAuditResult(
        page_count=pages,
        page_text=tuple(page_text),
        overfull_points=(),
        underfull_badness=(),
        raster_ink_fraction=raster_fractions,
    )


def verify_latex_build(
    document: ReportDocument,
    *,
    tex_path: Path,
    pdf_path: Path,
    manifest_path: Path,
) -> PdfAuditResult:
    manifest = LatexBuildManifest.read(manifest_path)
    source = render_latex(document)
    expected = {
        "canonical input": (manifest.input_sha256, report_input_sha256(document)),
        "template": (manifest.template_sha256, source.template_sha256),
        "TeX": (manifest.tex_sha256, _sha256_file(tex_path)),
        "PDF": (manifest.pdf_sha256, _sha256_file(pdf_path)),
        "logo": (manifest.logo_sha256, _sha256_file(_ASSET_DIR / "litehouse-wordmark.pdf")),
    }
    for label, (recorded, actual) in expected.items():
        if recorded != actual:
            raise LatexVerificationError(f"{label} SHA-256 verification failed.")
    if manifest.asset_sha256 != source.asset_sha256:
        raise LatexVerificationError("Report asset SHA-256 verification failed.")
    if manifest.evidence_sha256 != source.evidence_sha256:
        raise LatexVerificationError("Evidence SHA-256 verification failed.")
    source_labels = tuple(f"W{index}" for index in range(1, len(document.references) + 1))
    audit = audit_pdf(pdf_path, expected_source_labels=source_labels)
    if manifest.page_count != audit.page_count:
        raise LatexVerificationError("The PDF page count differs from the manifest.")
    return audit
