import {
  BookMarked,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  Download,
  ExternalLink,
  FileOutput,
  Languages,
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
  type MotionPreference,
  type ThemePreference,
  useAppearance,
} from "./appearance";
import { claims, digestStudies, localize, type DigestStudy } from "./fixtures";
import { I18nProvider, type Locale, useI18n } from "./i18n";
import { LibraryPage } from "./LibraryPage";
import { nativeApi } from "./native";
import { ReportWizardPage } from "./ReportWizard";
import { SettingsPage } from "./SettingsPage";
import {
  formatShortcut,
  ShortcutProvider,
  type ShortcutCommand,
  useShortcuts,
} from "./shortcuts";

const ReaderPage = lazy(() => import("./reader/ReaderPage"));

type DisciplineFilter = "all" | DigestStudy["discipline"];

interface NativeWatchSummary {
  id: string;
  name: string;
  enabled: boolean;
  active_revision: {
    id: string;
    number: number;
  };
}

interface NativeRunSummary {
  id: string;
  watch_revision_id: string;
  status: string;
  scheduled_at: string;
  finished_at: string | null;
  report_id: string | null;
  result_sha256: string | null;
  artifact_count: number;
  source_error_count: number;
}

interface NativeLibrarySummary {
  id: string;
  title: string;
  kind: string;
  identity_sha256: string;
  added_at: string;
}

type NativeTodayState =
  | { status: "idle" | "loading" }
  | { status: "error" }
  | {
      status: "ready";
      watches: NativeWatchSummary[];
      runs: NativeRunSummary[];
      items: NativeLibrarySummary[];
    };

const disciplineOrder: DisciplineFilter[] = [
  "all",
  "biomedicine",
  "climate",
  "computing",
  "social",
  "astronomy",
];

function showResearchContextMenu(event: ReactMouseEvent<HTMLElement>) {
  if (!nativeApi.available) return;
  event.preventDefault();
  void nativeApi.showContextMenu("research-item").catch(() => undefined);
}

function AppLayout() {
  const { locale, setLocale, t } = useI18n();
  const { theme, setTheme } = useAppearance();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    document.title = locale === "tr" ? "Litehouse · Araştırma masanız" : "Litehouse · Your research desk";
  }, [locale]);

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
        label: locale === "tr" ? "Klavye kısayolları" : "Keyboard shortcuts",
        description:
          locale === "tr"
            ? "Kısayolları görüntüle, yeniden ata veya varsayılanlara döndür"
            : "View, remap, or restore application shortcuts",
        category: "application",
        keywords: ["keyboard", "keys", "accelerators"],
        run: () => navigate("/settings?section=shortcuts"),
      },
      {
        id: "help.diagnostics",
        label: locale === "tr" ? "Tanılama" : "Diagnostics",
        description:
          locale === "tr"
            ? "Sürüm, veri yolları, güncelleme ve sistem bilgilerini aç"
            : "Open version, storage path, update, and system information",
        category: "application",
        keywords: ["system", "update", "paths", "support"],
        run: () => navigate("/settings?section=updates"),
      },
      {
        id: "report.export",
        label: t("shortcuts.export"),
        description: t("shortcuts.exportHelp"),
        category: "research",
        defaultBinding: "Mod+Shift+E",
        keywords: ["Zotero", "EndNote", "Mendeley", "RIS", "BibLaTeX"],
        enabled: location.pathname.startsWith("/reports/"),
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
        enabled: location.pathname.startsWith("/reports/"),
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
    [location.pathname, navigate, setTheme, t, theme],
  );

  return (
    <ShortcutProvider commands={commands}>
      <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("app.skip")}
      </a>

      <header className="masthead">
        <Link className="brand" to="/today" aria-label="Litehouse">
          <img src="/brand/litehouse-wordmark.svg" alt="Litehouse" />
        </Link>
        <div className="masthead-tools">
          <CommandPaletteButton />
          <span className="local-mark">
            <span aria-hidden="true" className="status-dot" />
            {nativeApi.available ? t("app.local") : t("app.demo")}
          </span>
          <div className="language-switch" aria-label={t("app.language")}>
            <Languages aria-hidden="true" size={16} strokeWidth={1.7} />
            <button
              type="button"
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
              lang="en"
            >
              EN
            </button>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              aria-pressed={locale === "tr"}
              onClick={() => setLocale("tr")}
              lang="tr"
            >
              TR
            </button>
          </div>
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
          <p className="nav-foot">Litehouse 0.1 · localhost</p>
        </nav>

        <div className="route-stage">
          <Routes>
            <Route path="/" element={<Navigate replace to="/today" />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/reports/new" element={<ReportWizardPage />} />
            <Route path="/reports/demo" element={<ReportPage />} />
            <Route path="/reports/demo/claims/:claimId" element={<ReportPage />} />
            <Route path="/library/:itemId/read" element={<Suspense fallback={<ReaderLoading />}><ReaderPage /></Suspense>} />
            <Route path="/settings/appearance" element={<AppearancePage />} />
            <Route path="/settings" element={<SettingsPage />} />
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
  const { openPalette, platform } = useShortcuts();
  const { t } = useI18n();
  return (
    <button className="command-trigger" type="button" aria-label={t("shortcuts.commands")} onClick={openPalette}>
      <Search aria-hidden="true" size={15} strokeWidth={1.7} />
      <span>{t("shortcuts.commands")}</span>
      <kbd>{formatShortcut("Mod+K", platform)}</kbd>
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
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<DisciplineFilter>("all");
  const [nativeState, setNativeState] = useState<NativeTodayState>({ status: "idle" });
  const filteredStudies = useMemo(
    () => digestStudies.filter((study) => filter === "all" || study.discipline === filter),
    [filter],
  );

  useEffect(() => {
    if (!nativeApi.available) return;
    let active = true;
    setNativeState({ status: "loading" });
    void Promise.all([
      nativeApi.request<NativeWatchSummary[]>("GET", "/v1/watches"),
      nativeApi.request<NativeRunSummary[]>("GET", "/v1/runs?limit=12"),
      nativeApi.request<NativeLibrarySummary[]>("GET", "/v1/library/items?limit=8"),
    ])
      .then(([watchResponse, runResponse, libraryResponse]) => {
        if (!active) return;
        if (
          watchResponse.status < 200 || watchResponse.status >= 300
          || runResponse.status < 200 || runResponse.status >= 300
          || libraryResponse.status < 200 || libraryResponse.status >= 300
        ) {
          setNativeState({ status: "error" });
          return;
        }
        setNativeState({
          status: "ready",
          watches: watchResponse.body,
          runs: [...runResponse.body].sort((left, right) =>
            right.scheduled_at.localeCompare(left.scheduled_at)),
          items: [...libraryResponse.body].sort((left, right) =>
            right.added_at.localeCompare(left.added_at)),
        });
      })
      .catch(() => {
        if (active) setNativeState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  function filterLabel(value: DisciplineFilter) {
    if (value === "all") return t("today.all");
    const study = digestStudies.find((item) => item.discipline === value);
    return study ? localize(study.disciplineLabel, locale) : value;
  }

  if (nativeApi.available) {
    return <NativeTodayPage state={nativeState} locale={locale} />;
  }

  return (
    <main id="main-content" className="page today-page" tabIndex={-1}>
      <section className="page-heading heading-with-aside" aria-labelledby="today-title">
        <div>
          <p className="eyebrow">{t("today.eyebrow")}</p>
          <h1 id="today-title">{t("today.title")}</h1>
          <p className="lede">{t("today.lede")}</p>
        </div>
        <Link className="button button-primary" to="/reports/demo">
          <BookOpen aria-hidden="true" size={18} />
          {t("today.openReport")}
        </Link>
      </section>

      <details className="demo-notice">
        <summary>
          <span className="notice-mark" aria-hidden="true">D</span>
          <span>
            <b id="demo-title">{t("today.demoTitle")}</b>
            <small>{t("today.demoText")}</small>
          </span>
        </summary>
        <dl className="run-summary" aria-label="Digest run summary">
          <div><dt>{t("today.lastRun")}</dt><dd>{t("today.lastRunValue")}</dd></div>
          <div><dt>{t("today.nextRun")}</dt><dd>{t("today.nextRunValue")}</dd></div>
          <div>
            <dt>{t("today.verified")}</dt>
            <dd className="verified-value"><Check aria-hidden="true" size={16} /> {t("today.verifiedValue")}</dd>
          </div>
        </dl>
      </details>

      <details className="status-change">
        <summary>
          <span className="status-symbol" aria-hidden="true">≠</span>
          <span><small className="section-index">01</small><b id="status-change-heading">{t("today.changed")}</b></span>
        </summary>
        <p>{t("today.changedText")}</p>
      </details>

      <section aria-labelledby="matches-heading" className="digest-section">
        <div className="section-heading-row">
          <div>
            <p className="section-index">02</p>
            <h2 id="matches-heading">{t("today.matches")}</h2>
            <p>{t("today.matchesHelp")}</p>
          </div>
        </div>

        <div className="filter-bar" role="group" aria-label={t("today.filter")}>
          {disciplineOrder.map((value) => (
            <button
              className="filter-button"
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {filterLabel(value)}
            </button>
          ))}
        </div>

        <div className="study-list" aria-live="polite">
          {filteredStudies.length ? (
            filteredStudies.map((study, index) => (
              <StudyCard study={study} index={index + 1} key={study.id} />
            ))
          ) : (
            <p className="empty-state">{t("today.noResults")}</p>
          )}
        </div>
      </section>
    </main>
  );
}

function NativeTodayPage({ state, locale }: { state: NativeTodayState; locale: Locale }) {
  const { t } = useI18n();
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

  return (
    <main id="main-content" className="page today-page native-today-page" tabIndex={-1}>
      <section className="page-heading heading-with-aside" aria-labelledby="today-title">
        <div>
          <p className="eyebrow">{t("today.eyebrow")}</p>
          <h1 id="today-title">{t("today.title")}</h1>
          <p className="lede">{t("today.liveLede")}</p>
        </div>
        <Link className="button button-primary" to="/reports/new">
          <Plus aria-hidden="true" size={18} /> {t("nav.newReport")}
        </Link>
      </section>

      {state.status === "ready" ? (
        <NativeTodayDigest state={state} formatDate={formatDate} />
      ) : state.status === "error" ? (
        <section className="native-today-state is-error" role="alert">
          <h2>{t("today.unavailable")}</h2>
          <p>{t("today.unavailableHelp")}</p>
        </section>
      ) : (
        <p className="native-today-state" role="status">{t("today.loading")}</p>
      )}
    </main>
  );
}

function NativeTodayDigest({
  state,
  formatDate,
}: {
  state: Extract<NativeTodayState, { status: "ready" }>;
  formatDate: (value: string) => string;
}) {
  const { t } = useI18n();
  const watchByRevision = new Map(
    state.watches.map((watch) => [watch.active_revision.id, watch.name]),
  );
  const recentItems = state.items.filter((item) => item.kind === "report" || item.kind === "work");
  const latestRun = state.runs[0];
  const statusLabel = (status: string) => ({
    queued: t("today.statusQueued"),
    running: t("today.statusRunning"),
    partial: t("today.statusPartial"),
    succeeded: t("today.statusSucceeded"),
    failed: t("today.statusFailed"),
    cancelled: t("today.statusCancelled"),
  })[status] ?? status;
  const itemKindLabel = (kind: string) => kind === "report"
    ? t("today.itemReport")
    : t("today.itemWork");

  return (
    <>
      <dl className="native-today-summary" aria-label={t("today.liveStatus")}>
        <div><dt>{t("today.enabledWatches")}</dt><dd>{state.watches.filter((watch) => watch.enabled).length}</dd></div>
        <div><dt>{t("today.latestRun")}</dt><dd>{latestRun ? statusLabel(latestRun.status) : t("today.noRunsShort")}</dd></div>
        <div><dt>{t("today.recentVault")}</dt><dd>{recentItems.length}</dd></div>
      </dl>

      <section className="native-today-section" aria-labelledby="recent-runs-heading">
        <div className="section-heading-row">
          <div><p className="section-index">01</p><h2 id="recent-runs-heading">{t("today.recentRuns")}</h2></div>
        </div>
        {state.runs.length ? (
          <div className="native-run-list">
            {state.runs.slice(0, 6).map((run) => (
              <article className="native-run-card" key={run.id}>
                <div>
                  <p>{watchByRevision.get(run.watch_revision_id) ?? t("today.previousRevision")}</p>
                  <h3>{run.report_id ? t("today.reportReady") : t("today.runStatus")}</h3>
                  <span>{formatDate(run.finished_at ?? run.scheduled_at)} · {statusLabel(run.status)}</span>
                </div>
                <details>
                  <summary>{t("today.runDetails")}</summary>
                  <dl>
                    <div><dt>{t("today.artifacts")}</dt><dd>{run.artifact_count}</dd></div>
                    <div><dt>{t("today.sourceErrors")}</dt><dd>{run.source_error_count}</dd></div>
                    {run.result_sha256 && <div><dt>SHA-256</dt><dd><code>{run.result_sha256}</code></dd></div>}
                  </dl>
                </details>
              </article>
            ))}
          </div>
        ) : (
          <div className="native-today-empty"><h3>{t("today.noRuns")}</h3><p>{t("today.noRunsHelp")}</p></div>
        )}
      </section>

      <section className="native-today-section" aria-labelledby="recent-vault-heading">
        <div className="section-heading-row">
          <div><p className="section-index">02</p><h2 id="recent-vault-heading">{t("today.recentVault")}</h2></div>
          <Link className="evidence-link" to="/library">{t("today.openLibrary")}</Link>
        </div>
        {recentItems.length ? (
          <div className="native-vault-list">
            {recentItems.slice(0, 6).map((item) => (
              <article key={item.id} onContextMenu={showResearchContextMenu}>
                <span>{itemKindLabel(item.kind)} · {formatDate(item.added_at)}</span>
                <h3>{item.title}</h3>
                <details><summary>{t("today.integrity")}</summary><code>{item.identity_sha256}</code></details>
              </article>
            ))}
          </div>
        ) : <p className="native-today-empty">{t("today.noLibrary")}</p>}
      </section>
    </>
  );
}

function StudyCard({ study, index }: { study: DigestStudy; index: number }) {
  const { locale, t } = useI18n();
  const statusLabel = study.status === "correction" ? t("today.correction") : t("today.new");

  return (
    <article
      className="study-card"
      onContextMenu={showResearchContextMenu}
    >
      <div className="study-number" aria-hidden="true">
        {String(index).padStart(2, "0")}
      </div>
      <div className="study-content">
        <div className="study-labels">
          <span>{localize(study.disciplineLabel, locale)}</span>
          <span className={study.status === "correction" ? "status-label correction" : "status-label"}>
            {study.status === "correction" ? "≠" : "+"} {statusLabel}
          </span>
          <span className="fixture-label">{t("today.fixture")}</span>
        </div>
        <h3>{localize(study.title, locale)}</h3>
        <p className="study-summary">{localize(study.summary, locale)}</p>
        <details className="why-details">
          <summary>{t("today.why")}</summary>
          <p className="study-citation">{study.authors} · {study.venue} · {localize(study.date, locale)}</p>
          <div className="study-facts" aria-label="Study metadata">
            <span>{localize(study.studyType, locale)}</span>
            <span>{localize(study.evidence, locale)}</span>
            <span>{study.relevance}% relevance</span>
          </div>
          <p>{localize(study.reason, locale)}</p>
        </details>
      </div>
      <Link
        className="evidence-link"
        to={`/reports/demo/claims/${study.claimId}`}
        aria-label={`${t("today.inspect")}: ${localize(study.title, locale)}`}
      >
        <ShieldCheck aria-hidden="true" size={18} />
        {t("today.inspect")}
      </Link>
    </article>
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

function AppearancePage() {
  const { locale, setLocale, t } = useI18n();
  const { theme, setTheme, motion, setMotion } = useAppearance();

  return (
    <main id="main-content" className="page appearance-page" tabIndex={-1}>
      <header className="page-heading">
        <p className="eyebrow">{t("appearance.eyebrow")}</p>
        <h1>{t("appearance.title")}</h1>
        <p className="lede">{t("appearance.lede")}</p>
      </header>

      <div className="settings-layout">
        <div className="settings-form">
          <fieldset className="settings-group">
            <legend>{t("appearance.theme")}</legend>
            <div className="choice-grid theme-grid">
              {(["system", "light", "dark"] as ThemePreference[]).map((value) => (
                <ChoiceCard
                  key={value}
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => setTheme(value)}
                  label={t(`appearance.${value}` as "appearance.system")}
                  marker={value === "system" ? "◐" : value === "light" ? "○" : "●"}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="settings-group">
            <legend>{t("appearance.motion")}</legend>
            <div className="choice-grid motion-grid">
              {(["full", "reduced", "off"] as MotionPreference[]).map((value) => (
                <ChoiceCard
                  key={value}
                  name="motion"
                  value={value}
                  checked={motion === value}
                  onChange={() => setMotion(value)}
                  label={t(`appearance.${value}` as "appearance.full")}
                  help={t(`appearance.${value}Help` as "appearance.fullHelp")}
                  marker={value === "full" ? "≡" : value === "reduced" ? "=" : "—"}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="settings-group">
            <legend>{t("appearance.language")}</legend>
            <div className="choice-grid language-grid">
              <ChoiceCard name="locale" value="en" checked={locale === "en"} onChange={() => setLocale("en")} label={t("app.english")} marker="En" />
              <ChoiceCard name="locale" value="tr" checked={locale === "tr"} onChange={() => setLocale("tr")} label={t("app.turkish")} marker="Tr" />
            </div>
          </fieldset>
          <p className="settings-saved" role="status"><Check aria-hidden="true" size={16} /> {t("appearance.saved")}</p>
        </div>

        <aside className="reading-preview" aria-labelledby="preview-heading">
          <p className="section-index">A4 · 01</p>
          <h2 id="preview-heading">{t("appearance.preview")}</h2>
          <h3>{t("appearance.previewTitle")}</h3>
          <p>{t("appearance.previewText")}</p>
          <div className="preview-claim">
            <span>C-017</span>
            <span>■ {t("claim.verified")}</span>
          </div>
        </aside>
      </div>
    </main>
  );
}

function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  label,
  help,
  marker,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  help?: string;
  marker: string;
}) {
  return (
    <label className={`choice-card${checked ? " is-selected" : ""}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span className="choice-marker" aria-hidden="true">{marker}</span>
      <span className="choice-copy">
        <b>{label}</b>
        {help && <small>{help}</small>}
      </span>
      <span className="choice-check" aria-hidden="true">{checked ? "■" : "□"}</span>
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
