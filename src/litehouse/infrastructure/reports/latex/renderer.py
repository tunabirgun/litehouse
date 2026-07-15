from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

from litehouse.domain import (
    ClaimEvidenceRelation,
    ClaimKind,
    canonical_json,
    sha256_text,
)
from litehouse.infrastructure.exports import (
    CitationRenderer,
    CitationStyle,
    ReferenceRecord,
    citation_style_label,
    format_reference_citation,
)
from litehouse.infrastructure.reports.models import ReportDocument, UnsupportedClaimPolicy
from litehouse.infrastructure.reports.renderers import (
    _missing_citation_warnings,
    _ordered_claims,
    _ordered_recommendations,
    _ordered_references,
    _prepare,
)

from .models import LatexSource

_ASSET_DIR = Path(__file__).with_name("assets")
_LOGO_NAME = "litehouse-wordmark.pdf"
_UPRIGHT_FONT = "EBGaramond-Variable.ttf"
_ITALIC_FONT = "EBGaramond-Italic-Variable.ttf"
_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TEMPLATE_REVISION = "litehouse-a4-monochrome-v1"
_TEX_REPLACEMENTS = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "$": r"\$",
    "&": r"\&",
    "#": r"\#",
    "^": r"\textasciicircum{}",
    "_": r"\_",
    "%": r"\%",
    "~": r"\textasciitilde{}",
}

_PREAMBLE = r"""\documentclass[11pt,a4paper]{article}
\usepackage[a4paper,top=24mm,bottom=23mm,left=24mm,right=24mm,headheight=14pt,headsep=7mm,footskip=12mm]{geometry}
\usepackage{fontspec}
\defaultfontfeatures{Ligatures=TeX,Renderer=HarfBuzz}
\setmainfont{EBGaramond-Variable.ttf}[
  Path=fonts/,
  ItalicFont=EBGaramond-Italic-Variable.ttf,
  BoldFont=EBGaramond-Variable.ttf,
  BoldItalicFont=EBGaramond-Italic-Variable.ttf,
  BoldFeatures={RawFeature={+axis={wght=700}}},
  BoldItalicFeatures={RawFeature={+axis={wght=700}}}
]
\usepackage[final,protrusion=true,expansion=false]{microtype}
\usepackage{graphicx}
\usepackage[table]{xcolor}
\definecolor{LiteInk}{gray}{0.12}
\definecolor{LiteMid}{gray}{0.38}
\definecolor{LiteRule}{gray}{0.72}
\definecolor{LiteWash}{gray}{0.95}
\color{LiteInk}
\usepackage{booktabs,longtable,array,ragged2e}
\usepackage{needspace}
\usepackage{enumitem}
\usepackage{fancyhdr,lastpage}
\usepackage[unicode,hidelinks]{hyperref}
\usepackage{xurl}
\urlstyle{same}
\hypersetup{
  pdftitle={Litehouse literature report},
  pdfauthor={Litehouse},
  pdfcreator={Litehouse},
  pdfproducer={XeLaTeX}
}
\setlength{\parindent}{0pt}
\setlength{\parskip}{5.5pt plus 1pt minus 1pt}
\setlist[itemize]{leftmargin=5mm,itemsep=3pt,topsep=3pt}
\setlist[description]{style=nextline,leftmargin=0pt,labelsep=0pt,itemsep=4pt}
\clubpenalty=10000
\widowpenalty=10000
\displaywidowpenalty=10000
\brokenpenalty=10000
\predisplaypenalty=10000
\postdisplaypenalty=0
\emergencystretch=1.6em
\hfuzz=0.5pt
\vfuzz=0.5pt
\newcolumntype{L}[1]{>{\RaggedRight\arraybackslash}p{#1}}
\newcommand{\ReportSection}[1]{\Needspace{7\baselineskip}\section*{#1}\addcontentsline{toc}{section}{#1}\nopagebreak[4]}
\newcommand{\ReportSubsection}[1]{\Needspace{10\baselineskip}\subsection*{#1}\nopagebreak[4]}
\newcommand{\SourceLabel}[1]{\mbox{[\textsc{#1}]}}
\newcommand{\Hash}[1]{{\footnotesize\nolinkurl{#1}}}
\newcommand{\MetaLabel}[1]{{\footnotesize\MakeUppercase{#1}}}
\newcommand{\EvidenceQuote}[1]{\begingroup\leftskip=5mm\rightskip=5mm\small\itshape #1\par\endgroup}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0.35pt}
\renewcommand{\footrulewidth}{0pt}
"""

_STATIC_LAYOUT = (
    "title-block|scope-integrity|supported-findings|system-notes|sources|"
    "bounded-reading-list|evidence-ledger|evidence-excerpts|verification|"
    "longtable-repeat-head-v2"
)


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _asset_hashes() -> dict[str, str]:
    names = (_LOGO_NAME, _UPRIGHT_FONT, _ITALIC_FONT)
    return {name: _sha256_bytes((_ASSET_DIR / name).read_bytes()) for name in names}


def _clean(value: str) -> str:
    return _CONTROL_PATTERN.sub("", value.replace("\r\n", "\n").replace("\r", "\n"))


def tex_escape(value: str, *, line_break: str = r"\newline{}") -> str:
    lines = []
    for line in _clean(value).split("\n"):
        lines.append("".join(_TEX_REPLACEMENTS.get(character, character) for character in line))
    return line_break.join(lines)


def _safe_url(value: str) -> str | None:
    cleaned = _clean(value).strip()
    try:
        parsed = urlsplit(cleaned)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        host = parsed.hostname.encode("idna").decode("ascii")
        port = "" if parsed.port is None else f":{parsed.port}"
        netloc = f"[{host}]{port}" if ":" in host else f"{host}{port}"
        path = quote(parsed.path, safe="/%:@!$&'()*+,;=-._~")
        query = quote(parsed.query, safe="=&%:@!$'()*+,;/?-._~")
        fragment = quote(parsed.fragment, safe="%:@!$&'()*+,;=/?-._~")
        return urlunsplit((parsed.scheme, netloc, path, query, fragment))
    except (UnicodeError, ValueError):
        return None


def _url(value: str) -> str:
    safe = _safe_url(value)
    if safe is None:
        return tex_escape(value)
    argument = safe.replace("%", r"\%").replace("#", r"\#")
    return rf"\href{{{argument}}}{{\nolinkurl{{{argument}}}}}"


def _document_payload(document: ReportDocument) -> dict[str, object]:
    references: list[dict[str, object]] = []
    for record in _ordered_references(document):
        references.append(
            {
                "work": {
                    "contributors": [
                        {
                            "name": contributor.name,
                            "position": contributor.position,
                            "role": contributor.role,
                        }
                        for contributor in record.work.contributors
                    ],
                    "id": record.work.id,
                    "identifiers": [
                        {"namespace": item.namespace, "value": item.value}
                        for item in sorted(
                            record.work.identifiers,
                            key=lambda item: (item.namespace, item.value),
                        )
                    ],
                    "kind": record.work.kind.value,
                    "title": record.work.title,
                },
                "metadata": {
                    "attachment_warnings": list(record.metadata.attachment_warnings),
                    "container_title": record.metadata.container_title,
                    "edition": record.metadata.edition,
                    "issue": record.metadata.issue,
                    "issued": (
                        None if record.metadata.issued is None else record.metadata.issued.isoformat
                    ),
                    "language": record.metadata.language,
                    "license_name": record.metadata.license_name,
                    "license_url": record.metadata.license_url,
                    "pages": record.metadata.pages,
                    "provenance": [
                        {
                            "record_id": item.record_id,
                            "retrieved_at": item.retrieved_at.isoformat(),
                            "sha256": item.sha256,
                            "source": item.source,
                            "url": item.url,
                        }
                        for item in record.metadata.provenance
                    ],
                    "publisher": record.metadata.publisher,
                    "publisher_place": record.metadata.publisher_place,
                    "url": record.metadata.url,
                    "volume": record.metadata.volume,
                },
            }
        )
    return {
        "citation_style": document.citation_style.value,
        "claims": [
            {"id": claim.id, "kind": claim.kind.value, "text": claim.text}
            for claim in _ordered_claims(document)
        ],
        "evidence_links": [
            {
                "claim_id": link.claim_id,
                "evidence_segment_id": link.evidence_segment_id,
                "relation": link.relation.value,
            }
            for link in sorted(
                document.evidence_links,
                key=lambda link: (
                    link.claim_id,
                    link.evidence_segment_id,
                    link.relation.value,
                ),
            )
        ],
        "evidence_segments": [
            {
                "id": segment.id,
                "locator": segment.locator,
                "scope": segment.scope.value,
                "sha256": segment.sha256,
                "text": segment.text,
                "work_id": segment.work_id,
            }
            for segment in sorted(document.evidence_segments, key=lambda segment: segment.id)
        ],
        "generated_at": document.generated_at.isoformat(),
        "id": document.id,
        "recommendations": [
            {
                "evidence_segment_ids": list(recommendation.evidence_segment_ids),
                "rank": recommendation.rank,
                "rationale": list(recommendation.rationale),
                "work_id": recommendation.work_id,
            }
            for recommendation in _ordered_recommendations(document)
        ],
        "references": references,
        "title": document.title,
    }


def report_input_sha256(document: ReportDocument) -> str:
    return sha256_text(canonical_json(_document_payload(document)))


def _source_entry(record: ReferenceRecord, style: CitationStyle) -> str:
    return format_reference_citation(
        record,
        style,
        renderer=CitationRenderer(
            escape=tex_escape,
            italic=lambda value: rf"\textit{{{value}}}",
            url=_url,
        ),
    )


def _target(kind: str, identifier: str) -> str:
    return f"litehouse-{kind}-{sha256_text(identifier)[:16]}"


def _identifier_text(record: ReferenceRecord) -> str:
    if not record.work.identifiers:
        return "No persistent identifier supplied."
    return "; ".join(
        rf"\textsc{{{tex_escape(item.namespace)}}}: {tex_escape(item.value)}"
        for item in sorted(record.work.identifiers, key=lambda item: (item.namespace, item.value))
    )


def _provenance_text(record: ReferenceRecord) -> str:
    if not record.metadata.provenance:
        return "No retrieval provenance supplied."
    rendered: list[str] = []
    for item in record.metadata.provenance:
        parts = [
            tex_escape(item.source),
            tex_escape(item.record_id),
            tex_escape(item.retrieved_at.isoformat()),
        ]
        if item.sha256 is not None:
            parts.append(rf"SHA-256 \Hash{{{item.sha256}}}")
        if item.url is not None:
            parts.append(_url(item.url))
        rendered.append("; ".join(parts))
    return r"\newline{}".join(rendered)


def _join_labels(labels: Iterable[str]) -> str:
    return ", ".join(rf"\SourceLabel{{{tex_escape(label)}}}" for label in sorted(set(labels)))


def render_latex(
    document: ReportDocument,
    *,
    unsupported_policy: UnsupportedClaimPolicy = UnsupportedClaimPolicy.REFUSE,
) -> LatexSource:
    unsupported, source_labels, links_by_claim = _prepare(document, unsupported_policy)
    unsupported_set = set(unsupported)
    input_sha256 = report_input_sha256(document)
    assets = _asset_hashes()
    template_sha256 = sha256_text(_TEMPLATE_REVISION + "\n" + _PREAMBLE + _STATIC_LAYOUT)
    claims = {claim.id: claim for claim in document.claims}
    evidence = {segment.id: segment for segment in document.evidence_segments}
    lines = [
        _PREAMBLE,
        r"\fancyhead[L]{\footnotesize\textsc{Litehouse}}",
        rf"\fancyhead[R]{{\footnotesize Report {tex_escape(document.id)}}}",
        rf"\fancyfoot[L]{{\scriptsize Input SHA-256: \texttt{{{input_sha256[:16]}}}}}",
        r"\fancyfoot[R]{\scriptsize Page \thepage\ of \pageref*{LastPage}}",
        r"\begin{document}",
        r"\begin{minipage}[t]{0.31\textwidth}",
        r"\includegraphics[width=37mm]{litehouse-wordmark.pdf}",
        r"\end{minipage}\hfill",
        r"\begin{minipage}[t]{0.65\textwidth}\RaggedLeft",
        r"{\footnotesize\color{LiteMid}\MakeUppercase{Verified literature report}}\\[4pt]",
        rf"{{\Large\bfseries {tex_escape(document.title, line_break=r'\par ')}}}\\[7pt]",
        rf"{{\small Generated {tex_escape(document.generated_at.isoformat())}}}",
        r"\end{minipage}",
        r"\vspace{4mm}\par\color{LiteRule}\hrule\color{LiteInk}\vspace{3mm}",
        r"\begin{longtable}{@{}L{0.25\textwidth}L{0.69\textwidth}@{}}",
        r"\MetaLabel{Report ID} & " + tex_escape(document.id) + r" \\",
        r"\MetaLabel{Citation mode} & "
        + tex_escape(citation_style_label(document.citation_style))
        + r" source listing \\",
        r"\MetaLabel{Input SHA-256} & \Hash{" + input_sha256 + r"} \\",
        r"\MetaLabel{Evidence set} & "
        + f"{len(document.evidence_segments)} segments; {len(document.evidence_links)} links"
        + r" \\",
        r"\end{longtable}",
        r"\ReportSection{Scope and integrity}",
        (
            "Litehouse generated this report from canonical source metadata and hashed evidence "
            "segments. Every sourced finding below resolves to at least one supporting segment. "
            "Source entries apply the requested citation style only to available metadata. "
            "Missing fields are visibly marked, and contributor name parts are never inferred."
        ),
        r"\ReportSection{Supported findings}",
        r"\begin{itemize}",
    ]
    supported = [
        claim
        for claim in _ordered_claims(document)
        if claim.kind is ClaimKind.SOURCED and claim.id not in unsupported_set
    ]
    if supported:
        for claim in supported:
            labels = [
                source_labels[segment.work_id]
                for link, segment in links_by_claim.get(claim.id, ())
                if link.relation is ClaimEvidenceRelation.SUPPORTS
            ]
            lines.append(rf"\item {tex_escape(claim.text)} {_join_labels(labels)}")
    else:
        lines.append(r"\item No evidence-supported findings were supplied.")
    lines.append(r"\end{itemize}")
    system_claims = [claim for claim in _ordered_claims(document) if claim.kind is ClaimKind.SYSTEM]
    if system_claims:
        lines.extend([r"\ReportSection{System notes}", r"\begin{itemize}"])
        lines.extend(rf"\item {tex_escape(claim.text)}" for claim in system_claims)
        lines.append(r"\end{itemize}")
    if unsupported:
        lines.extend(
            [
                r"\ReportSection{Unsupported claims}",
                "These statements are excluded from the supported findings.",
                r"\begin{itemize}",
            ]
        )
        lines.extend(
            rf"\item \textbf{{Unsupported:}} {tex_escape(claim.text)}"
            for claim in _ordered_claims(document)
            if claim.id in unsupported_set
        )
        lines.append(r"\end{itemize}")
    if document.recommendations:
        references = {record.work.id: record for record in document.references}
        lines.extend(
            [
                r"\ReportSection{Bounded reading list}",
                "These recommendations prioritize closer reading using the visible retrieval "
                "and ranking signals below. They do not establish scientific truth, study "
                "quality, or fitness for a particular use.",
                r"\begin{itemize}",
            ]
        )
        for recommendation in _ordered_recommendations(document):
            record = references[recommendation.work_id]
            rationale = "; ".join(tex_escape(item) for item in recommendation.rationale)
            source_target = _target("source", recommendation.work_id)
            evidence_links = ", ".join(
                rf"\hyperlink{{{_target('evidence', segment_id)}}}"
                rf"{{\Hash{{{segment_id}}}}} "
                rf"({tex_escape(evidence[segment_id].scope.value.replace('_', ' '))})"
                for segment_id in recommendation.evidence_segment_ids
            )
            if not evidence_links:
                evidence_links = "No report evidence excerpt was available for this work."
            lines.extend(
                [
                    r"\Needspace{7\baselineskip}",
                    rf"\item \textbf{{{recommendation.rank}.}} "
                    rf"\hyperlink{{{source_target}}}"
                    rf"{{\SourceLabel{{{tex_escape(source_labels[recommendation.work_id])}}}}} "
                    rf"\textbf{{{tex_escape(record.work.title)}}}\par",
                    rf"\small\MetaLabel{{Ranking rationale}} {rationale}\newline{{}}",
                    rf"\MetaLabel{{Evidence links}} {evidence_links}\normalsize",
                ]
            )
        lines.append(r"\end{itemize}")
    style_label = citation_style_label(document.citation_style)
    lines.extend(
        [
            r"\ReportSection{Sources}",
            f"{tex_escape(style_label)} presentation uses the canonical metadata shown here. "
            "Names remain in the order and spelling supplied by the source record; explicit "
            "warnings identify incomplete fields.",
            r"\begin{description}",
        ]
    )
    for record in _ordered_references(document):
        label = source_labels[record.work.id]
        warnings = _missing_citation_warnings(record)
        lines.extend(
            [
                rf"\hypertarget{{{_target('source', record.work.id)}}}{{}}",
                rf"\item[\SourceLabel{{{tex_escape(label)}}}] "
                + _source_entry(record, document.citation_style),
                r"\Needspace{3\baselineskip}\begingroup\small\color{LiteMid}",
                rf"\MetaLabel{{Type}} {tex_escape(record.work.kind.value.replace('_', ' '))}"
                + r"\quad "
                + rf"\MetaLabel{{Identifiers}} {_identifier_text(record)}\newline{{}}",
                rf"\MetaLabel{{Provenance}} {_provenance_text(record)}",
            ]
        )
        if warnings:
            lines.append(
                r"\newline{}\MetaLabel{Citation warnings} "
                + r"\newline{}".join(tex_escape(warning) for warning in warnings)
            )
        lines.append(r"\par\endgroup")
    lines.extend(
        [
            r"\end{description}",
            r"\Needspace{16\baselineskip}",
            r"\ReportSection{Evidence ledger}",
            r"\small",
            r"\setlength{\LTpre}{2pt}\setlength{\LTpost}{4pt}\setlength{\tabcolsep}{3pt}",
            r"\begin{longtable}{@{}L{0.105\textwidth}L{0.085\textwidth}"
            r"L{0.135\textwidth}L{0.09\textwidth}L{0.22\textwidth}"
            r"L{0.245\textwidth}@{}}",
            r"\toprule",
            r"\textbf{Claim} & \textbf{Source} & \textbf{Relation} & "
            r"\textbf{Scope} & \textbf{Locator} & \textbf{Evidence SHA-256} \\",
            r"\midrule\endfirsthead",
            r"\multicolumn{6}{@{}l}{\footnotesize\color{LiteMid}Evidence ledger, continued}\\[2pt]",
            r"\toprule",
            r"\textbf{Claim} & \textbf{Source} & \textbf{Relation} & "
            r"\textbf{Scope} & \textbf{Locator} & \textbf{Evidence SHA-256} \\",
            r"\midrule\endhead",
            r"\midrule\multicolumn{6}{r@{}}{\footnotesize Continued on next page}\\\endfoot",
            r"\bottomrule\endlastfoot",
        ]
    )
    targeted_evidence: set[str] = set()
    for link in sorted(
        document.evidence_links,
        key=lambda item: (item.claim_id, item.evidence_segment_id, item.relation.value),
    ):
        segment = evidence[link.evidence_segment_id]
        lines.append(
            rf"\Hash{{{link.claim_id}}}"
            + " & "
            + rf"\SourceLabel{{{tex_escape(source_labels[segment.work_id])}}}"
            + " & "
            + tex_escape(link.relation.value)
            + " & "
            + tex_escape(segment.scope.value.replace("_", " "))
            + " & "
            + tex_escape(segment.locator)
            + " & "
            + rf"\Hash{{{segment.sha256}}} \\"
        )
    if not document.evidence_links:
        lines.append(r"\multicolumn{6}{@{}l}{No claim-to-evidence links were supplied.}\\")
    lines.extend([r"\end{longtable}", r"\normalsize", r"\ReportSubsection{Evidence excerpts}"])
    for link in sorted(
        document.evidence_links,
        key=lambda item: (item.claim_id, item.evidence_segment_id, item.relation.value),
    ):
        segment = evidence[link.evidence_segment_id]
        claim = claims[link.claim_id]
        target = ""
        if segment.id not in targeted_evidence:
            target = rf"\hypertarget{{{_target('evidence', segment.id)}}}{{}}"
            targeted_evidence.add(segment.id)
        lines.extend(
            [
                r"\Needspace{8\baselineskip}",
                target + rf"\textbf{{\Hash{{{link.claim_id}}}}} "
                + rf"\SourceLabel{{{tex_escape(source_labels[segment.work_id])}}}"
                + rf"\quad\small {tex_escape(link.relation.value)}; "
                + rf"{tex_escape(segment.locator)}\normalsize",
                rf"\EvidenceQuote{{{tex_escape(segment.text, line_break=r'\par ')}}}",
                rf"\footnotesize\MetaLabel{{Claim}} {tex_escape(claim.text)}\newline{{}}",
                rf"\MetaLabel{{Evidence SHA-256}} \Hash{{{segment.sha256}}}\normalsize\par",
            ]
        )
    lines.extend(
        [
            r"\Needspace{10\baselineskip}",
            r"\ReportSection{Verification}",
            "Recompute SHA-256 values from the saved TeX, PDF, template assets, canonical report "
            "input, and evidence text. The adjacent JSON manifest records each expected value.",
            r"\par\smallskip\noindent",
            r"\begin{tabular}{@{}L{0.27\textwidth}L{0.67\textwidth}@{}}",
            r"\toprule\textbf{Object} & \textbf{SHA-256}\\\midrule",
            r"Canonical report input & \Hash{" + input_sha256 + r"}\\",
            r"Template & \Hash{" + template_sha256 + r"}\\",
            r"Approved Litehouse logo & \Hash{" + assets[_LOGO_NAME] + r"}\\",
            r"\bottomrule\end{tabular}",
            r"\label{LastPageAnchor}",
            r"\end{document}",
            "",
        ]
    )
    return LatexSource(
        content="\n".join(lines),
        input_sha256=input_sha256,
        template_sha256=template_sha256,
        logo_sha256=assets[_LOGO_NAME],
        asset_sha256=assets,
        evidence_sha256={
            segment.id: segment.sha256
            for segment in sorted(document.evidence_segments, key=lambda segment: segment.id)
        },
    )
