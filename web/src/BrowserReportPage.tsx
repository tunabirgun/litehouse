import { Check, Download, ExternalLink, Printer, ShieldAlert, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { deleteBrowserReport, getBrowserReport } from "./browser/vault";
import { digestCanonical } from "./research/integrity";
import { reportToLatex } from "./research/latex";
import { parseInline } from "./research/markdown";
import type { GroundedReport } from "./research/report";
import "./browser-vault.css";

const DELETE_REPORT_BODY =
  "This report is stored only in this browser, with no copy on any server. Deleting it permanently removes the report and its cached evidence from this device, and this cannot be undone. Export it first if you want to keep a copy.";

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ready"; report: GroundedReport; evidenceVerified: boolean };

function download(name: string, mediaType: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: `${mediaType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Lowercase, non-alphanumerics to "-", collapsed and trimmed, for readable export filenames.
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

// Turn bare http(s) URLs in a text run into clickable links (references carry DOI URLs).
// The http(s) test keeps javascript:/data: out even if a stored record was tampered with.
function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>()]+)/gu).map((part, index) => {
    if (/^https?:\/\//iu.test(part)) {
      const clean = part.replace(/[.,;:]+$/u, "");
      const trailing = part.slice(clean.length);
      return (
        <Fragment key={index}>
          <a href={clean} target="_blank" rel="noopener noreferrer nofollow">{clean}</a>{trailing}
        </Fragment>
      );
    }
    return part ? <Fragment key={index}>{part}</Fragment> : null;
  });
}

// Render the report's limited inline Markdown (**strong**, *em*, `code`) honouring the
// backslash escapes escapeMarkdown() adds, so no raw \_ \< or ** leaks onto the page.
function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => {
        if (token.type === "strong") return <strong key={index}>{token.value}</strong>;
        if (token.type === "em") return <em key={index}>{token.value}</em>;
        if (token.type === "code") return <code key={index}>{token.value}</code>;
        return <Fragment key={index}>{linkify(token.value)}</Fragment>;
      })}
    </>
  );
}

function ReportBody({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  return (
    <div className="browser-report-copy">
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 24)}`;
        if (!line.trim() || line.startsWith("# ")) return null;
        if (line.startsWith("## ")) return <h2 key={key}><Inline text={line.slice(3)} /></h2>;
        if (line.startsWith("### ")) return <h3 key={key}><Inline text={line.slice(4)} /></h3>;
        if (/^-{3,}$/u.test(line.trim())) return <hr key={key} />;
        if (line.startsWith("- ")) return <p className="browser-report-bullet" key={key}>— <Inline text={line.slice(2)} /></p>;
        if (/^\d+\.\s/u.test(line)) return <p className="browser-report-reference" key={key}><Inline text={line} /></p>;
        return <p key={key}><Inline text={line} /></p>;
      })}
    </div>
  );
}

export function BrowserReportPage() {
  const { reportId = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    // getBrowserReport verifies the Markdown SHA-256; a mismatch rejects and lands in catch.
    void getBrowserReport(reportId).then(async (report) => {
      if (!active) return;
      if (!report) {
        setState({ kind: "missing" });
        return;
      }
      // Report integrity only covers the Markdown; recompute the evidence-bundle digest before trusting records.
      const evidenceSha = await digestCanonical({
        records: report.records,
        receipts: report.retrievalReceipts,
        requestSha256: report.requestSha256,
        boundaryAudit: report.boundaryAudit,
      });
      if (!active) return;
      setState({ kind: "ready", report, evidenceVerified: evidenceSha === report.retrievalSha256 });
    }).catch(() => active && setState({ kind: "invalid" }));
    return () => { active = false; };
  }, [reportId]);

  if (state.kind !== "ready") {
    return (
      <main id="main-content" className="page browser-report-page" tabIndex={-1}>
        <Link className="back-link" to="/library">Back to Library</Link>
        <section className={`native-today-state${state.kind === "invalid" ? " is-error" : ""}`} role={state.kind === "invalid" ? "alert" : "status"}>
          <h1>{state.kind === "loading" ? "Opening local report…" : state.kind === "invalid" ? "Integrity check failed" : "Report not found"}</h1>
          <p>{state.kind === "invalid" ? "Litehouse will not render a browser-vault report whose Markdown no longer matches its SHA-256 receipt." : "This report may belong to a different browser profile or may have been removed."}</p>
        </section>
      </main>
    );
  }

  const { report, evidenceVerified } = state;
  const fileSlug = slug(report.title).slice(0, 60).replace(/-+$/u, "") || "report";
  const fileBase = `litehouse-${fileSlug}-${report.id.slice(0, 8)}`;
  return (
    <main id="main-content" className="page browser-report-page" tabIndex={-1}>
      <Link className="back-link" to="/library">Back to Library</Link>
      <header className="report-header">
        <div className="report-heading-copy">
          <p className="eyebrow">Browser-local literature report</p>
          <h1>{report.title}</h1>
          <p className="lede">Evidence-bounded synthesis with source-level retrieval receipts.</p>
        </div>
        <div className="report-actions">
          <button className="button button-secondary" type="button" onClick={() => download(`${fileBase}.md`, "text/markdown", report.markdown)}><Download aria-hidden="true" size={17} />Markdown</button>
          <button className="button button-secondary" type="button" onClick={() => download(`${fileBase}.tex`, "application/x-tex", reportToLatex(report))}><Download aria-hidden="true" size={17} />LaTeX</button>
          <button className="button button-secondary" type="button" onClick={() => window.print()}><Printer aria-hidden="true" size={17} />Print / PDF</button>
          <button className="button button-secondary" type="button" onClick={() => download(`${fileBase}.json`, "application/json", JSON.stringify(report, null, 2))}><Download aria-hidden="true" size={17} />Manifest</button>
          <button className="button button-danger" type="button" onClick={() => setConfirmOpen(true)}><Trash2 aria-hidden="true" size={17} />Delete</button>
        </div>
      </header>

      <details className="verification-receipt" open>
        <summary><span className={`verification-seal${evidenceVerified ? "" : " mismatch"}`} aria-hidden="true">{evidenceVerified ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}</span><span><small className={`receipt-status${evidenceVerified ? "" : " is-mismatch"}`}>{evidenceVerified ? <><Check size={14} /> Evidence verified</> : <><TriangleAlert size={14} /> Evidence mismatch</>}</small><b>Integrity receipt</b></span></summary>
        <dl className="lh-preparation-stats">
          <div><dt>Report SHA-256</dt><dd><code>{report.reportSha256}</code></dd></div>
          <div><dt>Retrieval SHA-256</dt><dd><code>{report.retrievalSha256}</code></dd></div>
          <div><dt>Accepted records</dt><dd>{report.records.length}</dd></div>
          <div><dt>Synthesis path</dt><dd>{report.synthesis}</dd></div>
        </dl>
        {!evidenceVerified && (
          <p className="receipt-mismatch" role="alert">
            The evidence bundle no longer matches its retrieval SHA-256, so the stored records may have changed since this report was saved. The source links below are marked unverified — open them with that in mind.
          </p>
        )}
      </details>

      <article className="report-document browser-report-document">
        <ReportBody markdown={report.markdown} />
      </article>

      {report.records.length > 0 && (
        <section className="browser-report-sources" aria-labelledby="browser-source-links">
          <p className="section-index">Source links</p>
          <h2 id="browser-source-links">Further reading</h2>
          <ol>
            {report.records.map((record, index) => {
              const url = record.openFullTextUrl ?? record.landingUrl;
              return (
                <li key={record.id}>
                  <span><b>S{index + 1}</b> {record.title}</span>
                  {url && /^https?:\/\//iu.test(url) && (
                    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={evidenceVerified ? undefined : "source-link-unverified"}>
                      {evidenceVerified ? "Open source" : "Open source · unverified"} <ExternalLink aria-hidden="true" size={14} />
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <ConfirmDeleteDialog
        open={confirmOpen}
        title="Delete this report?"
        body={DELETE_REPORT_BODY}
        confirmLabel="Delete report"
        busy={deleting}
        onConfirm={() => {
          if (deleting) return;
          setDeleting(true);
          void deleteBrowserReport(report.id)
            .then(() => navigate("/library", { state: { status: "Report deleted from this browser." } }))
            .catch(() => { setDeleting(false); setConfirmOpen(false); });
        }}
        onCancel={() => { if (!deleting) setConfirmOpen(false); }}
      />
    </main>
  );
}
