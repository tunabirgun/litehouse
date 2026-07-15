import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en";

const messages = {
  en: {
    "app.skip": "Skip to content",
    "app.local": "Local app",
    "app.browserLocal": "browser-local",
    "nav.primary": "Primary navigation",
    "nav.today": "Today",
    "nav.library": "Library",
    "nav.newReport": "New report",
    "nav.appearance": "Settings",
    "nav.privacy": "Privacy",
    "nav.research": "Research desk",
    "shortcuts.commands": "Commands",
    "shortcuts.today": "Go to Today",
    "shortcuts.todayHelp": "Open the current literature digest",
    "shortcuts.newReport": "New report or watch",
    "shortcuts.newReportHelp": "Open the guided literature request",
    "shortcuts.library": "Open library",
    "shortcuts.libraryHelp": "Browse saved articles, reports, and notes",
    "shortcuts.librarySearch": "Search library",
    "shortcuts.librarySearchHelp": "Focus the library search field",
    "shortcuts.libraryOnly": "Available while the library is open",
    "shortcuts.appearance": "Open Settings",
    "shortcuts.appearanceHelp": "Review app, research, storage, model, and appearance preferences",
    "shortcuts.toggleTheme": "Toggle reading theme",
    "shortcuts.toggleThemeHelp": "Switch between the light and dark reading rooms",
    "shortcuts.readerOnly": "Available while a PDF is open",
    "shortcuts.readerSearch": "Search open PDF",
    "shortcuts.readerSearchHelp": "Find text across every page of the current PDF",
    "shortcuts.readerPrevious": "Previous PDF page",
    "shortcuts.readerPreviousHelp": "Move to the previous page in the reader",
    "shortcuts.readerNext": "Next PDF page",
    "shortcuts.readerNextHelp": "Move to the next page in the reader",
    "shortcuts.readerNote": "Add anchored note",
    "shortcuts.readerNoteHelp": "Create a note from the currently selected PDF text",
    "shortcuts.readerSave": "Save reading state",
    "shortcuts.readerSaveHelp": "Save page, zoom, rotation, highlights, and notes",
    "shortcuts.readerExport": "Export reader notes",
    "shortcuts.readerExportHelp": "Export anchored notes as Markdown",
    "today.eyebrow": "Wednesday, 15 July · Europe/Istanbul",
    "today.title": "Today",
    "today.lede": "Five carefully bounded research updates, with every summary linked back to inspectable evidence.",
    "today.loading": "Loading local watches, runs, and vault items…",
    "today.unavailable": "Local research status is unavailable",
    "today.liveStatus": "Local research status",
    "today.enabledWatches": "Enabled watches",
    "today.latestRun": "Latest run",
    "today.noRunsShort": "No runs yet",
    "today.recentRuns": "Recent watch runs",
    "today.previousRevision": "Previous watch revision",
    "today.reportReady": "Report stored in the vault",
    "today.runStatus": "Run status",
    "today.runDetails": "Run details",
    "today.artifacts": "Artifacts",
    "today.sourceErrors": "Source errors",
    "today.statusQueued": "Queued",
    "today.statusRunning": "Running",
    "today.statusPartial": "Partial",
    "today.statusSucceeded": "Succeeded",
    "today.statusFailed": "Failed",
    "today.statusCancelled": "Cancelled",
    "today.noRuns": "No watch runs yet",
    "today.noRunsHelp": "Create a report or recurring watch to begin a real local digest.",
    "today.recentVault": "Recent vault items",
    "today.openLibrary": "Open library",
    "today.integrity": "Integrity identity",
    "today.noLibrary": "No reports or research works have been stored yet.",
    "today.itemReport": "Report",
    "today.itemWork": "Research work",
    "today.lastRun": "Last successful scan",
    "today.lastRunValue": "07:30 · 6 sources",
    "today.nextRun": "Next scan",
    "today.nextRunValue": "Tomorrow at 07:30",
    "today.verified": "Verification",
    "today.verifiedValue": "12 of 12 claims linked",
    "today.filter": "Filter by discipline",
    "today.all": "All fields",
    "today.matches": "Highest-relevance updates",
    "today.matchesHelp": "Sorted by topic relevance. Evidence strength is shown separately.",
    "today.changed": "Status changed",
    "today.changedText": "One watched record received a correction notice. It remains in the digest with its updated status visible.",
    "today.openReport": "Open evidence report",
    "today.why": "Why it appeared",
    "today.inspect": "Inspect evidence",
    "today.new": "New",
    "today.correction": "Correction",
    "today.fixture": "Fixture",
    "today.noResults": "No sample records match this discipline.",
    "appearance.eyebrow": "Settings",
    "appearance.title": "Appearance",
    "appearance.lede": "Tune the reading surface without changing the evidence or report structure.",
    "appearance.theme": "Color theme",
    "appearance.system": "System",
    "appearance.light": "Reading room",
    "appearance.dark": "Night watch",
    "appearance.motion": "Motion",
    "appearance.full": "Full",
    "appearance.reduced": "Reduced",
    "appearance.off": "Off",
    "appearance.fullHelp": "Gentle page and control transitions; operating-system reduced-motion settings still take precedence.",
    "appearance.reducedHelp": "Opacity changes only, with shorter timing.",
    "appearance.offHelp": "No decorative animation or smooth scrolling.",
    "appearance.preview": "Reading preview",
    "appearance.previewTitle": "Evidence should remain calm enough to examine.",
    "appearance.previewText": "Typography carries the hierarchy; color never carries scientific status by itself.",
    "appearance.saved": "Appearance choices are saved on this device.",
  },
} satisfies Record<"en", Record<string, string>>;

type TranslationVariables = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof (typeof messages)["en"], variables?: TranslationVariables) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

// App is English-only; setLocale is a no-op kept for API compatibility.
const setLocale: I18nValue["setLocale"] = () => {};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale] = useState<Locale>("en");

  useEffect(() => {
    try {
      // Overwrite any stale locale left by earlier builds; the app is English-only.
      window.localStorage.setItem("litehouse.locale", "en");
    } catch {
      // Some privacy modes block storage writes; language is fixed to English regardless.
    }
    document.documentElement.lang = "en";
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t: I18nValue["t"] = (key, variables = {}) => {
      const template = messages.en[key];
      return Object.entries(variables).reduce(
        (result, [name, replacement]) => result.replaceAll(`{{${name}}}`, String(replacement)),
        template,
      );
    };

    return { locale, setLocale, t };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}
