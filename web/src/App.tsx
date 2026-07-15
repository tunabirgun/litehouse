import {
  BookMarked,
  CalendarDays,
  Laptop,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
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
} from "react-router-dom";

import {
  AppearanceProvider,
  useAppearance,
} from "./appearance";
import { BrowserReportPage } from "./BrowserReportPage";
import { listBrowserReports } from "./browser/vault";
import { I18nProvider, useI18n } from "./i18n";
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
    [location.pathname, navigate, setTheme, t, theme],
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
    lede: "Litehouse builds verifiable, cited literature reports from real scholarly sources — entirely in your browser. Start a new report to begin.",
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
    open: string; integrity: string; created: string; schedule: string; lastReport: string;
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
                <span>{formatDate(report.createdAt)} · {report.records.length} accepted {report.records.length === 1 ? "record" : "records"}</span>
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

export function App() {
  return (
    <AppearanceProvider>
      <I18nProvider>
        <AppLayout />
      </I18nProvider>
    </AppearanceProvider>
  );
}
