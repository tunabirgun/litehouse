import type { GroundedReport } from "./report";

// A self-contained LaTeX source for a grounded report. Compile with XeLaTeX or
// LuaLaTeX (Unicode-native; handles non-Latin metadata). The Litehouse wordmark is
// rendered as Garamond text, so the .tex needs no external image and works in Overleaf.

const PREAMBLE = String.raw`% Litehouse report — compile with XeLaTeX or LuaLaTeX (Unicode-native).
\documentclass[11pt,a4paper]{article}
\usepackage[a4paper,margin=2.6cm]{geometry}
\usepackage{ebgaramond}
\usepackage{microtype}
\usepackage{titlesec}
\usepackage{enumitem}
\usepackage{xcolor}
\usepackage[hidelinks,breaklinks=true]{hyperref}
\usepackage{xurl}
\usepackage{fancyhdr}
\emergencystretch=3em
\definecolor{ink}{HTML}{211F1A}\color{ink}
\titleformat{\section}{\large\bfseries}{}{0pt}{}
\titleformat{\subsection}{\normalsize\bfseries\scshape}{}{0pt}{}
\titlespacing*{\section}{0pt}{1.5em}{0.4em}
\titlespacing*{\subsection}{0pt}{1.0em}{0.3em}
\setlist{leftmargin=1.35em,itemsep=0.28em,topsep=0.35em}
\pagestyle{fancy}\fancyhf{}\fancyfoot[C]{\small\thepage}\renewcommand{\headrulewidth}{0pt}
\widowpenalty=10000 \clubpenalty=10000
\setlength{\parskip}{0.55em}\setlength{\parindent}{0pt}\hyphenpenalty=2000
`;

const ESCAPES: Record<string, string> = {
  "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
  "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "\\": "\\textbackslash{}",
};

const escapeSpecials = (v: string) => v.replace(/[&%$#_{}~^\\]/gu, (m) => ESCAPES[m] ?? m);

// Convert one line of report Markdown inline syntax to LaTeX, escaping specials while
// preserving code spans, URLs, bold, and italic. / are Private-Use-Area
// delimiters that never occur in report text and are not LaTeX specials.
function inlineToLatex(input: string): string {
  const codes: string[] = [];
  const urls: string[] = [];
  let s = input.replace(/`([^`]+)`/gu, (_m, c: string) => { codes.push(c); return `${codes.length - 1}`; });
  s = s.replace(/https?:\/\/[^\s)]+/gu, (u) => { urls.push(u.replace(/[.,;]$/u, "")); return `${urls.length - 1}`; });
  s = escapeSpecials(s);
  s = s.replace(/\*\*([^*]+)\*\*/gu, "\\textbf{$1}");
  s = s.replace(/\*([^*]+)\*/gu, "\\textit{$1}");
  s = s.replace(/(\d+)/gu, (_m, i: string) => `\\texttt{${escapeSpecials(codes[+i])}}`);
  s = s.replace(/(\d+)/gu, (_m, i: string) => `\\url{${urls[+i]}}`);
  return s;
}

// Convert the report body Markdown (from the first '## ' onward) to LaTeX blocks.
function blocksToLatex(markdown: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("\\end{itemize}"); inList = false; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (/^\s*-\s+/u.test(line)) {
      if (!inList) { out.push("\\begin{itemize}"); inList = true; }
      out.push(`\\item ${inlineToLatex(line.replace(/^\s*-\s+/u, ""))}`);
      continue;
    }
    closeList();
    if (!line.trim()) { out.push(""); continue; }
    if (line.startsWith("### ")) { out.push(`\\subsection*{${inlineToLatex(line.slice(4))}}`); continue; }
    if (line.startsWith("## ")) { out.push(`\\section*{${inlineToLatex(line.slice(3))}}`); continue; }
    if (line.startsWith("# ")) continue;
    if (/^-{3,}$/u.test(line.trim())) { out.push("\\bigskip\\hrule\\bigskip"); continue; }
    out.push(inlineToLatex(line));
  }
  closeList();
  return out.join("\n");
}

function titlePage(title: string, date: string, sha: string): string {
  return String.raw`\begin{titlepage}\centering
\vspace*{2.4cm}
{\fontsize{40}{46}\selectfont Litehouse\par}\vspace{2.2cm}
{\LARGE\bfseries ${escapeSpecials(title)}\par}\vspace{0.8cm}
{\large\itshape Evidence-locked literature review\par}\vspace{1.8cm}
\rule{0.35\textwidth}{0.4pt}\\[0.7cm]
{\small Generated locally in the browser \\ ${escapeSpecials(date)}\par}\vspace{0.4cm}
{\footnotesize\ttfamily Retrieval SHA-256\\ ${escapeSpecials(sha)}\par}
\vfill
{\footnotesize Litehouse — a lighthouse for scholarship\par}
\end{titlepage}
`;
}

export function reportToLatex(report: GroundedReport): string {
  const date = report.createdAt.slice(0, 10);
  const start = report.markdown.indexOf("## Synthesis");
  const body = start >= 0 ? report.markdown.slice(start) : report.markdown;
  return `${PREAMBLE}\\begin{document}\n${titlePage(report.query, date, report.retrievalSha256)}${blocksToLatex(body)}\n\\end{document}\n`;
}
