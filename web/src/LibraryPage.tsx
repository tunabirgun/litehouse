import {
  BookMarked,
  Check,
  ChevronDown,
  Ellipsis,
  FileDown,
  FileText,
  Hash,
  Search,
  ShieldCheck,
  Tags,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import {
  type IntegrityState,
  type LibraryExportArtifact,
  type LibraryItemFixture,
  type LibraryReadingState,
  libraryFixtures,
} from "./library-fixtures";
import { getBrowserReport, listBrowserReports } from "./browser/vault";
import { sha256Hex } from "./research/integrity";
import type { GroundedReport } from "./research/report";
import { detectShortcutPlatform, formatShortcut } from "./shortcuts";

const copy = {
  eyebrow: "Local research vault",
  title: "Library",
  lede: "Articles, books, reports, notes, and rendered reviews stay searchable with their source and integrity state.",
  fixture: "Demonstration records",
  fixtureHelp: "The records below test multidisciplinary library workflows. They are not the result of a live search in this session.",
  live: "Local vault records",
  liveHelp: "These records and hashes come from the authenticated local vault on this device.",
  browserLive: "Browser-local reports",
  browserLiveHelp: "These reports stay in this browser profile. Litehouse verifies their Markdown against the stored SHA-256 receipt before opening or downloading it.",
  loading: "Loading the local vault…",
  loadFailed: "The local vault could not be loaded. No demonstration records were substituted.",
  search: "Search title, author, venue, identifier, or tag",
  discipline: "Discipline",
  state: "Reading state",
  integrity: "Integrity",
  collection: "Collection",
  filters: "Filters",
  activeFilters: "{{count}} active",
  all: "All",
  unread: "Unread",
  reading: "Reading",
  read: "Read",
  verified: "SHA verified",
  changed: "File changed",
  metadataOnly: "Metadata only",
  results: "{{count}} library items",
  noResults: "No library items match these filters.",
  clear: "Clear filters",
  open: "Open",
  openReader: "Open in reader",
  openRecord: "Open evidence record",
  markRead: "Mark as read",
  markUnread: "Mark as unread",
  verify: "Verify SHA-256",
  export: "Export artifact",
  exportTitle: "Export {{title}}",
  exportIntro: "Choose one verified vault artifact. Every export is rehashed before the native save dialog opens.",
  exportClose: "Close export chooser",
  exportIntegrity: "SHA-256 receipt",
  reportPdf: "Rendered report · PDF",
  articlePdf: "Article · PDF",
  reportMarkdown: "Report · Markdown",
  reportManifest: "Report · JSON manifest",
  reportText: "Report · plain text",
  reportLatex: "LaTeX source · TEX",
  cslJson: "References · CSL JSON",
  ris: "References · RIS",
  bibtex: "References · BibTeX",
  biblatex: "References · BibLaTeX",
  endnoteXml: "References · EndNote XML",
  exported: "Exported {{name}} after SHA-256 verification.",
  exportFailed: "The verified artifact could not be exported.",
  fileChanged: "{{title}} no longer matches its stored SHA-256 receipt. The file changed since it was saved.",
  addCollection: "Add to collection",
  menu: "More actions for {{title}}",
  tags: "Tags",
  recordDetails: "Collection, tags, and integrity receipt",
  source: "Source",
  access: "Access",
  checked: "Integrity check completed for {{title}}.",
  noteOpen: "A verified or local full-text file opens in the reader. Abstract-only records open their evidence record.",
  openFull: "Open full text",
  abstractOnly: "Abstract only",
  localCopy: "Local copy",
  acquire: "Save open-access PDF",
  acquireTitle: "Save from an approved repository",
  acquireIntro: "Enter a repository identifier. Litehouse constructs the official address; arbitrary download URLs are never accepted.",
  provider: "Repository",
  recordTitle: "Article title",
  identifier: "Repository identifier",
  exactPath: "Canonical PMC OA PDF path",
  arxivHelp: "Example: 2607.01234 or hep-th/9901001v2",
  pmcHelp: "Use the exact path from the PMC Open Access file list, such as /pub/pmc/oa_pdf/ab/cd/file.PMC1234567.pdf.",
  acquisitionPolicy: "Only fixed arXiv and PMC hosts are allowed. Redirects are refused, the PDF is capped at 100 MiB, and its SHA-256 is verified before registration.",
  licenseCaveat: "Open-access evidence does not establish a reuse license. Litehouse records no license unless a separate license has been verified.",
  cancel: "Cancel",
  save: "Save verified PDF",
  saving: "Saving and verifying…",
  saved: "Verified PDF saved",
  savedDetail: "Receipt SHA-256",
  close: "Close",
  acquisitionFailed: "The repository PDF could not be saved. Check the canonical identifier and try again.",
} as const;

const disciplineLabels = {
  arts: "Arts",
  humanities: "Humanities",
  "life-sciences": "Life sciences",
  "natural-sciences": "Natural sciences",
  "social-sciences": "Social sciences",
  technology: "Technology",
  interdisciplinary: "Interdisciplinary",
} as const;

type ContextMenuState = { itemId: string; x: number; y: number } | null;

function browserReportManifest(report: GroundedReport): string {
  return JSON.stringify(report, null, 2);
}

function downloadBrowserText(name: string, mediaType: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: `${mediaType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function LibraryPage() {
  const c = copy;
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [discipline, setDiscipline] = useState("all");
  const [readingFilter, setReadingFilter] = useState("all");
  const [integrityFilter, setIntegrityFilter] = useState("all");
  const [collection, setCollection] = useState("all");
  const [readingStates, setReadingStates] = useState<Record<string, LibraryReadingState>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [status, setStatus] = useState("");
  const [exportItemId, setExportItemId] = useState<string | null>(null);
  const [items, setItems] = useState<readonly LibraryItemFixture[]>([]);
  const [vaultState, setVaultState] = useState<"loading" | "live" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    void listBrowserReports()
      .then(async (reports) => Promise.all(reports.map(async (report) => {
        const manifest = browserReportManifest(report);
        const [actualReportSha, manifestSha] = await Promise.all([
          sha256Hex(report.markdown),
          sha256Hex(manifest),
        ]);
        const verified = actualReportSha === report.reportSha256;
        const year = new Date(report.createdAt).getUTCFullYear();
        return {
          id: `browser-report:${report.id}`,
          title: report.title,
          authors: "Litehouse browser synthesis",
          venue: report.synthesis === "llm-validated" ? "Evidence-bounded LLM synthesis" : "Deterministic evidence listing",
          year: Number.isFinite(year) ? year : new Date().getUTCFullYear(),
          discipline: "interdisciplinary" as const,
          kind: "report" as const,
          readingState: "unread" as const,
          integrity: verified ? "verified" as const : "changed" as const,
          access: "local-copy" as const,
          tags: ["browser-local", "literature report", report.synthesis],
          collection: "Browser reports",
          identifier: `litehouse:browser-report:${report.id}`,
          sha256: report.reportSha256,
          live: true,
          browserReportId: report.id,
          exportArtifacts: verified ? [{
            id: `${report.id}:markdown`,
            kind: "report_markdown",
            mediaType: "text/markdown",
            sha256: report.reportSha256,
          }, {
            id: `${report.id}:manifest`,
            kind: "report_manifest",
            mediaType: "application/json",
            sha256: manifestSha,
          }] : [],
        } satisfies LibraryItemFixture;
      })))
      .then((records) => {
        if (!cancelled) {
          setItems(records);
          setVaultState("live");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setVaultState("error");
          setStatus(c.loadFailed);
        }
      });
    return () => { cancelled = true; };
  }, [c.loadFailed]);

  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener("litehouse:library-search", focusSearch);
    return () => window.removeEventListener("litehouse:library-search", focusSearch);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), 0);
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", close);
    };
  }, [contextMenu]);

  // Horizontal is clamped in the inline style (fixed 236px menu width). Here we clamp
  // the bottom edge using the measured height so a menu opened low never spills off.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!contextMenu || !el) return;
    const { height } = el.getBoundingClientRect();
    if (contextMenu.y + height + 8 > window.innerHeight) {
      el.style.top = `${Math.max(8, window.innerHeight - height - 8)}px`;
    }
  }, [contextMenu]);

  const allItems = useMemo(() => [...libraryFixtures, ...items], [items]);
  const collections = useMemo(() => [...new Set(allItems.map((item) => item.collection))].sort(), [allItems]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en");
    return allItems.filter((item) => {
      const state = readingStates[item.id] ?? item.readingState;
      const searchable = [item.title, item.authors, item.venue, item.identifier, ...item.tags]
        .join(" ")
        .toLocaleLowerCase("en");
      return (
        (!needle || searchable.includes(needle)) &&
        (discipline === "all" || item.discipline === discipline) &&
        (readingFilter === "all" || state === readingFilter) &&
        (integrityFilter === "all" || item.integrity === integrityFilter) &&
        (collection === "all" || item.collection === collection)
      );
    });
  }, [allItems, collection, discipline, integrityFilter, query, readingFilter, readingStates]);
  const demoItems = useMemo(() => filtered.filter((item) => !item.live), [filtered]);
  const liveItems = useMemo(() => filtered.filter((item) => item.live), [filtered]);

  const closeExport = useCallback(() => {
    setExportItemId(null);
    window.setTimeout(() => menuReturnFocus.current?.focus(), 0);
  }, []);
  const activeFilterCount = [discipline, readingFilter, integrityFilter, collection]
    .filter((value) => value !== "all").length;

  function clearFilters() {
    setQuery("");
    setDiscipline("all");
    setReadingFilter("all");
    setIntegrityFilter("all");
    setCollection("all");
    searchRef.current?.focus();
  }

  function openMenu(itemId: string, x: number, y: number, trigger?: HTMLElement) {
    menuReturnFocus.current = trigger ?? null;
    setContextMenu({
      itemId,
      x: Math.min(x, window.innerWidth - 244),
      y: Math.min(y, window.innerHeight - 260),
    });
  }

  function closeMenu(restoreFocus = false) {
    const target = menuReturnFocus.current;
    setContextMenu(null);
    if (restoreFocus && target) window.setTimeout(() => target.focus(), 0);
  }

  function toggleRead(item: LibraryItemFixture) {
    const current = readingStates[item.id] ?? item.readingState;
    setReadingStates((states) => ({ ...states, [item.id]: current === "read" ? "unread" : "read" }));
    closeMenu();
  }

  async function verify(item: LibraryItemFixture) {
    if (item.browserReportId) {
      try {
        const report = await getBrowserReport(item.browserReportId);
        if (!report) throw new Error("browser report missing");
        const intact = await sha256Hex(report.markdown) === report.reportSha256;
        setItems((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, integrity: intact ? "verified" : "changed" }
          : candidate));
        setStatus(intact ? c.checked.replace("{{title}}", item.title) : c.fileChanged.replace("{{title}}", item.title));
      } catch {
        setStatus(c.loadFailed);
      }
      closeMenu();
      return;
    }
    setStatus(c.checked.replace("{{title}}", item.title));
    closeMenu();
  }

  async function exportArtifact(item: LibraryItemFixture, artifact: LibraryExportArtifact, suggestedName: string) {
    if (item.browserReportId) {
      try {
        const report = await getBrowserReport(item.browserReportId);
        if (!report) throw new Error("browser report missing");
        const value = artifact.kind === "report_manifest" ? browserReportManifest(report) : report.markdown;
        if (await sha256Hex(value) !== artifact.sha256) {
          setItems((current) => current.map((candidate) => candidate.id === item.id
            ? { ...candidate, integrity: "changed" }
            : candidate));
          throw new Error("browser report changed");
        }
        const extension = artifact.kind === "report_manifest" ? "json" : "md";
        downloadBrowserText(`litehouse-${report.id}-${suggestedName}.${extension}`, artifact.mediaType, value);
        setStatus(c.exported.replace("{{name}}", `${suggestedName}.${extension}`));
      } catch {
        setStatus(c.exportFailed);
      }
      return;
    }
  }

  const contextItem = contextMenu ? allItems.find((item) => item.id === contextMenu.itemId) : undefined;
  const exportItem = exportItemId ? allItems.find((item) => item.id === exportItemId) : undefined;

  return (
    <main id="main-content" className="page lh-library-page" tabIndex={-1}>
      <header className="page-heading lh-workspace-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
      </header>
      <section className="lh-library-tools" aria-label="Library search and filters">
        <label className="lh-library-search"><Search aria-hidden="true" size={18} /><span className="sr-only">{c.search}</span><input ref={searchRef} type="search" placeholder={c.search} value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>{formatShortcut("Mod+Shift+F", detectShortcutPlatform())}</kbd></label>
        <details className="lh-library-filter-disclosure">
          <summary>{c.filters}{activeFilterCount > 0 && <span>{c.activeFilters.replace("{{count}}", String(activeFilterCount))}</span>}</summary>
          <div className="lh-library-filters">
            <FilterSelect label={c.discipline} value={discipline} onChange={setDiscipline} options={Object.entries(disciplineLabels)} allLabel={c.all} />
            <FilterSelect label={c.state} value={readingFilter} onChange={setReadingFilter} options={[["unread", c.unread], ["reading", c.reading], ["read", c.read]]} allLabel={c.all} />
            <FilterSelect label={c.integrity} value={integrityFilter} onChange={setIntegrityFilter} options={[["verified", c.verified], ["changed", c.changed], ["metadata-only", c.metadataOnly]]} allLabel={c.all} />
            <FilterSelect label={c.collection} value={collection} onChange={setCollection} options={collections.map((value) => [value, value])} allLabel={c.all} />
          </div>
        </details>
      </section>

      <div className="lh-result-heading">
        <p aria-live="polite">{c.results.replace("{{count}}", String(filtered.length))}</p>
        {(query || discipline !== "all" || readingFilter !== "all" || integrityFilter !== "all" || collection !== "all") && <button type="button" onClick={clearFilters}>{c.clear}</button>}
      </div>

      {filtered.length ? (
        <>
          {demoItems.length > 0 && (
            <section className="lh-library-section" aria-labelledby="library-demo-heading">
              <aside className="lh-fixture-notice">
                <BookMarked aria-hidden="true" size={19} />
                <div>
                  <h2 id="library-demo-heading">{c.fixture}</h2>
                  <p>{c.fixtureHelp}</p>
                </div>
              </aside>
              <div className="lh-library-list">
                {demoItems.map((item) => (
                  <LibraryCard key={item.id} item={item} state={readingStates[item.id] ?? item.readingState} c={c} onMenu={openMenu} />
                ))}
              </div>
            </section>
          )}
          {(liveItems.length > 0 || vaultState !== "live") && (
            <section className="lh-library-section" aria-labelledby="library-live-heading">
              <aside className="lh-fixture-notice">
                <BookMarked aria-hidden="true" size={19} />
                <div>
                  <h2 id="library-live-heading">{c.browserLive}</h2>
                  <p>{vaultState === "loading" ? c.loading : vaultState === "error" ? c.loadFailed : c.browserLiveHelp}</p>
                </div>
              </aside>
              {liveItems.length > 0 && (
                <div className="lh-library-list">
                  {liveItems.map((item) => (
                    <LibraryCard key={item.id} item={item} state={readingStates[item.id] ?? item.readingState} c={c} onMenu={openMenu} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        <div className="lh-empty-library"><Search aria-hidden="true" size={24} /><p>{c.noResults}</p><button className="button button-secondary" type="button" onClick={clearFilters}>{c.clear}</button></div>
      )}
      <p className="lh-reader-note"><FileText aria-hidden="true" size={17} /> {c.noteOpen}</p>
      {!exportItemId && <p className="sr-only" role="status" aria-live="polite">{status}</p>}

      {contextMenu && contextItem && createPortal(
        <div
          ref={menuRef}
          className="lh-context-menu"
          role="menu"
          aria-label={c.menu.replace("{{title}}", contextItem.title)}
          style={{
            left: Math.min(Math.max(8, contextMenu.x), Math.max(8, window.innerWidth - 244)),
            top: Math.max(8, contextMenu.y),
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu(true);
            }
          }}
        >
          {contextItem.live && !contextItem.artifactId && !contextItem.browserReportId
            ? <button role="menuitem" type="button" disabled><FileText aria-hidden="true" size={16} />{c.openRecord}</button>
            : <Link role="menuitem" to={openPathFor(contextItem)}><FileText aria-hidden="true" size={16} />{contextItem.access === "abstract-only" ? c.openRecord : c.openReader}</Link>}
          {(!contextItem.live || contextItem.browserReportId) && <button role="menuitem" type="button" onClick={() => toggleRead(contextItem)}><Check aria-hidden="true" size={16} />{(readingStates[contextItem.id] ?? contextItem.readingState) === "read" ? c.markUnread : c.markRead}</button>}
          <button role="menuitem" type="button" onClick={() => void verify(contextItem)} disabled={contextItem.browserReportId ? !contextItem.sha256 : contextItem.live ? !contextItem.verificationArtifactId : !contextItem.sha256}><Hash aria-hidden="true" size={16} />{c.verify}</button>
          <button role="menuitem" type="button" disabled={!contextItem.browserReportId || !contextItem.live || !contextItem.exportArtifacts?.length} onClick={() => { setStatus(""); setExportItemId(contextItem.id); closeMenu(); }}><FileDown aria-hidden="true" size={16} />{c.export}</button>
        </div>,
        document.body,
      )}
      {(exportItem?.exportArtifacts?.length ?? 0) > 0 && exportItem?.exportArtifacts && (
        <LibraryExportDialog
          c={c}
          item={exportItem}
          artifacts={exportItem.exportArtifacts}
          status={status}
          onExport={(artifact, suggestedName) => void exportArtifact(exportItem, artifact, suggestedName)}
          onClose={closeExport}
        />
      )}
    </main>
  );
}

type LibraryCopy = typeof copy;

function artifactPresentation(
  artifact: LibraryExportArtifact,
  c: LibraryCopy,
): { label: string; suggestedName: string } {
  if (artifact.kind === "article_pdf") return { label: c.articlePdf, suggestedName: "article-pdf" };
  if (artifact.kind === "report_pdf") return { label: c.reportPdf, suggestedName: "report-pdf" };
  if (artifact.kind === "report_markdown") return { label: c.reportMarkdown, suggestedName: "report-markdown" };
  if (artifact.kind === "report_manifest") return { label: c.reportManifest, suggestedName: "report-manifest" };
  if (artifact.kind === "report_text") return { label: c.reportText, suggestedName: "report-text" };
  if (artifact.kind === "report_latex") return { label: c.reportLatex, suggestedName: "report-latex" };
  if (artifact.mediaType === "application/vnd.citationstyles.csl+json") return { label: c.cslJson, suggestedName: "references-csl-json" };
  if (artifact.mediaType === "application/x-research-info-systems") return { label: c.ris, suggestedName: "references-ris" };
  if (artifact.mediaType === "application/xml") return { label: c.endnoteXml, suggestedName: "references-endnote-xml" };
  if (artifact.mediaType === "application/x-biblatex") return { label: c.biblatex, suggestedName: "references-biblatex" };
  return { label: c.bibtex, suggestedName: "references-bibtex" };
}

function LibraryExportDialog({ c, item, artifacts, status, onExport, onClose }: { c: LibraryCopy; item: LibraryItemFixture; artifacts: readonly LibraryExportArtifact[]; status: string; onExport: (artifact: LibraryExportArtifact, suggestedName: string) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".lh-artifact-export-list button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop lh-library-export-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="lh-library-export-dialog" role="dialog" aria-modal="true" aria-labelledby="library-export-title" aria-describedby="library-export-intro">
        <header className="dialog-header">
          <div><p className="eyebrow">{c.export}</p><h2 id="library-export-title">{c.exportTitle.replace("{{title}}", item.title)}</h2></div>
          <button className="icon-button" type="button" aria-label={c.exportClose} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="lh-library-export-body">
          <p id="library-export-intro">{c.exportIntro}</p>
          <div className="lh-artifact-export-list">
            {artifacts.map((artifact) => {
              const presentation = artifactPresentation(artifact, c);
              return (
                <button key={artifact.id} type="button" onClick={() => onExport(artifact, presentation.suggestedName)}>
                  <FileDown aria-hidden="true" size={18} />
                  <span><b>{presentation.label}</b><small>{c.exportIntegrity}: <code>{artifact.sha256.slice(0, 16)}…</code></small></span>
                </button>
              );
            })}
          </div>
          <p className="lh-export-visible-status" role="status" aria-live="polite">{status}</p>
        </div>
      </div>
    </div>
  );
}

function LibraryCard({ item, state, c, onMenu }: { item: LibraryItemFixture; state: LibraryReadingState; c: LibraryCopy; onMenu: (id: string, x: number, y: number, trigger?: HTMLElement) => void }) {
  const openPath = openPathFor(item);
  const openable = Boolean(item.browserReportId || !item.live || item.artifactId);
  const integrity = integrityLabel(item.integrity, c);
  const access = item.access === "open-full-text" ? c.openFull : item.access === "local-copy" ? c.localCopy : c.abstractOnly;
  return (
    <article
      className="lh-library-card"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(item.id, event.clientX, event.clientY);
      }}
    >
      <div className={`lh-integrity-rail ${item.integrity}`} aria-hidden="true" />
      <div className="lh-library-copy">
        <div className="lh-library-kickers"><span>{disciplineLabels[item.discipline]}</span><span>{item.kind.replace("-", " ")}</span><span>{state === "unread" ? c.unread : state === "reading" ? c.reading : c.read}</span></div>
        <h2>{openable ? <Link to={openPath}>{item.title}</Link> : item.title}</h2>
        <p className="lh-library-citation">{item.authors} · {item.venue} · {item.year}</p>
        <dl className="lh-library-meta">
          <div><dt><ShieldCheck aria-hidden="true" size={14} />{c.integrity}</dt><dd>{integrity}</dd></div>
          <div><dt><FileText aria-hidden="true" size={14} />{c.access}</dt><dd>{access}</dd></div>
        </dl>
        <details className="lh-library-record-details">
          <summary>{c.recordDetails}</summary>
          <dl className="lh-library-secondary-meta"><div><dt><BookMarked aria-hidden="true" size={14} />{c.collection}</dt><dd>{item.collection}</dd></div></dl>
          <div className="lh-tag-row" aria-label={c.tags}><Tags aria-hidden="true" size={14} />{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          <p className="lh-identifier"><code>{item.identifier}</code>{item.sha256 && <span>SHA-256 {item.sha256}</span>}</p>
        </details>
      </div>
      <div className="lh-library-actions">
        {openable ? <Link className="button button-secondary" to={openPath}>{c.open}</Link> : <button className="button button-secondary" type="button" disabled>{c.open}</button>}
        <button type="button" aria-label={c.menu.replace("{{title}}", item.title)} aria-haspopup="menu" onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onMenu(item.id, bounds.right - 224, bounds.bottom + 5, event.currentTarget);
        }}><Ellipsis aria-hidden="true" size={20} /></button>
      </div>
    </article>
  );
}

function openPathFor(item: LibraryItemFixture) {
  if (item.browserReportId) return `/reports/local/${encodeURIComponent(item.browserReportId)}`;
  if (item.live && item.artifactId) return `/library/${encodeURIComponent(item.id)}/read`;
  return item.access === "abstract-only" ? "/reports/demo" : "/library/demo/read";
}

function integrityLabel(state: IntegrityState, c: LibraryCopy) {
  if (state === "verified") return c.verified;
  if (state === "changed") return c.changed;
  return c.metadataOnly;
}

function FilterSelect({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (value: string) => void; options: readonly (readonly [string, string])[]; allLabel: string }) {
  return (
    <label className="lh-filter-select"><span>{label}</span><span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">{allLabel}</option>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><ChevronDown aria-hidden="true" size={15} /></span></label>
  );
}
