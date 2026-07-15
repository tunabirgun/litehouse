import { Check, Download, ExternalLink, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getBrowserReport } from "./browser/vault";
import { digestCanonical } from "./research/integrity";
import { reportToLatex } from "./research/latex";
import type { GroundedReport } from "./research/report";
import "./browser-vault.css";

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

function ReportBody({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  return (
    <div className="browser-report-copy">
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 24)}`;
        if (!line.trim() || line.startsWith("# ")) return null;
        if (line.startsWith("## ")) return <h2 key={key}>{line.slice(3)}</h2>;
        if (line.startsWith("### ")) return <h3 key={key}>{line.slice(4)}</h3>;
        if (line.startsWith("- ")) return <p className="browser-report-bullet" key={key}>— {line.slice(2)}</p>;
        if (/^\d+\.\s/u.test(line)) return <p className="browser-report-reference" key={key}>{line}</p>;
        return <p key={key}>{line.replaceAll("**", "").replaceAll("`", "")}</p>;
      })}
    </div>
  );
}

export function BrowserReportPage() {
  const { reportId = "" } = useParams();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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
        <Link className="back-link" to="/today">Back to Today</Link>
        <section className={`native-today-state${state.kind === "invalid" ? " is-error" : ""}`} role={state.kind === "invalid" ? "alert" : "status"}>
          <h1>{state.kind === "loading" ? "Opening local report…" : state.kind === "invalid" ? "Integrity check failed" : "Report not found"}</h1>
          <p>{state.kind === "invalid" ? "Litehouse will not render a browser-vault report whose Markdown no longer matches its SHA-256 receipt." : "This report may belong to a different browser profile or may have been removed."}</p>
        </section>
      </main>
    );
  }

  const { report, evidenceVerified } = state;
  return (
    <main id="main-content" className="page browser-report-page" tabIndex={-1}>
      <Link className="back-link" to="/today">Back to Today</Link>
      <header className="report-header">
        <div className="report-heading-copy">
          <p className="eyebrow">Browser-local literature report</p>
          <h1>{report.title}</h1>
          <p className="lede">Evidence-bounded synthesis with source-level retrieval receipts.</p>
        </div>
        <div className="report-actions">
          <button className="button button-secondary" type="button" onClick={() => download(`litehouse-${report.id}.md`, "text/markdown", report.markdown)}><Download aria-hidden="true" size={17} />Markdown</button>
          <button className="button button-secondary" type="button" onClick={() => download(`litehouse-${report.id}.tex`, "application/x-tex", reportToLatex(report))}><Download aria-hidden="true" size={17} />LaTeX</button>
          <button className="button button-secondary" type="button" onClick={() => window.print()}><Download aria-hidden="true" size={17} />Print / PDF</button>
          <button className="button button-secondary" type="button" onClick={() => download(`litehouse-${report.id}.json`, "application/json", JSON.stringify(report, null, 2))}><Download aria-hidden="true" size={17} />Manifest</button>
        </div>
      </header>

      <details className="verification-receipt" open>
        <summary><span className="verification-seal" aria-hidden="true">{evidenceVerified ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}</span><span><small className={`receipt-status${evidenceVerified ? "" : " is-mismatch"}`}>{evidenceVerified ? <><Check size={14} /> verified on open</> : <><TriangleAlert size={14} /> evidence mismatch</>}</small><b>Integrity receipt</b></span></summary>
        <dl className="lh-preparation-stats">
          <div><dt>Report SHA-256</dt><dd><code>{report.reportSha256}</code></dd></div>
          <div><dt>Retrieval SHA-256</dt><dd><code>{report.retrievalSha256}</code></dd></div>
          <div><dt>Accepted records</dt><dd>{report.records.length}</dd></div>
          <div><dt>Synthesis path</dt><dd>{report.synthesis}</dd></div>
        </dl>
        {!evidenceVerified && (
          <p className="receipt-mismatch" role="alert">
            The evidence bundle no longer matches its retrieval SHA-256. Source links are shown as unverified plain text and were not opened as trusted links.
          </p>
        )}
      </details>

      <article className="report-document browser-report-document">
        <ReportBody markdown={report.markdown} />
      </article>

      <section className="browser-report-sources" aria-labelledby="browser-source-links">
        <p className="section-index">Source links</p>
        <h2 id="browser-source-links">Further reading</h2>
        <ol>
          {report.records.map((record, index) => {
            const url = record.openFullTextUrl ?? record.landingUrl;
            return (
              <li key={record.id}>
                <span><b>S{index + 1}</b> {record.title}</span>
                {url && (evidenceVerified
                  ? <a href={url} target="_blank" rel="noopener noreferrer">Open source <ExternalLink aria-hidden="true" size={14} /></a>
                  : <span className="source-url-untrusted">{url}</span>)}
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}
