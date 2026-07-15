import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "tr";

const messages = {
  en: {
    "app.skip": "Skip to content",
    "app.demo": "Browser-local alpha",
    "app.local": "Local app",
    "app.browserLocal": "browser-local",
    "app.language": "Language",
    "app.english": "English",
    "app.turkish": "Türkçe",
    "nav.primary": "Primary navigation",
    "nav.today": "Today",
    "nav.library": "Library",
    "nav.newReport": "New report",
    "nav.report": "Demo report",
    "nav.reader": "PDF reader",
    "nav.appearance": "Settings",
    "nav.privacy": "Privacy",
    "nav.research": "Research desk",
    "shortcuts.commands": "Commands",
    "shortcuts.today": "Go to Today",
    "shortcuts.todayHelp": "Open the current literature digest",
    "shortcuts.report": "Open report",
    "shortcuts.reportHelp": "Open the evidence-locked demonstration report",
    "shortcuts.newReport": "New report or watch",
    "shortcuts.newReportHelp": "Open the guided literature request",
    "shortcuts.library": "Open library",
    "shortcuts.libraryHelp": "Browse saved articles, reports, and notes",
    "shortcuts.librarySearch": "Search library",
    "shortcuts.librarySearchHelp": "Focus the library search field",
    "shortcuts.libraryOnly": "Available while the library is open",
    "shortcuts.reader": "Open PDF reader",
    "shortcuts.readerHelp": "Read, search, highlight, and annotate a saved article",
    "shortcuts.appearance": "Open Settings",
    "shortcuts.appearanceHelp": "Review app, research, storage, model, and appearance preferences",
    "shortcuts.toggleTheme": "Toggle reading theme",
    "shortcuts.toggleThemeHelp": "Switch between the light and dark reading rooms",
    "shortcuts.export": "Export references",
    "shortcuts.exportHelp": "Open the reference-manager export workflow",
    "shortcuts.verify": "Inspect report evidence",
    "shortcuts.verifyHelp": "Open the first claim in the evidence inspector",
    "shortcuts.reportOnly": "Available while the demonstration report is open",
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
    "today.liveLede": "Your recent watch runs and locally stored research, without demonstration records mixed in.",
    "today.loading": "Loading local watches, runs, and vault items…",
    "today.unavailable": "Local research status is unavailable",
    "today.unavailableHelp": "Litehouse did not substitute demonstration records. Try again after the local service is ready.",
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
    "today.demoTitle": "Demonstration dataset",
    "today.demoText": "These records exercise the interface only. No live retrieval or scientific recommendation has been performed.",
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
    "report.back": "Back to Today",
    "report.eyebrow": "Watch: molecular structure and interaction prediction",
    "report.title": "What changed in biomolecular structure prediction",
    "report.lede": "A compact demonstration of an evidence-locked report. Claims remain deliberately narrow and open directly to their supporting record.",
    "report.demo": "Demonstration report · illustrative content, not a live literature review",
    "report.verified": "Verified demo",
    "report.receipt": "Verification receipt",
    "report.claims": "3 claims linked",
    "report.sources": "2 source records",
    "report.limited": "1 abstract-only claim",
    "report.export": "Export references",
    "report.style": "Reference style",
    "report.outline": "Report outline",
    "report.summary": "Summary",
    "report.findings": "What changed",
    "report.limits": "Limits",
    "report.references": "References",
    "report.summaryText": "The watched literature shows a shift from protein-only prediction toward joint modelling of larger biomolecular complexes. This report describes capability, not clinical validity or experimental replacement.",
    "report.findingsText": "The model family represented in this sample expands the predicted interaction space and changes the architecture used to construct atomic coordinates.",
    "report.limitsText": "Benchmark performance does not establish accuracy for every molecular class. One claim is supported by an abstract only, and all experimental uses still require domain-appropriate validation.",
    "report.recommendation": "Litehouse recommendation",
    "report.recommendationText": "Read the methods and benchmark definitions before treating a reported improvement as transferable to a new molecular system.",
    "claim.open": "Open evidence for {{id}}",
    "claim.inspector": "Evidence inspector",
    "claim.close": "Close evidence inspector",
    "claim.verified": "Verified",
    "claim.limited": "Limited",
    "claim.scope": "Evidence scope",
    "claim.locator": "Exact locator",
    "claim.span": "Extracted supporting span",
    "claim.metadata": "Metadata reconciliation",
    "claim.sourceHash": "Source SHA-256",
    "claim.openSource": "Open original source",
    "claim.back": "Back to full report",
    "claim.notFound": "This claim is not part of the demonstration report.",
    "claim.field": "Field",
    "claim.canonical": "Canonical value",
    "claim.crosscheck": "Cross-check",
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
    "appearance.language": "Interface language",
    "appearance.preview": "Reading preview",
    "appearance.previewTitle": "Evidence should remain calm enough to examine.",
    "appearance.previewText": "Typography carries the hierarchy; color never carries scientific status by itself.",
    "appearance.saved": "Appearance choices are saved on this device.",
    "export.title": "Export to a reference manager",
    "export.close": "Close export",
    "export.scope": "Studies",
    "export.selected": "Selected studies (1)",
    "export.all": "All report studies (2)",
    "export.destination": "Destination preset",
    "export.zotero": "Zotero",
    "export.endnote": "EndNote",
    "export.mendeley": "Mendeley",
    "export.portable": "Portable formats",
    "export.delivery": "Delivery method",
    "export.push": "Direct push",
    "export.pushHelp": "Checks for a compatible local connector at export time.",
    "export.download": "Download file",
    "export.downloadHelp": "Works without an account or running reference manager.",
    "export.duplicates": "If a DOI or title already exists",
    "export.skip": "Skip duplicate",
    "export.merge": "Merge missing fields",
    "export.copy": "Create another copy",
    "export.attachments": "Include legally available attachments",
    "export.licenseWarning": "One source has metadata-only access. Its attachment will not be exported unless a reusable file and license are verified.",
    "export.preview": "Field preview",
    "export.titleField": "Title",
    "export.creators": "Creators",
    "export.identifier": "Identifier",
    "export.format": "Format",
    "export.prepare": "Prepare export",
    "export.check": "Check connector",
    "export.ready": "Export prepared. Review the field preview, then download the file.",
    "export.unavailable": "No compatible local connector was found. Choose Download file to continue.",
    "export.downloadNow": "Download {{format}}",
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

function storedLocale(): Locale {
  // Guard storage access; private-mode browsers can throw on read.
  try {
    return window.localStorage.getItem("litehouse.locale") === "tr" ? "tr" : "en";
  } catch {
    return "en";
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale] = useState<Locale>(storedLocale);

  useEffect(() => {
    try {
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
