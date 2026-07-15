import {
  BookMarked,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  Download,
  ExternalLink,
  FileOutput,
  Laptop,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  AppearanceProvider,
  useAppearance,
} from "./appearance";
import { BrowserReportPage } from "./BrowserReportPage";
import { listBrowserReports } from "./browser/vault";
import { claims, localize } from "./fixtures";
import { I18nProvider, type Locale, useI18n } from "./i18n";
import { LibraryPage } from "./LibraryPage";
import { PrivacyPage } from "./PrivacyPage";
import { ReportWizardPage } from "./ReportWizard";
import type { GroundedReport } from "./research/report";
import { SettingsPage } from "./SettingsPage";
import {
  formatShortcut,
  ShortcutProvider,
  type ShortcutCommand,
  useShortcuts,
} from "./shortcuts";

const ReaderPage = lazy(() => import("./reader/ReaderPage"));

interface BrowserWatchSummary {
  id: string;
  name: string;
  specificationSha256: string;
  createdAt: string;
  lastReportId: string;
  specification: {
    timezone?: string;
    schedule?: { kind?: string; expression?: string };
  };
}

type BrowserTodayState =
  | { status: "idle" | "loading" }
  | { status: "error" }
  | { status: "ready"; reports: GroundedReport[]; watches: BrowserWatchSummary[] };

function readBrowserWatches(): BrowserWatchSummary[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem("litehouse.browser-watches.v1") ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is BrowserWatchSummary => {
        if (!value || typeof value !== "object") return false;
        const watch = value as Partial<BrowserWatchSummary>;
        return typeof watch.id === "string"
          && typeof watch.name === "string"
          && typeof watch.createdAt === "string"
          && typeof watch.lastReportId === "string"
          && typeof watch.specificationSha256 === "string"
          && /^[0-9a-f]{64}$/u.test(watch.specificationSha256)
          && Number.isFinite(Date.parse(watch.createdAt))
          && Boolean(watch.specification && typeof watch.specification === "object");
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

function supportsDemoReportCommands(pathname: string): boolean {
  const normalizedPath = pathname.replace(/\/+$/u, "") || "/";
  if (normalizedPath === "/reports/demo") return true;
  return claims.some(({ id }) => normalizedPath === `/reports/demo/claims/${id}`);
}

function useNarrowViewport(query = "(max-width: 820px)"): boolean {
  const [narrow, setNarrow] = useState(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(query); } catch { return; }
    const onChange = () => setNarrow(mq.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

// On phones the WebGPU local model is unavailable; surface an honest, dismissible
// notice while keeping the app readable. Reading/browsing and BYOK still work.
function MobileNotice() {
  const narrow = useNarrowViewport();
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem("litehouse.mobile-notice.v1") === "dismissed"; }
    catch { return false; }
  });
  if (dismissed || !narrow) return null;
  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem("litehouse.mobile-notice.v1", "dismissed"); } catch { /* private mode */ }
  };
  return (
    <aside className="lh-mobile-notice" role="note" aria-label="Device capability notice">
      <span className="lh-mobile-notice-mark" aria-hidden="true"><Laptop size={19} /></span>
      <div className="lh-mobile-notice-body">
        <p><b>Litehouse works best on a desktop or Mac.</b></p>
        <p>Its private AI model runs in your browser with WebGPU, which phones generally cannot provide. You can still read reports and browse here — for AI-generated synthesis, open Litehouse on a computer or connect an API key in Settings.</p>
        <Link to="/privacy" className="lh-mobile-notice-link">How Litehouse handles your data</Link>
      </div>
      <button type="button" className="lh-mobile-notice-close" aria-label="Dismiss notice" onClick={dismiss}>
        <X aria-hidden="true" size={16} />
      </button>
    </aside>
  );
}

function AppLayout() {
  const { t } = useI18n();
  const { theme, setTheme } = useAppearance();
  const navigate = useNavigate();
  const location = useLocation();
  const demoReportCommandsAvailable = supportsDemoReportCommands(location.pathname);

  useEffect(() => {
    document.title = "Litehouse · Your research desk";
  }, []);

  const commands = useMemo<ShortcutCommand[]>(
    () => [
      {
        id: "navigation.today",
        label: t("shortcuts.today"),
        description: t("shortcuts.todayHelp"),
        category: "navigation",
        defaultBinding: "Mod+1",
        keywords: ["digest", "home"],
        run: () => navigate("/today"),
      },
      {
        id: "navigation.report",
        label: t("shortcuts.report"),
        description: t("shortcuts.reportHelp"),
        category: "navigation",
        defaultBinding: "Mod+2",
        keywords: ["evidence", "claims"],
        run: () => navigate("/reports/demo"),
      },
      {
        id: "report.new",
        label: t("shortcuts.newReport"),
        description: t("shortcuts.newReportHelp"),
        category: "research",
        defaultBinding: "Mod+N",
        keywords: ["new", "watch", "guided", "literature"],
        run: () => navigate("/reports/new"),
      },
      {
        id: "navigation.library",
        label: t("shortcuts.library"),
        description: t("shortcuts.libraryHelp"),
        category: "library",
        defaultBinding: "Mod+4",
        keywords: ["vault", "saved", "articles", "reports", "notes"],
        run: () => navigate("/library"),
      },
      {
        id: "navigation.reader",
        label: t("shortcuts.reader"),
        description: t("shortcuts.readerHelp"),
        category: "navigation",
        defaultBinding: "Mod+3",
        keywords: ["PDF", "article", "notes", "library"],
        run: () => navigate("/library/demo/read"),
      },
      {
        id: "settings.appearance",
        label: t("shortcuts.appearance"),
        description: t("shortcuts.appearanceHelp"),
        category: "application",
        defaultBinding: "Mod+Comma",
        keywords: ["settings", "preferences", "theme", "motion"],
        run: () => navigate("/settings"),
      },
      {
        id: "appearance.toggleTheme",
        label: t("shortcuts.toggleTheme"),
        description: t("shortcuts.toggleThemeHelp"),
        category: "application",
        defaultBinding: "Mod+Shift+D",
        keywords: ["dark", "light"],
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "help.shortcuts",
        label: "Keyboard shortcuts",
        description: "View, remap, or restore application shortcuts",
        category: "application",
        keywords: ["keyboard", "keys", "accelerators"],
        run: () => navigate("/settings?section=shortcuts"),
      },
      {
        id: "help.diagnostics",
        label: "Diagnostics",
        description: "Open version, storage path, update, and system information",
        category: "application",
        keywords: ["system", "update", "paths", "support"],
        run: () => navigate("/settings?section=diagnostics"),
      },
      {
        id: "report.export",
        label: t("shortcuts.export"),
        description: t("shortcuts.exportHelp"),
        category: "research",
        defaultBinding: "Mod+Shift+E",
        keywords: ["Zotero", "EndNote", "Mendeley", "RIS", "BibLaTeX"],
        enabled: demoReportCommandsAvailable,
        disabledReason: t("shortcuts.reportOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:report-export")),
      },
      {
        id: "report.verify",
        label: t("shortcuts.verify"),
        description: t("shortcuts.verifyHelp"),
        category: "research",
        defaultBinding: "Mod+Shift+V",
        keywords: ["SHA", "evidence", "integrity"],
        enabled: demoReportCommandsAvailable,
        disabledReason: t("shortcuts.reportOnly"),
        run: () => navigate("/reports/demo/claims/C-001"),
      },
      {
        id: "reader.search",
        label: t("shortcuts.readerSearch"),
        description: t("shortcuts.readerSearchHelp"),
        category: "reader",
        defaultBinding: "Mod+F",
        keywords: ["PDF", "find", "text"],
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        allowInEditable: true,
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.search" } })),
      },
      {
        id: "library.search",
        label: t("shortcuts.librarySearch"),
        description: t("shortcuts.librarySearchHelp"),
        category: "library",
        defaultBinding: "Mod+Shift+F",
        keywords: ["library", "filter", "vault"],
        enabled: location.pathname === "/library",
        disabledReason: t("shortcuts.libraryOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:library-search")),
      },
      {
        id: "reader.previousPage",
        label: t("shortcuts.readerPrevious"),
        description: t("shortcuts.readerPreviousHelp"),
        category: "reader",
        defaultBinding: "Alt+ArrowUp",
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.previousPage" } })),
      },
      {
        id: "reader.nextPage",
        label: t("shortcuts.readerNext"),
        description: t("shortcuts.readerNextHelp"),
        category: "reader",
        defaultBinding: "Alt+ArrowDown",
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.nextPage" } })),
      },
      {
        id: "reader.addNote",
        label: t("shortcuts.readerNote"),
        description: t("shortcuts.readerNoteHelp"),
        category: "reader",
        defaultBinding: "Mod+Shift+N",
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.addNote" } })),
      },
      {
        id: "reader.save",
        label: t("shortcuts.readerSave"),
        description: t("shortcuts.readerSaveHelp"),
        category: "reader",
        defaultBinding: "Mod+S",
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.save" } })),
      },
      {
        id: "reader.exportNotes",
        label: t("shortcuts.readerExport"),
        description: t("shortcuts.readerExportHelp"),
        category: "reader",
        defaultBinding: "Mod+Alt+S",
        enabled: location.pathname.startsWith("/library/") && location.pathname.endsWith("/read"),
        disabledReason: t("shortcuts.readerOnly"),
        run: () => window.dispatchEvent(new CustomEvent("litehouse:reader-command", { detail: { id: "reader.exportNotes" } })),
      },
    ],
    [demoReportCommandsAvailable, location.pathname, navigate, setTheme, t, theme],
  );

  return (
    <ShortcutProvider commands={commands}>
      <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("app.skip")}
      </a>

      <header className="masthead">
        <Link className="brand" to="/today" aria-label="Litehouse">
          <img className="brand-ink" src={`${import.meta.env.BASE_URL}brand/png/wordmark/ink/litehouse-wordmark-512.png`} alt="Litehouse" />
          <img className="brand-ivory" src={`${import.meta.env.BASE_URL}brand/png/wordmark/ivory/litehouse-wordmark-512.png`} alt="" aria-hidden="true" />
        </Link>
        <div className="masthead-tools">
          <CommandPaletteButton />
          <span className="local-mark">
            <span aria-hidden="true" className="status-dot" />
            Browser-local
          </span>
        </div>
      </header>

      <div className="shell-body">
        <nav className="primary-nav" aria-label={t("nav.primary")}>
          <p className="nav-kicker">{t("nav.research")}</p>
          <NavItem to="/today" label={t("nav.today")} icon={<CalendarDays />} />
          <NavItem to="/library" label={t("nav.library")} icon={<BookMarked />} />
          <NavItem to="/reports/new" label={t("nav.newReport")} icon={<Plus />} />
          <NavItem to="/reports/demo" label={t("nav.report")} icon={<BookOpen />} />
          <NavItem
            to="/settings"
            label={t("nav.appearance")}
            icon={<Settings2 />}
          />
          <NavItem to="/privacy" label={t("nav.privacy")} icon={<ShieldCheck />} />
          <p className="nav-foot">Litehouse 0.1 · {t("app.browserLocal")}</p>
        </nav>

        <div className="route-stage">
          <MobileNotice />
          <Routes>
            <Route path="/" element={<Navigate replace to="/today" />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/reports/new" element={<ReportWizardPage />} />
            <Route path="/reports/local/:reportId" element={<BrowserReportPage />} />
            <Route path="/reports/demo" element={<ReportPage />} />
            <Route path="/reports/demo/claims/:claimId" element={<ReportPage />} />
            <Route path="/library/:itemId/read" element={<Suspense fallback={<ReaderLoading />}><ReaderPage /></Suspense>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="*" element={<Navigate replace to="/today" />} />
          </Routes>
        </div>
      </div>
      </div>
    </ShortcutProvider>
  );
}

function ReaderLoading() {
  return (
    <main id="main-content" className="page reader-route-loading" tabIndex={-1}>
      <p role="status">Opening the local PDF reader…</p>
    </main>
  );
}

function CommandPaletteButton() {
  const { getBinding, openPalette, platform } = useShortcuts();
  const { t } = useI18n();
  const binding = getBinding("app.commandPalette") ?? "Mod+K";
  return (
    <button className="command-trigger" type="button" aria-label={t("shortcuts.commands")} onClick={openPalette}>
      <Search aria-hidden="true" size={15} strokeWidth={1.7} />
      <span>{t("shortcuts.commands")}</span>
      <kbd>{formatShortcut(binding, platform)}</kbd>
    </button>
  );
}

function NavItem({ to, label, icon }: { to: string; label: string; icon: React.ReactElement }) {
  return (
    <NavLink className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`} to={to}>
      <span className="nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </NavLink>
  );
}

function TodayPage() {
  const [browserState, setBrowserState] = useState<BrowserTodayState>({ status: "idle" });

  useEffect(() => {
    let active = true;
    setBrowserState({ status: "loading" });
    void listBrowserReports()
      .then((reports) => {
        if (active) setBrowserState({ status: "ready", reports, watches: readBrowserWatches() });
      })
      .catch(() => {
        if (active) setBrowserState({ status: "error" });
      });
    return () => { active = false; };
  }, []);

  return <BrowserTodayPage state={browserState} />;
}

function BrowserTodayPage({ state }: { state: BrowserTodayState }) {
  const { t } = useI18n();
  const c = {
    lede: "Verifiable reports and recurring watches stored in this browser profile.",
    status: "Browser vault status",
    watches: "Active watches",
    reports: "Stored reports",
    latest: "Latest report",
    recent: "Recent reports",
    recentHelp: "Reports stored in IndexedDB are rechecked against SHA-256 when opened.",
    savedWatches: "Recurring watches",
    watchHelp: "Watch definitions stay in this browser; future updates are started manually while Litehouse is open.",
    noReports: "No reports are stored in this browser yet.",
    noReportsHelp: "Create a new report to run your first real literature retrieval.",
    noWatches: "No recurring watches are stored in this browser.",
    open: "Open report",
    records: "accepted records",
    integrity: "Integrity receipt",
    created: "Created",
    schedule: "Schedule",
    lastReport: "Last report",
    loading: "Loading browser reports and watches…",
    unavailable: "Browser vault is unavailable",
    unavailableHelp: "Litehouse did not substitute demonstration records. Check IndexedDB access in this browser.",
  };
  const formatDate = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };
  const eyebrowDate = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <main id="main-content" className="page today-page native-today-page browser-today-page" tabIndex={-1}>
      <section className="page-heading heading-with-aside" aria-labelledby="today-title">
        <div>
          <p className="eyebrow">{eyebrowDate}</p>
          <h1 id="today-title">{t("today.title")}</h1>
          <p className="lede">{c.lede}</p>
        </div>
        <Link className="button button-primary" to="/reports/new"><Plus aria-hidden="true" size={18} />{t("nav.newReport")}</Link>
      </section>

      {state.status === "ready" ? (
        <BrowserTodayDigest state={state} c={c} formatDate={formatDate} />
      ) : state.status === "error" ? (
        <section className="native-today-state is-error" role="alert"><h2>{c.unavailable}</h2><p>{c.unavailableHelp}</p></section>
      ) : (
        <p className="native-today-state" role="status">{c.loading}</p>
      )}
    </main>
  );
}

function BrowserTodayDigest({ state, c, formatDate }: {
  state: Extract<BrowserTodayState, { status: "ready" }>;
  c: {
    status: string; watches: string; reports: string; latest: string; recent: string; recentHelp: string;
    savedWatches: string; watchHelp: string; noReports: string; noReportsHelp: string; noWatches: string;
    open: string; records: string; integrity: string; created: string; schedule: string; lastReport: string;
  };
  formatDate: (value: string) => string;
}) {
  const latest = state.reports[0];
  const reportIds = new Set(state.reports.map((report) => report.id));
  return (
    <>
      <dl className="native-today-summary" aria-label={c.status}>
        <div><dt>{c.watches}</dt><dd>{state.watches.length}</dd></div>
        <div><dt>{c.reports}</dt><dd>{state.reports.length}</dd></div>
        <div><dt>{c.latest}</dt><dd>{latest ? formatDate(latest.createdAt) : "—"}</dd></div>
      </dl>

      <section className="native-today-section" aria-labelledby="browser-reports-heading">
        <div className="section-heading-row"><div><p className="section-index">01</p><h2 id="browser-reports-heading">{c.recent}</h2><p>{c.recentHelp}</p></div></div>
        {state.reports.length ? (
          <div className="native-vault-list browser-report-list">
            {state.reports.slice(0, 8).map((report) => (
              <article key={report.id}>
                <span>{formatDate(report.createdAt)} · {report.records.length} {c.records}</span>
                <h3><Link to={`/reports/local/${encodeURIComponent(report.id)}`}>{report.title}</Link></h3>
                <div className="browser-report-card-actions"><Link className="evidence-link" to={`/reports/local/${encodeURIComponent(report.id)}`}><ShieldCheck aria-hidden="true" size={16} />{c.open}</Link><details><summary>{c.integrity}</summary><code>{report.reportSha256}</code></details></div>
              </article>
            ))}
          </div>
        ) : <div className="native-today-empty"><h3>{c.noReports}</h3><p>{c.noReportsHelp}</p></div>}
      </section>

      <section className="native-today-section" aria-labelledby="browser-watches-heading">
        <div className="section-heading-row"><div><p className="section-index">02</p><h2 id="browser-watches-heading">{c.savedWatches}</h2><p>{c.watchHelp}</p></div></div>
        {state.watches.length ? (
          <div className="native-run-list browser-watch-list">
            {state.watches.map((watch) => (
              <article className="native-run-card" key={watch.id}>
                <div><p>{c.created} · {formatDate(watch.createdAt)}</p><h3>{watch.name}</h3><span>{c.schedule}: {watch.specification.schedule?.expression ?? "—"} · {watch.specification.timezone ?? "—"}</span></div>
                <details><summary>{c.integrity}</summary><dl><div><dt>SHA-256</dt><dd><code>{watch.specificationSha256}</code></dd></div>{reportIds.has(watch.lastReportId) && <div><dt>{c.lastReport}</dt><dd><Link to={`/reports/local/${encodeURIComponent(watch.lastReportId)}`}>{c.open}</Link></dd></div>}</dl></details>
              </article>
            ))}
          </div>
        ) : <p className="native-today-empty">{c.noWatches}</p>}
      </section>
    </>
  );
}

function ReportPage() {
  const { claimId } = useParams();
  const { locale, t } = useI18n();
  const [citationStyle, setCitationStyle] = useState("APA 7");
  const [exportOpen, setExportOpen] = useState(false);
  const activeClaim = claimId ? claims.find((claim) => claim.id === claimId) : undefined;

  useEffect(() => {
    const openExport = () => setExportOpen(true);
    window.addEventListener("litehouse:report-export", openExport);
    return () => window.removeEventListener("litehouse:report-export", openExport);
  }, []);

  return (
    <>
      <main id="main-content" className="page report-page" tabIndex={-1}>
        <Link className="back-link" to="/today">
          <ChevronLeft aria-hidden="true" size={17} /> {t("report.back")}
        </Link>

        <header className="report-header">
          <div className="report-heading-copy">
            <p className="eyebrow">{t("report.eyebrow")}</p>
            <h1>{t("report.title")}</h1>
            <p className="lede">{t("report.lede")}</p>
            <p className="demo-caption">{t("report.demo")}</p>
          </div>
          <div className="report-actions">
            <button className="button button-secondary" type="button" onClick={() => setExportOpen(true)}>
              <FileOutput aria-hidden="true" size={18} />
              {t("report.export")}
            </button>
            <details className="report-options">
              <summary>{t("report.style")}</summary>
              <label>
                <span className="sr-only">{t("report.style")}</span>
                <select value={citationStyle} onChange={(event) => setCitationStyle(event.target.value)}>
                  <option>APA 7</option>
                  <option>IEEE</option>
                  <option>Vancouver</option>
                  <option>Chicago</option>
                </select>
              </label>
            </details>
          </div>
        </header>

        <details className="verification-receipt">
          <summary>
            <span className="verification-seal" aria-hidden="true"><ShieldCheck size={22} /></span>
            <span><small className="receipt-status">{t("report.verified")}</small><b id="verification-heading">{t("report.receipt")}</b></span>
          </summary>
          <ul>
            <li>{t("report.claims")}</li>
            <li>{t("report.sources")}</li>
            <li>{t("report.limited")}</li>
          </ul>
        </details>

        <div className={`report-layout${claimId ? " has-inspector" : ""}`}>
          <details className="report-outline">
            <summary id="outline-heading" className="outline-title">{t("report.outline")}</summary>
            <ol>
              <li><a href="#summary">{t("report.summary")}</a></li>
              <li><a href="#findings">{t("report.findings")}</a></li>
              <li><a href="#limits">{t("report.limits")}</a></li>
              <li><a href="#references">{t("report.references")}</a></li>
            </ol>
          </details>

          <article className="report-document">
            <section id="summary">
              <p className="section-index">01</p>
              <h2>{t("report.summary")}</h2>
              <p>{t("report.summaryText")}</p>
              <ClaimLink id="C-001" active={activeClaim?.id === "C-001"} />
            </section>
            <section id="findings">
              <p className="section-index">02</p>
              <h2>{t("report.findings")}</h2>
              <p>{t("report.findingsText")}</p>
              <ClaimLink id="C-002" active={activeClaim?.id === "C-002"} />
            </section>
            <section id="limits">
              <p className="section-index">03</p>
              <h2>{t("report.limits")}</h2>
              <p>{t("report.limitsText")}</p>
              <ClaimLink id="C-003" active={activeClaim?.id === "C-003"} />
              <details className="recommendation-note">
                <summary>{t("report.recommendation")}</summary>
                <p>{t("report.recommendationText")}</p>
              </details>
            </section>
            <section id="references" className="references-section">
              <details className="report-section-disclosure">
                <summary><span className="section-index">04</span><span>{t("report.references")}</span></summary>
                <ol>
                  <li>
                    Abramson, J., et al. (2024). Accurate structure prediction of biomolecular
                    interactions with AlphaFold 3. <i>Nature</i>. {citationStyle}.
                  </li>
                  <li>
                    Jumper, J., et al. (2021). Highly accurate protein structure prediction with
                    AlphaFold. <i>Nature</i>. {citationStyle}.
                  </li>
                </ol>
              </details>
            </section>
          </article>

          {claimId && activeClaim ? (
            <EvidenceInspector claim={activeClaim} routed={Boolean(claimId)} locale={locale} />
          ) : claimId ? (
            <aside className="evidence-inspector inspector-error" aria-labelledby="claim-not-found">
              <h2 id="claim-not-found">{t("claim.inspector")}</h2>
              <p>{t("claim.notFound")}</p>
              <Link className="back-link" to="/reports/demo">{t("claim.back")}</Link>
            </aside>
          ) : null}
        </div>
      </main>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

function ClaimLink({ id, active }: { id: string; active: boolean }) {
  const { locale, t } = useI18n();
  const claim = claims.find((item) => item.id === id);
  if (!claim) return null;

  return (
    <Link
      className={`claim-link${active ? " is-active" : ""}`}
      to={`/reports/demo/claims/${id}`}
      aria-label={t("claim.open", { id })}
    >
      <span className="claim-id">{id}</span>
      <span className="claim-statement">{localize(claim.statement, locale)}</span>
      <span className={`claim-state ${claim.status}`}>
        {claim.status === "verified" ? "■" : "◧"}{" "}
        {claim.status === "verified" ? t("claim.verified") : t("claim.limited")}
      </span>
    </Link>
  );
}

function EvidenceInspector({
  claim,
  routed,
  locale,
}: {
  claim: (typeof claims)[number];
  routed: boolean;
  locale: Locale;
}) {
  const { t } = useI18n();

  return (
    <aside className="evidence-inspector" aria-labelledby="inspector-heading">
      <div className="inspector-topline">
        <p>{claim.id}</p>
        <span className={`claim-state ${claim.status}`}>
          {claim.status === "verified" ? "■" : "◧"}{" "}
          {claim.status === "verified" ? t("claim.verified") : t("claim.limited")}
        </span>
      </div>
      <h2 id="inspector-heading">{t("claim.inspector")}</h2>
      {routed && (
        <Link className="inspector-back" to="/reports/demo">
          <X aria-hidden="true" size={16} /> {t("claim.back")}
        </Link>
      )}

      <blockquote>{localize(claim.statement, locale)}</blockquote>

      <dl className="evidence-details">
        <div>
          <dt>{t("claim.scope")}</dt>
          <dd>{localize(claim.scope, locale)}</dd>
        </div>
        <div>
          <dt>{t("claim.locator")}</dt>
          <dd>{localize(claim.locator, locale)}</dd>
        </div>
      </dl>

      <section className="source-span" aria-labelledby="source-span-heading">
        <h3 id="source-span-heading">{t("claim.span")}</h3>
        <p>“{claim.span}”</p>
      </section>

      <section aria-labelledby="metadata-heading">
        <details className="inspector-metadata">
          <summary id="metadata-heading">{t("claim.metadata")}</summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">{t("claim.field")}</th><th scope="col">{t("claim.canonical")}</th><th scope="col">{t("claim.crosscheck")}</th></tr></thead>
              <tbody>
                <tr><th scope="row">DOI</th><td>{claim.doi}</td><td>Matched</td></tr>
                <tr><th scope="row">Source</th><td>{claim.citation}</td><td>{claim.crosscheck}</td></tr>
              </tbody>
            </table>
          </div>
          <p><b>{t("claim.sourceHash")}:</b> <code>{claim.hash}</code></p>
        </details>
      </section>

      <div className="source-record">
        <p className="source-title">{claim.sourceTitle}</p>
        <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
          {t("claim.openSource")} <ExternalLink aria-hidden="true" size={15} />
        </a>
      </div>
    </aside>
  );
}

type ExportPreset = "zotero" | "endnote" | "mendeley" | "portable";
type ExportScope = "selected" | "all";
type ExportDelivery = "push" | "download";
type DuplicateRule = "skip" | "merge" | "copy";

function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState<ExportScope>("selected");
  const [preset, setPreset] = useState<ExportPreset>("zotero");
  const [delivery, setDelivery] = useState<ExportDelivery>("download");
  const [duplicates, setDuplicates] = useState<DuplicateRule>("merge");
  const [attachments, setAttachments] = useState(false);
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);

  const format =
    preset === "endnote" || preset === "mendeley"
      ? "RIS"
      : preset === "portable"
        ? "BibLaTeX"
        : "CSL JSON";

  useEffect(() => {
    if (!open) return;

    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setStatus("");
    setReady(false);
    const focusTimer = window.setTimeout(() => closeButton.current?.focus(), 0);

    return () => {
      window.clearTimeout(focusTimer);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, [tabindex]",
      ) ?? [],
    ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function changePreset(event: ChangeEvent<HTMLInputElement>) {
    const nextPreset = event.target.value as ExportPreset;
    setPreset(nextPreset);
    setReady(false);
    setStatus("");
    if (nextPreset === "portable") setDelivery("download");
  }

  function prepareExport() {
    setReady(false);
    if (delivery === "push") {
      setStatus(t("export.unavailable"));
      return;
    }
    setStatus(t("export.ready"));
    setReady(true);
  }

  const exportBody = `TY  - JOUR\nTI  - Accurate structure prediction of biomolecular interactions with AlphaFold 3\nAU  - Abramson, Josh\nDO  - 10.1038/s41586-024-07487-w\nER  -`;
  const downloadName = `litehouse-demo.${format === "RIS" ? "ris" : format === "BibLaTeX" ? "bib" : "json"}`;

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onKeyDown={onKeyDown}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Litehouse → library</p>
            <h2 id="export-title">{t("export.title")}</h2>
          </div>
          <button ref={closeButton} className="icon-button" type="button" onClick={onClose}>
            <X aria-hidden="true" size={20} />
            <span className="sr-only">{t("export.close")}</span>
          </button>
        </div>

        <div className="export-grid">
          <div className="export-controls">
            <fieldset>
              <legend>{t("export.scope")}</legend>
              <RadioOption checked={scope === "selected"} name="scope" value="selected" onChange={() => setScope("selected")} label={t("export.selected")} />
              <RadioOption checked={scope === "all"} name="scope" value="all" onChange={() => setScope("all")} label={t("export.all")} />
            </fieldset>

            <fieldset>
              <legend>{t("export.destination")}</legend>
              <div className="preset-grid">
                {(["zotero", "endnote", "mendeley", "portable"] as ExportPreset[]).map((value) => (
                  <label className="preset-option" key={value}>
                    <input type="radio" name="preset" value={value} checked={preset === value} onChange={changePreset} />
                    <span>{t(`export.${value}` as "export.zotero")}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>{t("export.delivery")}</legend>
              <RadioOption
                checked={delivery === "push"}
                name="delivery"
                value="push"
                onChange={() => setDelivery("push")}
                label={t("export.push")}
                help={t("export.pushHelp")}
                disabled={preset === "portable"}
              />
              <RadioOption
                checked={delivery === "download"}
                name="delivery"
                value="download"
                onChange={() => setDelivery("download")}
                label={t("export.download")}
                help={t("export.downloadHelp")}
              />
            </fieldset>

            <fieldset>
              <legend>{t("export.duplicates")}</legend>
              {(["skip", "merge", "copy"] as DuplicateRule[]).map((value) => (
                <RadioOption
                  key={value}
                  checked={duplicates === value}
                  name="duplicates"
                  value={value}
                  onChange={() => setDuplicates(value)}
                  label={t(`export.${value}` as "export.skip")}
                />
              ))}
            </fieldset>

            <label className="checkbox-option">
              <input type="checkbox" checked={attachments} onChange={(event) => setAttachments(event.target.checked)} />
              <span>{t("export.attachments")}</span>
            </label>
            {attachments && <p className="license-warning">◧ {t("export.licenseWarning")}</p>}
          </div>

          <section className="field-preview" aria-labelledby="field-preview-heading">
            <div className="preview-heading">
              <h3 id="field-preview-heading">{t("export.preview")}</h3>
              <span>{format}</span>
            </div>
            <div className="table-wrap" tabIndex={0} aria-label={t("export.preview")}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("export.titleField")}</th>
                    <th scope="col">{t("export.creators")}</th>
                    <th scope="col">{t("export.identifier")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Accurate structure prediction of biomolecular interactions with AlphaFold 3</td>
                    <td>Abramson et al.</td>
                    <td>10.1038/s41586-024-07487-w</td>
                  </tr>
                  {scope === "all" && (
                    <tr>
                      <td>Highly accurate protein structure prediction with AlphaFold</td>
                      <td>Jumper et al.</td>
                      <td>10.1038/s41586-021-03819-2</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <dl className="export-summary">
              <div><dt>{t("export.format")}</dt><dd>{format}</dd></div>
              <div><dt>{t("export.duplicates")}</dt><dd>{t(`export.${duplicates}` as "export.skip")}</dd></div>
            </dl>
          </section>
        </div>

        <div className="dialog-footer">
          <p className="export-status" role="status" aria-live="polite">{status}</p>
          <div>
            {ready && (
              <a
                className="button button-secondary"
                download={downloadName}
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(exportBody)}`}
              >
                <Download aria-hidden="true" size={17} />
                {t("export.downloadNow", { format })}
              </a>
            )}
            <button className="button button-primary" type="button" onClick={prepareExport}>
              {delivery === "push" ? t("export.check") : t("export.prepare")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RadioOption({
  checked,
  name,
  value,
  onChange,
  label,
  help,
  disabled = false,
}: {
  checked: boolean;
  name: string;
  value: string;
  onChange: () => void;
  label: string;
  help?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`radio-option${disabled ? " is-disabled" : ""}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} disabled={disabled} />
      <span>
        <b>{label}</b>
        {help && <small>{help}</small>}
      </span>
    </label>
  );
}

export function App() {
  return (
    <AppearanceProvider>
      <I18nProvider>
        <AppLayout />
      </I18nProvider>
    </AppearanceProvider>
  );
}
