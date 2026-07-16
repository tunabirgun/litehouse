import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  Check,
  FileCheck2,
  Info,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { saveBrowserReport } from "./browser/vault";
import { createGroundedReport, synthesisPrompt, SYNTHESIS_BUDGETS, type GroundedReport, type SynthesisDepth } from "./research/report";
import { reportToLatex } from "./research/latex";
import { digestCanonical } from "./research/integrity";
import { searchLiterature } from "./research/sources";
import type { BrowserSourceId } from "./research/types";
import { generateWithRemoteProvider, RemoteProviderError } from "./providers/remote";
import { getSessionRemoteProvider } from "./providers/session";
import { browserModelRuntime } from "./llm/browserModelRuntime";

type RunMode = "one-off" | "watch";
type AccessPolicy = "open-only" | "include-abstracts";

export interface WizardData {
  mode: RunMode;
  topic: string;
  scope: string;
  exclusions: string;
  fromDate: string;
  toDate: string;
  frequency: "daily" | "weekly" | "monthly";
  deliveryTime: string;
  timezone: string;
  languages: string[];
  disciplines: string[];
  workTypes: string[];
  expertise: string[];
  priorKnowledge: string;
  accessPolicy: AccessPolicy;
  sources: string[];
  ranking: string[];
  depth: "brief" | "standard" | "deep";
  synthesisMode: "ai" | "evidence";
  recommendations: boolean;
  citation: string;
}

export type SubmissionReceipt =
  | { kind: "browser"; report: GroundedReport }
  | { kind: "watch"; watchId: string; runId: string; runStatus: string; browserReport?: GroundedReport };

const BROWSER_SOURCES = new Set<BrowserSourceId>([
  "openalex",
  "crossref",
  "datacite",
  "europe-pmc",
  "semantic-scholar",
  "library-of-congress",
]);

function localIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface WizardPreferenceDefaults {
  expertise: string;
  priorKnowledge: string;
  defaultTimezone: string;
  sources: Record<string, boolean>;
  openOnly: boolean;
  citation: string;
}

function readPreferenceDefaults(): Partial<WizardPreferenceDefaults> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("litehouse.settings.v1") ?? "{}") as Partial<WizardPreferenceDefaults>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createDefaultDraft(): WizardData {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  const preferences = readPreferenceDefaults();
  const preferredSources = preferences.sources
    ? Object.entries(preferences.sources).filter(([, enabled]) => enabled).map(([source]) => source)
    : [];
  return {
    mode: "one-off",
    topic: "",
    scope: "",
    exclusions: "",
    fromDate: localIsoDate(from),
    toDate: localIsoDate(to),
    frequency: "weekly",
    deliveryTime: "07:30",
    timezone: preferences.defaultTimezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    languages: ["en"],
    disciplines: [],
    workTypes: ["journal-article"],
    expertise: [preferences.expertise?.trim() || "doctoral"],
    priorKnowledge: preferences.priorKnowledge ?? "",
    accessPolicy: preferences.openOnly === true ? "open-only" : "include-abstracts",
    sources: preferredSources.length ? preferredSources : ["openalex", "crossref", "datacite"],
    ranking: ["recent-attention", "normalized-influence"],
    depth: "standard",
    synthesisMode: "ai",
    recommendations: true,
    citation: preferences.citation?.trim() || "apa-7",
  };
}

function readDraft(): WizardData {
  const defaults = createDefaultDraft();
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem("litehouse.report-draft.v1") ?? "{}",
    ) as Partial<WizardData>;
    return {
      ...defaults,
      ...parsed,
      languages: Array.isArray(parsed.languages) ? parsed.languages : defaults.languages,
      disciplines: Array.isArray(parsed.disciplines) ? parsed.disciplines : defaults.disciplines,
      workTypes: Array.isArray(parsed.workTypes) ? parsed.workTypes : defaults.workTypes,
      expertise: Array.isArray(parsed.expertise) ? parsed.expertise : defaults.expertise,
      sources: Array.isArray(parsed.sources) ? parsed.sources : defaults.sources,
      ranking: Array.isArray(parsed.ranking) ? parsed.ranking : defaults.ranking,
      synthesisMode: parsed.synthesisMode === "evidence" ? "evidence" : "ai",
    };
  } catch {
    return defaults;
  }
}

const steps = ["intent", "coverage", "reader", "evidence", "output", "review"] as const;

const copy = {
  eyebrow: "Guided literature request",
  title: "Build a report with explicit boundaries",
  lede: "Litehouse asks the questions that change retrieval, ranking, evidence access, and the form of the final report.",
  back: "Back to Today",
  draft: "Draft saved on this device",
  steps: ["Intent", "Coverage", "Reader", "Evidence", "Output", "Review"],
  previous: "Previous",
  next: "Continue",
  required: "Complete the required choices before continuing.",
  intentTitle: "What should Litehouse investigate?",
  intentHelp: "State the concept in your own terms. Scope and exclusions prevent broad searches from drifting.",
  mode: "Request type",
  oneOff: "One-off report",
  oneOffHelp: "Search once for the selected publication interval.",
  watch: "Saved search — re-run manually while open",
  watchHelp: "Run the bounded search now and save the definition. A static site has no background scheduler, so you re-run it yourself while Litehouse is open.",
  topic: "Topic or research question",
  topicPlaceholder: "e.g. How have artists used machine vision in documentary practice?",
  scope: "Scope and concepts to include",
  scopePlaceholder: "Populations, places, methods, theories, media, or adjacent terms…",
  exclusions: "Exclusions",
  exclusionsPlaceholder: "Terms, study designs, populations, or interpretations to leave out…",
  coverageTitle: "Set the publication window and sources of variation",
  interval: "Publication interval",
  from: "From",
  to: "To",
  schedule: "Saved-search preferences (inert — no background delivery)",
  frequency: "Frequency (label only)",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  time: "Local time (label only)",
  timezone: "Time zone (IANA, label only)",
  languages: "Publication languages",
  languageHelp: "English is selected by default. Select more than one when translated or multilingual work is in scope.",
  disciplines: "Research fields",
  disciplinesHelp: "Choose every field whose sources and work types should be searched.",
  workTypes: "Work types",
  readerTitle: "Calibrate the report to its reader",
  expertise: "Ordered education and expertise",
  expertiseHelp: "The first selection sets the primary reading level. Reorder the list to express mixed backgrounds.",
  prior: "Prior knowledge and terminology",
  priorPlaceholder: "Methods, theories, organisms, periods, software, or concepts the report may assume…",
  moveUp: "Move up",
  moveDown: "Move down",
  evidenceTitle: "Choose access and ranking rules",
  access: "Access policy",
  openOnly: "Open full text only",
  openOnlyHelp: "Retrieve and read full text only when access and reuse terms can be verified.",
  includeAbstracts: "Include paywalled records as metadata and abstracts",
  includeAbstractsHelp: "Explicit opt-in. Litehouse may summarize the available abstract, labels it abstract-only, and never tries to obtain paid full text.",
  noBypass: "Litehouse never bypasses authentication, paywalls, access controls, or publisher terms.",
  sources: "Scholarly sources",
  ranking: "Impact-ranking intent",
  rankingHelp: "Ranking changes reading order, not scientific truth. Every signal stays visible and separate from evidence strength.",
  rankingTruth: "No citation, venue, or attention signal is treated as proof that a claim is true.",
  outputTitle: "Shape the report",
  synthesisTitle: "Synthesis mode",
  synthesisAi: "AI synthesis",
  synthesisAiHelp: "A local model reads the top-ranked sources and writes a cited, prose synthesis. Needs a downloaded model (Settings → Local AI) and takes longer.",
  synthesisEvidence: "Evidence overview",
  synthesisEvidenceHelp: "No model needed. Lists each accepted source with its access state and a short abstract excerpt. Fast, and works on any device.",
  depth: "Comprehensiveness",
  brief: "Brief digest",
  standard: "Standard review",
  deep: "Deep review",
  briefHelp: "Two or three paragraphs on the strongest convergent findings. Fastest.",
  standardHelp: "Several paragraphs across findings, disagreements, and limitations. Balanced default.",
  deepHelp: "Comprehensive, multi-theme synthesis over more sources. Slowest, uses more memory.",
  depthWarning: "More comprehensive reports read more sources and write a longer synthesis, so on-device generation runs noticeably longer. Deep also widens the model's context window and uses more memory.",
  recommendations: "Include bounded reading recommendations",
  recommendationsHelp: "Recommendations cite their evidence and explain why the work may merit closer reading.",
  citation: "Reference style",
  reviewTitle: "Review the retrieval contract",
  reviewHelp: "These choices become an immutable request revision. Later edits create a new revision so prior reports remain reproducible.",
  inquiry: "Inquiry",
  timing: "Timing",
  audience: "Audience",
  accessReview: "Access",
  rankingReview: "Ranking",
  deliverables: "Deliverables",
  submitOne: "Generate evidence-locked report",
  submitWatch: "Run now and save this search",
  savedTitle: "Request saved",
  preparedOne: "The bounded search completed and its evidence-locked report artifacts were stored in the local vault.",
  savedOne: "The one-off request was stored as a local alpha draft and is ready for the retrieval service.",
  savedWatch: "The first report and reusable search definition were stored in this browser. Future runs must be started manually.",
  newRequest: "Start another request",
  localCaveat: "Web alpha: retrieval runs directly from this tab to the selected scholarly APIs. Reports stay in this browser. A static site has no background scheduler, so every future run of a saved search must be started manually while Litehouse is open.",
  preparing: "Preparing…",
  submitFailed: "The browser could not complete this bounded retrieval. The draft remains saved for review; source-level CORS failures are never silently replaced.",
  downloadMarkdown: "Download verified Markdown",
  storedInBrowser: "Stored in this browser vault",
  preparationReceipt: "Report receipt",
  preparationSha: "Preparation SHA-256",
  resultSha: "Result SHA-256",
  fetched: "Works",
  included: "Claims",
  returned: "Evidence excerpts",
  sourceState: "Generated artifacts",
  synthesis: "Synthesis",
  appliedCitation: "Applied citation style",
  artifactIntegrity: "Artifact and manifest integrity",
  formatIssues: "Unavailable requested formats",
  partialSources: "Partial source failures",
  completeSources: "All selected sources responded",
  firstResults: "Vault artifacts",
  queuedRun: "First run completed",
  watchIdentifier: "Saved-search identifier",
  runIdentifier: "Run identifier",
  runStatus: "Run status",
} as const;

const optionCopy = {
  languages: [
    ["en", "English"],
    ["tr", "Turkish"],
    ["de", "German"],
    ["fr", "French"],
    ["es", "Spanish"],
    ["other", "Other"],
  ],
  disciplines: [
    ["humanities", "Humanities"],
    ["arts", "Arts and design"],
    ["social-sciences", "Social sciences"],
    ["natural-sciences", "Natural sciences"],
    ["life-sciences", "Life sciences and health"],
    ["technology", "Engineering and technology"],
    ["law-policy", "Law and policy"],
    ["interdisciplinary", "Interdisciplinary"],
  ],
  workTypes: [
    ["journal-article", "Journal articles"],
    ["book-chapter", "Books and chapters"],
    ["conference", "Conference papers"],
    ["preprint", "Preprints"],
    ["dataset", "Datasets"],
    ["thesis", "Theses"],
    ["report", "Reports and standards"],
    ["creative-work", "Creative works and catalogues"],
  ],
  expertise: [
    ["secondary", "Secondary education"],
    ["undergraduate", "Undergraduate"],
    ["masters", "Master's"],
    ["doctoral", "Doctoral"],
    ["postdoctoral", "Postdoctoral"],
    ["faculty", "Faculty"],
    ["professional", "Professional practice"],
    ["independent", "Independent researcher"],
  ],
  sources: [
    ["openalex", "OpenAlex"],
    ["crossref", "Crossref"],
    ["datacite", "DataCite"],
    ["europe-pmc", "Europe PMC"],
    ["semantic-scholar", "Semantic Scholar"],
    ["library-of-congress", "Library of Congress"],
  ],
  ranking: [
    ["recent-attention", "Recent scholarly attention"],
    ["normalized-influence", "Field- and age-normalized influence"],
    ["seminal", "Seminal or field-forming work"],
    ["methodological", "Methodological relevance"],
    ["open-coverage", "Broad and open coverage"],
  ],
} as const;

function optionLabel(option: readonly [string, string]) {
  return option[1];
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function buildApiSpecification(draft: WizardData) {
  const fieldMap: Record<string, string> = {
    humanities: "humanities",
    arts: "arts",
    "social-sciences": "social_sciences",
    "natural-sciences": "natural_sciences",
    "life-sciences": "life_sciences",
    technology: "engineering_technology",
    "law-policy": "law_policy",
    interdisciplinary: "interdisciplinary",
  };
  const workTypeMap: Record<string, string[]> = {
    "journal-article": ["journal_article"],
    "book-chapter": ["book", "book_chapter"],
    conference: ["conference_paper"],
    preprint: ["preprint"],
    dataset: ["dataset"],
    thesis: ["thesis"],
    report: ["report_standard"],
    "creative-work": ["creative_work_catalogue"],
  };
  const expertiseMap: Record<string, string> = {
    independent: "independent_researcher",
  };
  const sourceMap: Record<string, string> = {
    "europe-pmc": "europe_pmc",
    "semantic-scholar": "semantic_scholar",
    "library-of-congress": "library_of_congress",
  };
  const rankingMap: Record<string, string> = {
    "recent-attention": "recent_attention",
    "normalized-influence": "field_age_normalized_influence",
    seminal: "seminal_field_forming",
    methodological: "methodological_relevance",
    "open-coverage": "broad_open_coverage",
  };
  const exclusions = draft.exclusions
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 30);
  const [hour = "7", minute = "30"] = draft.deliveryTime.split(":");
  const cron = draft.frequency === "daily"
    ? `${minute} ${hour} * * *`
    : draft.frequency === "weekly"
      ? `${minute} ${hour} * * 1`
      : `${minute} ${hour} 1 * *`;
  const from = new Date(`${draft.fromDate}T00:00:00Z`);
  const to = new Date(`${draft.toDate}T00:00:00Z`);
  const recencyDays = Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())
    ? Math.max(1, Math.min(3650, Math.round((to.getTime() - from.getTime()) / 86_400_000)))
    : 365;
  return {
    topics: [draft.topic.trim()],
    query: draft.topic.trim(),
    scope: draft.scope.trim(),
    exclusions,
    fields: draft.disciplines.map((value) => fieldMap[value] ?? "other"),
    languages: draft.languages.map((value) => value === "other" ? "und" : value),
    work_types: [...new Set(draft.workTypes.flatMap((value) => workTypeMap[value] ?? []))],
    expertise: {
      ordered_levels: draft.expertise.map((value) => expertiseMap[value] ?? value),
      prior_knowledge: draft.priorKnowledge.trim(),
    },
    timezone: draft.timezone.trim(),
    schedule: draft.mode === "watch"
      ? { kind: "cron", expression: cron }
      : { kind: "interval", every: 1, unit: "days", start_at: new Date().toISOString() },
    recency_days: recencyDays,
    publication_from: draft.fromDate,
    publication_to: draft.toDate,
    citation_style: draft.citation,
    sources: draft.sources.map((value) => sourceMap[value] ?? value),
    access_policy: draft.accessPolicy === "include-abstracts"
      ? "include_paywalled_abstracts"
      : "open_full_text_only",
    impact_intents: draft.ranking.map((value) => rankingMap[value]),
    report_depth: draft.depth,
    include_recommendations: draft.recommendations,
    output_formats: ["markdown"],
  };
}

function requestSucceeded(status: number) {
  return status >= 200 && status < 300;
}

/**
 * This is called only after the user confirms the immutable retrieval contract.
 * The static browser edition uses its explicit direct-fetch path. Native builds use
 * the authenticated bridge and never silently downgrade to browser mode on error.
 */
export interface ReportProgress {
  phase: "retrieval" | "synthesis" | "finalizing";
  label: string;
  etaSeconds?: number;
}

export async function executeGuidedRequest(
  draft: WizardData,
  onProgress?: (progress: ReportProgress) => void,
): Promise<SubmissionReceipt> {
  const selectedSources = draft.sources.filter(
    (source): source is BrowserSourceId => BROWSER_SOURCES.has(source as BrowserSourceId),
  );
  onProgress?.({ phase: "retrieval", label: "Searching scholarly sources…" });
  const retrieval = await searchLiterature({
    query: [draft.topic.trim(), draft.scope.trim()].filter(Boolean).join(" "),
    sources: selectedSources,
    fromDate: draft.fromDate,
    toDate: draft.toDate,
    openAccessOnly: draft.accessPolicy === "open-only",
    languages: draft.languages,
    disciplines: draft.disciplines,
    workTypes: draft.workTypes,
    exclusions: draft.exclusions
      .split(/[\n,;]+/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 30),
    perSourceLimit: SYNTHESIS_BUDGETS[draft.depth].perSourceLimit,
  });
  let llmSynthesis: string | undefined;
  let synthesisFailure: string | undefined;
  const systemPrompt = "You are an evidence-bound literature review assistant. Never use unstated knowledge and obey the source-citation contract exactly.";
  const buildMessages = (depth: SynthesisDepth) => [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: synthesisPrompt(draft.topic.trim(), retrieval.records, depth) },
  ];
  // Only reach for a model when the user chose AI synthesis; "evidence" mode stays a
  // deterministic listing regardless of whether a model is loaded. Reasoning models spend
  // tokens on a hidden <think> block, so each depth's maxTokens leaves room for reasoning
  // plus the synthesis inside its context window.
  const remote = draft.synthesisMode === "ai" ? getSessionRemoteProvider() : null;
  if (remote) {
    onProgress?.({ phase: "synthesis", label: "Writing the synthesis with the connected model…" });
    try {
      const generated = await generateWithRemoteProvider({
        config: remote.config,
        apiKey: remote.apiKey,
        messages: buildMessages(draft.depth),
        maxOutputTokens: SYNTHESIS_BUDGETS[draft.depth].maxTokens,
      });
      llmSynthesis = generated.text;
    } catch (error) {
      synthesisFailure = error instanceof RemoteProviderError ? error.code : "unknown";
    }
  } else if (draft.synthesisMode === "ai" && browserModelRuntime.getSnapshot().phase === "ready") {
    // A deeper report needs a wider context window; widen it first (slower, more memory) and
    // drop to the standard budget if the widen did not take, so the prompt never overflows.
    const requested = SYNTHESIS_BUDGETS[draft.depth];
    const availableContext = await browserModelRuntime.ensureContextWindow(requested.contextWindow);
    const depth: SynthesisDepth = availableContext >= requested.contextWindow ? draft.depth : "standard";
    const budget = SYNTHESIS_BUDGETS[depth];
    const startedAt = Date.now();
    onProgress?.({ phase: "synthesis", label: "Writing the synthesis with the on-device model…" });
    try {
      llmSynthesis = await browserModelRuntime.completeChat(buildMessages(depth), {
        maxTokens: budget.maxTokens,
        temperature: 0,
        onToken: (tokens) => {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = tokens / Math.max(elapsed, 0.1);
          const etaSeconds = tokens > 6 && rate > 0.3 ? Math.round(Math.max(0, budget.maxTokens - tokens) / rate) : undefined;
          onProgress?.({ phase: "synthesis", label: `Writing the synthesis · ${tokens} tokens`, etaSeconds });
        },
      });
    } catch {
      synthesisFailure = "browser-model-generation";
    }
  }
  onProgress?.({ phase: "finalizing", label: "Assembling and verifying the report…" });
  const report = await createGroundedReport({
    query: draft.topic.trim(),
    retrieval,
    llmSynthesis,
    synthesisFailure,
  });
  await saveBrowserReport(report);
  if (draft.mode === "one-off") return { kind: "browser", report };

  const specification = buildApiSpecification(draft);
  const specificationSha256 = await digestCanonical(specification);
  const watchId = `web-${specificationSha256.slice(0, 20)}`;
  const watch = {
    id: watchId,
    name: draft.topic.trim().slice(0, 160),
    specification,
    specificationSha256,
    createdAt: new Date().toISOString(),
    lastReportId: report.id,
    executionPolicy: "manual-while-open",
  };
  let watches: unknown[] = [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem("litehouse.browser-watches.v1") ?? "[]");
    if (Array.isArray(parsed)) watches = parsed;
  } catch {
    watches = [];
  }
  try {
    window.localStorage.setItem(
      "litehouse.browser-watches.v1",
      JSON.stringify([...watches.filter((item) => objectWatchId(item) !== watchId), watch]),
    );
  } catch {
    // Storage may be blocked or full; the report is already in the vault, so the
    // watch definition is best-effort and must not fail the run.
  }
  return {
    kind: "watch",
    watchId,
    runId: report.id,
    runStatus: "succeeded · future runs require a manual review while Litehouse is open",
    browserReport: report,
  };
}

function objectWatchId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function downloadReportFile(report: GroundedReport, ext: "md" | "tex"): void {
  const value = ext === "tex" ? reportToLatex(report) : report.markdown;
  const type = ext === "tex" ? "application/x-tex" : "text/markdown";
  const blob = new Blob([value], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `litehouse-${report.id}.${ext}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBrowserMarkdown(report: GroundedReport): void {
  downloadReportFile(report, "md");
}

export function ReportWizardPage() {
  const c = copy;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardData>(readDraft);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [progress, setProgress] = useState<ReportProgress | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem("litehouse.report-draft.v1", JSON.stringify(draft));
      } catch {
        // Storage may be blocked or full; autosave is best-effort and never fatal.
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft]);

  function update<K extends keyof WizardData>(key: K, value: WizardData[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setSaved(false);
    setReceipt(null);
  }

  function validCurrentStep() {
    if (step === 0) return draft.topic.trim().length >= 3;
    if (step === 1) {
      // Schedule inputs are inert on a static site, so they are never required.
      return Boolean(
        draft.fromDate &&
          draft.toDate &&
          draft.fromDate <= draft.toDate &&
          draft.languages.length,
      );
    }
    if (step === 2) return Boolean(draft.disciplines.length && draft.workTypes.length && draft.expertise.length);
    if (step === 3) return Boolean(draft.sources.length && draft.ranking.length);
    return true;
  }

  // Name the field that is blocking the step so the message points somewhere concrete.
  function requiredMessage() {
    if (step === 0) return "Add a topic or research question (at least three characters) before continuing.";
    if (step === 1) {
      if (!draft.fromDate || !draft.toDate) return "Set both publication dates before continuing.";
      if (draft.fromDate > draft.toDate) return "Set the From date on or before the To date before continuing.";
      return "Select at least one publication language before continuing.";
    }
    if (step === 2) {
      if (!draft.disciplines.length) return "Select at least one research field before continuing.";
      if (!draft.workTypes.length) return "Select at least one work type before continuing.";
      return "Select at least one expertise level before continuing.";
    }
    if (step === 3) {
      if (!draft.sources.length) return "Select at least one scholarly source before continuing.";
      return "Select at least one impact-ranking intent before continuing.";
    }
    return c.required;
  }

  function next() {
    if (!validCurrentStep()) {
      setError(requiredMessage());
      window.setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }
    setStep((current) => Math.min(current + 1, steps.length - 1));
    setError("");
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const nextReceipt = await executeGuidedRequest(draft, setProgress);
      // executeGuidedRequest already persisted the full report to the vault, so the
      // request is complete here. Register success before touching saved-request.v1.
      setReceipt(nextReceipt);
      setSaved(true);
      // Best-effort breadcrumb only. Storing the full report can exceed the quota;
      // that must never be reported as a generation failure, so it is isolated.
      const report =
        nextReceipt.kind === "browser" ? nextReceipt.report : nextReceipt.browserReport;
      try {
        window.localStorage.setItem(
          "litehouse.saved-request.v1",
          JSON.stringify({
            reportId: report?.id,
            query: draft.topic.trim(),
            reportSha256: report?.reportSha256,
            savedAt: new Date().toISOString(),
            revision: 1,
          }),
        );
      } catch {
        // Quota or serialization failure on the breadcrumb is non-fatal.
      }
    } catch {
      setError(c.submitFailed);
      window.setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const selectedLabels = useMemo(() => {
    const labels = (group: keyof typeof optionCopy, values: string[]) =>
      optionCopy[group]
        .filter((option) => values.includes(option[0]))
        .map((option) => optionLabel(option))
        .join(", ");
    return {
      disciplines: labels("disciplines", draft.disciplines),
      workTypes: labels("workTypes", draft.workTypes),
      expertise: labels("expertise", draft.expertise),
      sources: labels("sources", draft.sources),
      ranking: labels("ranking", draft.ranking),
    };
  }, [draft]);

  return (
    <main id="main-content" className="page lh-wizard-page" tabIndex={-1}>
      <Link className="back-link" to="/today">
        <ArrowLeft aria-hidden="true" size={16} /> {c.back}
      </Link>
      <header className="page-heading lh-workspace-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
        <p className="lh-autosave"><Check aria-hidden="true" size={15} /> {c.draft}</p>
      </header>

      <div className="lh-wizard-shell">
        <nav className="lh-step-progress" aria-label="Report request progress">
          <span>{`Step ${step + 1} of ${steps.length}`}</span>
          <strong aria-current="step">{c.steps[step]}</strong>
          <progress value={step + 1} max={steps.length} aria-label="Report request completion" />
        </nav>

        <form className="lh-wizard-form" onSubmit={(event) => event.preventDefault()}>
          {step === 0 && <IntentStep c={c} draft={draft} update={update} />}
          {step === 1 && <CoverageStep c={c} draft={draft} update={update} />}
          {step === 2 && <ReaderStep c={c} draft={draft} update={update} />}
          {step === 3 && <EvidenceStep c={c} draft={draft} update={update} />}
          {step === 4 && <OutputStep c={c} draft={draft} update={update} />}
          {step === 5 && (
            <ReviewStep
              c={c}
              draft={draft}
              labels={selectedLabels}
              saved={saved}
              submitting={submitting}
              progress={progress}
              receipt={receipt}
              onSubmit={submit}
              onRestart={() => {
                setDraft(createDefaultDraft());
                setStep(0);
                setSaved(false);
                setReceipt(null);
                setError("");
              }}
            />
          )}

          {error && <p ref={errorRef} className="lh-form-error" role="alert" tabIndex={-1}>{error}</p>}
          {step < 5 && (
            <div className="lh-wizard-actions">
              <button className="button button-secondary" type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>
                <ArrowLeft aria-hidden="true" size={17} /> {c.previous}
              </button>
              <button className="button button-primary" type="button" onClick={next}>
                {c.next} <ArrowRight aria-hidden="true" size={17} />
              </button>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}

type Copy = typeof copy;
type Update = <K extends keyof WizardData>(key: K, value: WizardData[K]) => void;

function IntentStep({ c, draft, update }: { c: Copy; draft: WizardData; update: Update }) {
  return (
    <WizardSection title={c.intentTitle} help={c.intentHelp} index="01">
      <fieldset className="lh-fieldset">
        <legend>{c.mode}</legend>
        <div className="lh-card-choices two-column">
          <OptionCard checked={draft.mode === "one-off"} name="mode" value="one-off" label={c.oneOff} help={c.oneOffHelp} onChange={() => update("mode", "one-off")} />
          <OptionCard checked={draft.mode === "watch"} name="mode" value="watch" label={c.watch} help={c.watchHelp} onChange={() => update("mode", "watch")} />
        </div>
      </fieldset>
      <label className="lh-field">
        <span>{c.topic} <i aria-hidden="true">*</i></span>
        <textarea required rows={3} maxLength={200} value={draft.topic} onChange={(event) => update("topic", event.target.value)} placeholder={c.topicPlaceholder} />
      </label>
      <div className="lh-two-fields">
        <label className="lh-field"><span>{c.scope}</span><textarea rows={5} maxLength={4000} value={draft.scope} onChange={(event) => update("scope", event.target.value)} placeholder={c.scopePlaceholder} /></label>
        <label className="lh-field"><span>{c.exclusions}</span><textarea rows={5} maxLength={4000} value={draft.exclusions} onChange={(event) => update("exclusions", event.target.value)} placeholder={c.exclusionsPlaceholder} /></label>
      </div>
    </WizardSection>
  );
}

function CoverageStep({ c, draft, update }: { c: Copy; draft: WizardData; update: Update }) {
  return (
    <WizardSection title={c.coverageTitle} index="02">
      <fieldset className="lh-fieldset">
        <legend>{c.interval}</legend>
        <div className="lh-two-fields compact">
          <label className="lh-field"><span>{c.from} <i aria-hidden="true">*</i></span><input type="date" required value={draft.fromDate} max={draft.toDate} onChange={(event) => update("fromDate", event.target.value)} /></label>
          <label className="lh-field"><span>{c.to} <i aria-hidden="true">*</i></span><input type="date" required value={draft.toDate} min={draft.fromDate} onChange={(event) => update("toDate", event.target.value)} /></label>
        </div>
      </fieldset>
      {draft.mode === "watch" && (
        <fieldset className="lh-fieldset lh-schedule-box">
          <legend><CalendarClock aria-hidden="true" size={17} /> {c.schedule}</legend>
          <div className="lh-three-fields">
            <label className="lh-field"><span>{c.frequency}</span><select value={draft.frequency} onChange={(event) => update("frequency", event.target.value as WizardData["frequency"])}><option value="daily">{c.daily}</option><option value="weekly">{c.weekly}</option><option value="monthly">{c.monthly}</option></select></label>
            <label className="lh-field"><span>{c.time}</span><input type="time" value={draft.deliveryTime} onChange={(event) => update("deliveryTime", event.target.value)} /></label>
            <label className="lh-field"><span>{c.timezone}</span><input value={draft.timezone} onChange={(event) => update("timezone", event.target.value)} /></label>
          </div>
        </fieldset>
      )}
      <CheckboxGroup legend={c.languages} help={c.languageHelp} options={optionCopy.languages} values={draft.languages} onChange={(value) => update("languages", toggleValue(draft.languages, value))} />
    </WizardSection>
  );
}

function ReaderStep({ c, draft, update }: { c: Copy; draft: WizardData; update: Update }) {
  function move(index: number, offset: -1 | 1) {
    const next = [...draft.expertise];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update("expertise", next);
  }
  return (
    <WizardSection title={c.readerTitle} index="03">
      <CheckboxGroup legend={c.disciplines} help={c.disciplinesHelp} options={optionCopy.disciplines} values={draft.disciplines} onChange={(value) => update("disciplines", toggleValue(draft.disciplines, value))} />
      <CheckboxGroup legend={c.workTypes} options={optionCopy.workTypes} values={draft.workTypes} onChange={(value) => update("workTypes", toggleValue(draft.workTypes, value))} />
      <fieldset className="lh-fieldset">
        <legend>{c.expertise}</legend>
        <p className="lh-field-help">{c.expertiseHelp}</p>
        <div className="lh-expertise-grid">
          <div className="lh-check-grid">
            {optionCopy.expertise.map((option) => (
              <label className="lh-checkbox" key={option[0]}>
                <input type="checkbox" checked={draft.expertise.includes(option[0])} onChange={() => update("expertise", toggleValue(draft.expertise, option[0]))} />
                <span>{optionLabel(option)}</span>
              </label>
            ))}
          </div>
          <ol className="lh-order-list" aria-label={c.expertise}>
            {draft.expertise.map((value, index) => {
              const option = optionCopy.expertise.find((item) => item[0] === value);
              return (
                <li key={value}>
                  <span><b>{index + 1}</b>{option ? optionLabel(option) : value}</span>
                  <span>
                    <button type="button" onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp aria-hidden="true" size={15} /><span className="sr-only">{c.moveUp}</span></button>
                    <button type="button" onClick={() => move(index, 1)} disabled={index === draft.expertise.length - 1}><ArrowDown aria-hidden="true" size={15} /><span className="sr-only">{c.moveDown}</span></button>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </fieldset>
      <label className="lh-field"><span>{c.prior}</span><textarea rows={6} maxLength={4000} value={draft.priorKnowledge} onChange={(event) => update("priorKnowledge", event.target.value)} placeholder={c.priorPlaceholder} /><small>{draft.priorKnowledge.length}/4000</small></label>
    </WizardSection>
  );
}

function EvidenceStep({ c, draft, update }: { c: Copy; draft: WizardData; update: Update }) {
  return (
    <WizardSection title={c.evidenceTitle} index="04">
      <fieldset className="lh-fieldset">
        <legend>{c.access}</legend>
        <div className="lh-card-choices two-column">
          <OptionCard checked={draft.accessPolicy === "open-only"} name="access" value="open-only" label={c.openOnly} help={c.openOnlyHelp} onChange={() => update("accessPolicy", "open-only")} />
          <OptionCard checked={draft.accessPolicy === "include-abstracts"} name="access" value="include-abstracts" label={c.includeAbstracts} help={c.includeAbstractsHelp} onChange={() => update("accessPolicy", "include-abstracts")} />
        </div>
        <p className="lh-safety-note"><ShieldCheck aria-hidden="true" size={18} /> {c.noBypass}</p>
      </fieldset>
      <CheckboxGroup legend={c.sources} options={optionCopy.sources} values={draft.sources} onChange={(value) => update("sources", toggleValue(draft.sources, value))} />
      <CheckboxGroup legend={c.ranking} help={c.rankingHelp} options={optionCopy.ranking} values={draft.ranking} onChange={(value) => update("ranking", toggleValue(draft.ranking, value))} />
      <p className="lh-ranking-note"><Info aria-hidden="true" size={18} /> {c.rankingTruth}</p>
    </WizardSection>
  );
}

function OutputStep({ c, draft, update }: { c: Copy; draft: WizardData; update: Update }) {
  return (
    <WizardSection title={c.outputTitle} index="05">
      <fieldset className="lh-fieldset">
        <legend>{c.synthesisTitle}</legend>
        <div className="lh-card-choices two-column">
          <OptionCard checked={draft.synthesisMode === "ai"} name="synthesisMode" value="ai" label={c.synthesisAi} help={c.synthesisAiHelp} onChange={() => update("synthesisMode", "ai")} />
          <OptionCard checked={draft.synthesisMode === "evidence"} name="synthesisMode" value="evidence" label={c.synthesisEvidence} help={c.synthesisEvidenceHelp} onChange={() => update("synthesisMode", "evidence")} />
        </div>
      </fieldset>
      <fieldset className="lh-fieldset">
        <legend>{c.depth}</legend>
        <div className="lh-card-choices three-column">
          {([["brief", c.briefHelp], ["standard", c.standardHelp], ["deep", c.deepHelp]] as const).map(([value, help]) => <OptionCard key={value} checked={draft.depth === value} name="depth" value={value} label={c[value]} help={help} onChange={() => update("depth", value)} />)}
        </div>
        <p className="lh-field-help">{c.depthWarning}</p>
      </fieldset>
      <label className="lh-checkbox lh-feature-check"><input type="checkbox" checked={draft.recommendations} onChange={(event) => update("recommendations", event.target.checked)} /><span><b>{c.recommendations}</b><small>{c.recommendationsHelp}</small></span></label>
      <label className="lh-field lh-select-field"><span>{c.citation}</span><select value={draft.citation} onChange={(event) => update("citation", event.target.value)}><option value="apa-7">APA 7</option><option value="ieee">IEEE</option><option value="chicago-author-date">Chicago author–date</option><option value="mla-9">MLA 9</option><option value="vancouver">Vancouver</option><option value="harvard-cite-them-right">Harvard</option></select></label>
    </WizardSection>
  );
}

function ReviewStep({
  c,
  draft,
  labels,
  saved,
  submitting,
  progress,
  receipt,
  onSubmit,
  onRestart,
}: {
  c: Copy;
  draft: WizardData;
  labels: Record<string, string>;
  saved: boolean;
  submitting: boolean;
  progress: ReportProgress | null;
  receipt: SubmissionReceipt | null;
  onSubmit: () => Promise<void>;
  onRestart: () => void;
}) {
  if (saved) {
    return (
      <section className="lh-saved-request" aria-labelledby="saved-request-title">
        <span className="lh-success-seal"><Check aria-hidden="true" size={28} /></span>
        <p className="section-index">
          06{receipt?.kind === "browser" ? ` · ${receipt.report.reportSha256.slice(0, 12)}` : ""}
        </p>
        <h2 id="saved-request-title">{c.savedTitle}</h2>
        <p>
          {receipt?.kind === "browser"
            ? c.preparedOne
            : receipt?.kind === "watch"
              ? c.queuedRun
              : draft.mode === "watch" ? c.savedWatch : c.savedOne}
        </p>

        {receipt?.kind === "browser" && (
          <div className="lh-preparation-receipt" aria-label={c.preparationReceipt}>
            <h3>{c.preparationReceipt}</h3>
            <dl className="lh-preparation-stats">
              <div><dt>{c.fetched}</dt><dd>{receipt.report.records.length}</dd></div>
              <div><dt>{c.synthesis}</dt><dd>{receipt.report.synthesis}</dd></div>
              <div><dt>{c.partialSources}</dt><dd>{receipt.report.sourceFailures.length}</dd></div>
              <div><dt>{c.sourceState}</dt><dd>{c.storedInBrowser}</dd></div>
            </dl>
            <details className="lh-receipt-details">
              <summary>{c.artifactIntegrity}</summary>
              <p className="lh-receipt-sha"><b>{c.resultSha}</b><code>{receipt.report.reportSha256}</code></p>
              <p className="lh-receipt-sha"><b>{c.preparationSha}</b><code>{receipt.report.retrievalSha256}</code></p>
              {receipt.report.sourceFailures.length > 0 ? (
                <div className="lh-partial-errors"><b>{c.partialSources}</b><ul>{receipt.report.sourceFailures.map(({ source, errorCode }) => <li key={`${source}-${errorCode}`}>{source} · {errorCode}</li>)}</ul></div>
              ) : <p className="lh-complete-sources">{c.completeSources}</p>}
            </details>
            <div className="lh-inline-actions">
              <button className="button button-primary" type="button" onClick={() => downloadBrowserMarkdown(receipt.report)}>
                <FileCheck2 aria-hidden="true" size={17} /> {c.downloadMarkdown}
              </button>
              <button className="button button-secondary" type="button" onClick={() => downloadReportFile(receipt.report, "tex")}>
                <FileCheck2 aria-hidden="true" size={17} /> Download LaTeX
              </button>
            </div>
          </div>
        )}

        {receipt?.kind === "watch" && (
          <>
            <dl className="lh-watch-receipt" aria-label={c.queuedRun}>
              <div><dt>{c.watchIdentifier}</dt><dd><code>{receipt.watchId}</code></dd></div>
              <div><dt>{c.runIdentifier}</dt><dd><code>{receipt.runId}</code></dd></div>
              <div><dt>{c.runStatus}</dt><dd>{receipt.runStatus}</dd></div>
            </dl>
            {receipt.browserReport && <button className="button button-primary" type="button" onClick={() => downloadBrowserMarkdown(receipt.browserReport!)}><FileCheck2 aria-hidden="true" size={17} /> {c.downloadMarkdown}</button>}
          </>
        )}

        <button className="button button-secondary" type="button" onClick={onRestart}>{c.newRequest}</button>
      </section>
    );
  }
  return (
    <WizardSection title={c.reviewTitle} help={c.reviewHelp} index="06">
      <dl className="lh-review-contract">
        <div><dt>{c.inquiry}</dt><dd><b>{draft.topic}</b>{draft.scope && <span>{draft.scope}</span>}{draft.exclusions && <span>− {draft.exclusions}</span>}</dd></div>
        <div><dt>{c.timing}</dt><dd>{draft.fromDate} → {draft.toDate}<span>{draft.mode === "watch" ? `${draft.frequency} · ${draft.deliveryTime} · ${draft.timezone}` : c.oneOff}</span></dd></div>
        <div><dt>{c.audience}</dt><dd>{labels.expertise}<span>{labels.disciplines} · {labels.workTypes}</span></dd></div>
        <div><dt>{c.accessReview}</dt><dd>{draft.accessPolicy === "open-only" ? c.openOnly : c.includeAbstracts}<span>{labels.sources}</span></dd></div>
        <div><dt>{c.rankingReview}</dt><dd>{labels.ranking}<span>{c.rankingTruth}</span></dd></div>
        <div><dt>{c.deliverables}</dt><dd>{c[draft.depth]}<span>{draft.citation} · {draft.recommendations ? c.recommendations : "—"}</span></dd></div>
      </dl>
      <p className="lh-local-caveat">{c.localCaveat}</p>
      {submitting && progress && (
        <p className="lh-report-progress" role="status" aria-live="polite">
          {progress.label}{progress.etaSeconds !== undefined ? ` — about ${progress.etaSeconds}s remaining` : ""}
        </p>
      )}
      <button className="button button-primary lh-submit-request" type="button" onClick={() => void onSubmit()} disabled={submitting}>
        <FileCheck2 aria-hidden="true" size={18} />
        {submitting ? c.preparing : draft.mode === "watch" ? c.submitWatch : c.submitOne}
      </button>
    </WizardSection>
  );
}

function WizardSection({ title, help, index, children }: { title: string; help?: string; index: string; children: React.ReactNode }) {
  return <section className="lh-wizard-section" aria-labelledby={`wizard-step-${index}`}><p className="section-index">{index}</p><h2 id={`wizard-step-${index}`}>{title}</h2>{help && <p className="lh-section-help">{help}</p>}{children}</section>;
}

function OptionCard({ checked, name, value, label, help, onChange }: { checked: boolean; name: string; value: string; label: string; help?: string; onChange: () => void }) {
  return <label className={`lh-option-card${checked ? " is-selected" : ""}`}><input type="radio" name={name} value={value} checked={checked} onChange={onChange} /><span className="lh-option-mark" aria-hidden="true">{checked ? "■" : "□"}</span><span><b>{label}</b>{help && <small>{help}</small>}</span></label>;
}

function CheckboxGroup({ legend, help, options, values, onChange }: { legend: string; help?: string; options: readonly (readonly [string, string])[]; values: string[]; onChange: (value: string) => void }) {
  return (
    <fieldset className="lh-fieldset">
      <legend>{legend}</legend>
      {help && <p className="lh-field-help">{help}</p>}
      <div className="lh-check-grid">
        {options.map((option) => <label className="lh-checkbox" key={option[0]}><input type="checkbox" checked={values.includes(option[0])} onChange={() => onChange(option[0])} /><span>{optionLabel(option)}</span></label>)}
      </div>
    </fieldset>
  );
}
