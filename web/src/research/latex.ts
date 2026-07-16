import type { GroundedReport } from "./report";
import { parseInline } from "./markdown";

// A self-contained LaTeX source for a grounded report in the classic Computer Modern
// article style. The default template compiles with pdfLaTeX (authentic Computer Modern
// via lmodern). When the title or body carries non-Latin codepoints, reportToLatex emits
// the XeLaTeX template instead: Latin Modern via fontspec keeps the same look and covers
// Latin, Greek, and Cyrillic. CJK, Arabic, Hebrew and similar scripts need a covering
// font — the emitted .tex header explains how to add one. Both compile in Overleaf.

// Shared packages, box/orphan/widow control, and the breakable-hash macro.
const COMMON_TAIL = String.raw`\usepackage[a4paper,margin=1in]{geometry}
\usepackage{enumitem}
\usepackage{csquotes}
\usepackage{seqsplit}
\usepackage[hidelinks,breaklinks=true]{hyperref}
\usepackage{xurl}
% Break long unbreakable tokens (SHA-256 digests, identifiers) so they never overflow.
\newcommand{\hashtoken}[1]{\texttt{\seqsplit{#1}}}
\setlist{leftmargin=1.5em,itemsep=0.2em,topsep=0.3em}
\widowpenalty=10000
\clubpenalty=10000
\displaywidowpenalty=10000
\emergencystretch=3em
\raggedbottom
`;

// Default: classic Computer Modern via pdfLaTeX.
const PREAMBLE_PDFLATEX = String.raw`% Litehouse report — compile with pdfLaTeX (run it twice).
\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[protrusion=true,expansion=true]{microtype}
` + COMMON_TAIL;

// Fallback for non-Latin metadata: the same Computer Modern look via Latin Modern.
// Fonts are loaded by OTF filename so kpathsea resolves them on any XeLaTeX/LuaLaTeX
// setup (Overleaf, TeX Live, MacTeX) without relying on the OS font database.
const PREAMBLE_XELATEX = String.raw`% Litehouse report — compile with LuaLaTeX or XeLaTeX (run it twice).
% This report contains non-Latin characters. Latin Modern (below) covers Latin, Greek,
% and Cyrillic. For CJK, Arabic, Hebrew, other scripts, or some symbols (e.g. the rupee ₹
% and ruble ₽), compile with LuaLaTeX and add a covering font — otherwise those glyphs are
% dropped. For example, uncomment and adapt:
%   \usepackage{newunicodechar}
%   \newfontfamily\fallbackfont{Noto Serif CJK SC}   % or Noto Naskh Arabic, etc.
%   \newunicodechar{郭}{{\fallbackfont 郭}}
% or set \setmainfont to a broad-coverage font such as Noto Serif.
\documentclass[11pt,a4paper]{article}
\usepackage{fontspec}
\setmainfont{lmroman10-regular.otf}[BoldFont=lmroman10-bold.otf,ItalicFont=lmroman10-italic.otf,BoldItalicFont=lmroman10-bolditalic.otf]
\setsansfont{lmsans10-regular.otf}[BoldFont=lmsans10-bold.otf,ItalicFont=lmsans10-oblique.otf,BoldItalicFont=lmsans10-boldoblique.otf]
\setmonofont{lmmono10-regular.otf}[BoldFont=lmmonolt10-bold.otf,ItalicFont=lmmonolt10-oblique.otf]
\usepackage[protrusion=true]{microtype}
` + COMMON_TAIL;

// pdfLaTeX with T1+lmodern safely covers Basic Latin, Latin-1, and Latin Extended-A
// (Western European and Turkish). Anything past that reaches for the Unicode engine.
function needsUnicodeEngine(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x17f) continue; // Latin blocks — T1-safe
    if (c >= 0x2010 && c <= 0x206f) continue; // general punctuation (dashes, quotes, ellipsis)
    if (c === 0x20ac) continue; // euro — the only currency glyph lmodern/T1 provides (₹ ₽ hard-error on pdfLaTeX)
    if (c === 0x2122) continue; // trademark
    return true;
  }
  return false;
}

const ESCAPES: Record<string, string> = {
  "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
  "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "\\": "\\textbackslash{}",
};

const escapeSpecials = (v: string) => v.replace(/[&%$#_{}~^\\]/gu, (m) => ESCAPES[m] ?? m);

// Escape LaTeX specials, auto-link bare URLs (breaking safely), and apply typographic
// quotes to a run of plain, already-markdown-unescaped text.
function latexText(text: string): string {
  const urls: string[] = [];
  let s = text.replace(/https?:\/\/[^\s)]+/gu, (m) => {
    const trailing = m.match(/[.,;:]+$/u);
    const punct = trailing ? trailing[0] : "";
    urls.push(punct ? m.slice(0, -punct.length) : m);
    return `\uE000${urls.length - 1}\uE001${punct}`;
  });
  s = escapeSpecials(s);
  s = s.replace(/"([^"]*)"/gu, "\\enquote{$1}");
  return s.replace(/\uE000(\d+)\uE001/gu, (_m, i: string) => `\\url{${urls[+i]}}`);
}

// Render one Markdown line to LaTeX. parseInline honours backslash escapes, so
// escapeMarkdown()'d content (\_ \< a literal *) renders correctly and is never
// re-escaped into a visible \textbackslash{}.
function inlineToLatex(input: string): string {
  return parseInline(input).map((token) => {
    if (token.type === "code") return `\\hashtoken{${escapeSpecials(token.value)}}`;
    if (token.type === "strong") return `\\textbf{${latexText(token.value)}}`;
    if (token.type === "em") return `\\textit{${latexText(token.value)}}`;
    return latexText(token.value);
  }).join("");
}

// Convert the report body Markdown (from the first '## ' onward) to LaTeX blocks.
function blocksToLatex(markdown: string): string {
  const out: string[] = [];
  let inList = false;
  let inRefs = false;
  const closeList = () => { if (inList) { out.push("\\end{itemize}"); inList = false; } };
  const closeRefs = () => { if (inRefs) { out.push("\\endgroup"); inRefs = false; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (/^\s*-\s+/u.test(line)) {
      if (!inList) { out.push("\\begin{itemize}"); inList = true; }
      out.push(`\\item ${inlineToLatex(line.replace(/^\s*-\s+/u, ""))}`);
      continue;
    }
    closeList();
    if (!line.trim()) { out.push(""); continue; }
    if (line.startsWith("### ")) { out.push(`\\subsection{${inlineToLatex(line.slice(4))}}`); continue; }
    if (line.startsWith("## ")) {
      closeRefs();
      const heading = line.slice(3);
      out.push(`\\section{${inlineToLatex(heading)}}`);
      // Give the reference list a bibliography-style hanging indent so entries never run together.
      if (/^references\b/iu.test(heading.trim())) {
        out.push("\\begingroup\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{0.55em}");
        inRefs = true;
      }
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (/^-{3,}$/u.test(line.trim())) { closeRefs(); out.push("\\bigskip\\hrule\\bigskip"); continue; }
    if (inRefs) { out.push(`\\hangindent=1.6em\\hangafter=1\\noindent ${inlineToLatex(line)}`); continue; }
    out.push(inlineToLatex(line));
  }
  closeList();
  closeRefs();
  return out.join("\n");
}

// A minimal, functional title block: a restrained small-caps Litehouse wordmark, the
// title, one metadata line (document type and date), and the retrieval digest that
// breaks safely. No separate title page and no redundant author line.
function titleBlock(title: string, date: string, sha: string): string {
  return String.raw`\thispagestyle{empty}
\begin{center}
{\footnotesize\scshape Litehouse}\\[1.15em]
{\LARGE ${escapeSpecials(title)}\par}\vspace{0.7em}
{\footnotesize Evidence-locked literature review \textperiodcentered\ ${escapeSpecials(date)}}\\[0.5em]
{\scriptsize Retrieval SHA-256\enspace\hashtoken{${escapeSpecials(sha)}}}
\end{center}
\vspace{0.4em}
\hrule
\vspace{1.4em}
`;
}

export function reportToLatex(report: GroundedReport): string {
  const date = report.createdAt.slice(0, 10);
  // Start the body at the first section heading (Synthesis or Evidence overview), skipping
  // the H1 title and the intro blurb, which the title block already covers.
  const start = report.markdown.search(/^## /mu);
  const body = start >= 0 ? report.markdown.slice(start) : report.markdown;
  const preamble = needsUnicodeEngine(report.query + report.markdown) ? PREAMBLE_XELATEX : PREAMBLE_PDFLATEX;
  return `${preamble}\\begin{document}\n${titleBlock(report.query, date, report.retrievalSha256)}${blocksToLatex(body)}\n\\end{document}\n`;
}
