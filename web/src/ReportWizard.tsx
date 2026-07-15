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

import { useI18n } from "./i18n";
import { nativeApi } from "./native";

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
  recommendations: boolean;
  citation: string;
  outputs: string[];
}

export interface GeneratedReportReceipt {
  report_id: string;
  report_document_sha256: string;
  preparation_sha256: string;
  specification_sha256: string;
  result_sha256: string;
  partial: boolean;
  synthesis_status: string;
  requested_citation_style: string;
  applied_citation_style: string;
  work_count: number;
  claim_count: number;
  abstract_evidence_count: number;
  full_text_evidence_count: number;
  artifacts: {
    output_format: string;
    artifact_id: string;
    artifact_sha256: string;
    size: number;
    manifest_id: string | null;
    manifest_sha256: string | null;
  }[];
  source_errors: { source: string; code: string; retryable: boolean }[];
  format_errors: string[];
}

export type SubmissionReceipt =
  | { kind: "generated"; report: GeneratedReportReceipt }
  | { kind: "watch"; watchId: string; runId: string; runStatus: string }
  | { kind: "local" };

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
    accessPolicy: preferences.openOnly === false ? "include-abstracts" : "open-only",
    sources: preferredSources.length ? preferredSources : ["openalex", "crossref", "datacite"],
    ranking: ["recent-attention", "normalized-influence"],
    depth: "standard",
    recommendations: true,
    citation: preferences.citation?.trim() || "apa-7",
    outputs: ["markdown"],
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
      outputs: Array.isArray(parsed.outputs) ? parsed.outputs : defaults.outputs,
    };
  } catch {
    return defaults;
  }
}

const steps = ["intent", "coverage", "reader", "evidence", "output", "review"] as const;

const copy = {
  en: {
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
    watch: "Recurring watch",
    watchHelp: "Repeat the same bounded search on a schedule.",
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
    schedule: "Delivery schedule",
    frequency: "Frequency",
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    time: "Local time",
    timezone: "Time zone (IANA)",
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
    depth: "Report depth",
    brief: "Brief digest",
    standard: "Standard review",
    deep: "Deep review",
    recommendations: "Include bounded reading recommendations",
    recommendationsHelp: "Recommendations cite their evidence and explain why the work may merit closer reading.",
    citation: "Reference style",
    formats: "Output formats",
    latexHelp: "LaTeX requests render to a monochrome A4 research report with references and a SHA-256 manifest.",
    reviewTitle: "Review the retrieval contract",
    reviewHelp: "These choices become an immutable request revision. Later edits create a new revision so prior reports remain reproducible.",
    inquiry: "Inquiry",
    timing: "Timing",
    audience: "Audience",
    accessReview: "Access",
    rankingReview: "Ranking",
    deliverables: "Deliverables",
    submitOne: "Generate evidence-locked report",
    submitWatch: "Save recurring watch",
    savedTitle: "Request saved",
    preparedOne: "The bounded search completed and its evidence-locked report artifacts were stored in the local vault.",
    savedOne: "The one-off request was stored as a local alpha draft and is ready for the retrieval service.",
    savedWatch: "The recurring watch was stored as a local alpha draft and is ready for the scheduler.",
    newRequest: "Start another request",
    localCaveat: "Alpha interface: this screen persists the validated request locally until the packaged app supplies its authenticated local API session.",
    preparing: "Preparing…",
    submitFailed: "The authenticated local service could not prepare this request. The draft remains saved for review.",
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
    queuedRun: "First scheduled run queued",
    watchIdentifier: "Watch identifier",
    runIdentifier: "Run identifier",
    runStatus: "Run status",
  },
  tr: {
    eyebrow: "Yönlendirmeli literatür isteği",
    title: "Sınırları açık bir rapor oluşturun",
    lede: "Litehouse; taramayı, sıralamayı, kanıt erişimini ve son raporun biçimini değiştiren soruları sorar.",
    back: "Bugün'e dön",
    draft: "Taslak bu cihazda kaydedildi",
    steps: ["Amaç", "Kapsam", "Okuyucu", "Kanıt", "Çıktı", "Kontrol"],
    previous: "Önceki",
    next: "Devam",
    required: "Devam etmeden önce gerekli seçimleri tamamlayın.",
    intentTitle: "Litehouse neyi araştırmalı?",
    intentHelp: "Kavramı kendi terimlerinizle yazın. Kapsam ve dışlamalar geniş taramaların sapmasını önler.",
    mode: "İstek türü",
    oneOff: "Tek seferlik rapor",
    oneOffHelp: "Seçilen yayın aralığını bir kez tarar.",
    watch: "Yinelenen izleme",
    watchHelp: "Aynı sınırlandırılmış taramayı bir programa göre tekrarlar.",
    topic: "Konu veya araştırma sorusu",
    topicPlaceholder: "örn. Sanatçılar belgesel pratikte makine görüşünü nasıl kullandı?",
    scope: "Dahil edilecek kapsam ve kavramlar",
    scopePlaceholder: "Topluluklar, yerler, yöntemler, kuramlar, ortamlar veya komşu terimler…",
    exclusions: "Dışlamalar",
    exclusionsPlaceholder: "Dışarıda bırakılacak terimler, çalışma tasarımları, topluluklar veya yorumlar…",
    coverageTitle: "Yayın aralığını ve değişkenlik kaynaklarını belirleyin",
    interval: "Yayın aralığı",
    from: "Başlangıç",
    to: "Bitiş",
    schedule: "Teslim programı",
    frequency: "Sıklık",
    daily: "Günlük",
    weekly: "Haftalık",
    monthly: "Aylık",
    time: "Yerel saat",
    timezone: "Saat dilimi (IANA)",
    languages: "Yayın dilleri",
    languageHelp: "İngilizce varsayılan olarak seçilidir. Çeviri veya çok dilli çalışmalar kapsama giriyorsa ek diller seçin.",
    disciplines: "Araştırma alanları",
    disciplinesHelp: "Kaynakları ve çalışma türleri taranacak tüm alanları seçin.",
    workTypes: "Çalışma türleri",
    readerTitle: "Raporu okuyucuya göre ayarlayın",
    expertise: "Sıralı eğitim ve uzmanlık",
    expertiseHelp: "İlk seçim ana okuma düzeyini belirler. Karma geçmişleri ifade etmek için listeyi sıralayın.",
    prior: "Ön bilgi ve terminoloji",
    priorPlaceholder: "Raporun bilindiğini varsayabileceği yöntemler, kuramlar, organizmalar, dönemler, yazılımlar veya kavramlar…",
    moveUp: "Yukarı taşı",
    moveDown: "Aşağı taşı",
    evidenceTitle: "Erişim ve sıralama kurallarını seçin",
    access: "Erişim politikası",
    openOnly: "Yalnızca açık tam metin",
    openOnlyHelp: "Tam metni yalnızca erişim ve yeniden kullanım koşulları doğrulanabiliyorsa alır ve okur.",
    includeAbstracts: "Ücretli kayıtları üstveri ve özet olarak dahil et",
    includeAbstractsHelp: "Açık onay gerektirir. Litehouse mevcut özeti özetleyebilir, kaydı yalnızca-özet olarak işaretler ve ücretli tam metni edinmeye çalışmaz.",
    noBypass: "Litehouse kimlik doğrulamayı, ödeme duvarlarını, erişim denetimlerini veya yayıncı koşullarını aşmaz.",
    sources: "Akademik kaynaklar",
    ranking: "Etki sıralama amacı",
    rankingHelp: "Sıralama okuma düzenini değiştirir; bilimsel gerçeği değil. Her sinyal görünür kalır ve kanıt gücünden ayrı tutulur.",
    rankingTruth: "Atıf, yayın yeri veya ilgi sinyali bir iddianın doğruluğunun kanıtı sayılmaz.",
    outputTitle: "Raporu biçimlendirin",
    depth: "Rapor derinliği",
    brief: "Kısa özet",
    standard: "Standart inceleme",
    deep: "Derin inceleme",
    recommendations: "Sınırlandırılmış okuma önerileri ekle",
    recommendationsHelp: "Öneriler kanıtını gösterir ve çalışmanın neden daha yakından okunabileceğini açıklar.",
    citation: "Kaynak gösterme stili",
    formats: "Çıktı biçimleri",
    latexHelp: "LaTeX istekleri kaynakçalı, tek renk A4 araştırma raporu ve SHA-256 manifesti oluşturur.",
    reviewTitle: "Tarama sözleşmesini kontrol edin",
    reviewHelp: "Bu seçimler değişmez bir istek revizyonuna dönüşür. Sonraki düzenlemeler yeni revizyon oluşturur; eski raporlar tekrarlanabilir kalır.",
    inquiry: "Araştırma",
    timing: "Zamanlama",
    audience: "Okuyucu",
    accessReview: "Erişim",
    rankingReview: "Sıralama",
    deliverables: "Çıktılar",
    submitOne: "Kanıta kilitli raporu oluştur",
    submitWatch: "Yinelenen izlemeyi kaydet",
    savedTitle: "İstek kaydedildi",
    preparedOne: "Sınırlandırılmış tarama tamamlandı; kanıta kilitli rapor eserleri yerel kasaya kaydedildi.",
    savedOne: "Tek seferlik istek yerel alfa taslağı olarak saklandı ve tarama hizmeti için hazır.",
    savedWatch: "Yinelenen izleme yerel alfa taslağı olarak saklandı ve zamanlayıcı için hazır.",
    newRequest: "Yeni istek başlat",
    localCaveat: "Alfa arayüzü: paketlenmiş uygulama kimliği doğrulanmış yerel API oturumunu sağlayana kadar bu ekran doğrulanmış isteği yerel olarak saklar.",
    preparing: "Hazırlanıyor…",
    submitFailed: "Kimliği doğrulanmış yerel hizmet bu isteği hazırlayamadı. Taslak inceleme için kayıtlı kaldı.",
    preparationReceipt: "Rapor makbuzu",
    preparationSha: "Hazırlama SHA-256",
    resultSha: "Sonuç SHA-256",
    fetched: "Çalışmalar",
    included: "İddialar",
    returned: "Kanıt alıntıları",
    sourceState: "Oluşturulan eserler",
    synthesis: "Sentez",
    appliedCitation: "Uygulanan atıf biçimi",
    artifactIntegrity: "Eser ve bildirim bütünlüğü",
    formatIssues: "Oluşturulamayan istenen biçimler",
    partialSources: "Kısmi kaynak hataları",
    completeSources: "Seçili tüm kaynaklar yanıt verdi",
    firstResults: "Kasa eserleri",
    queuedRun: "İlk programlı çalışma sıraya alındı",
    watchIdentifier: "İzleme tanımlayıcısı",
    runIdentifier: "Çalışma tanımlayıcısı",
    runStatus: "Çalışma durumu",
  },
} as const;

const optionCopy = {
  languages: [
    ["en", "English", "İngilizce"],
    ["tr", "Turkish", "Türkçe"],
    ["de", "German", "Almanca"],
    ["fr", "French", "Fransızca"],
    ["es", "Spanish", "İspanyolca"],
    ["other", "Other", "Diğer"],
  ],
  disciplines: [
    ["humanities", "Humanities", "Beşeri bilimler"],
    ["arts", "Arts and design", "Sanat ve tasarım"],
    ["social-sciences", "Social sciences", "Sosyal bilimler"],
    ["natural-sciences", "Natural sciences", "Doğa bilimleri"],
    ["life-sciences", "Life sciences and health", "Yaşam bilimleri ve sağlık"],
    ["technology", "Engineering and technology", "Mühendislik ve teknoloji"],
    ["law-policy", "Law and policy", "Hukuk ve politika"],
    ["interdisciplinary", "Interdisciplinary", "Disiplinlerarası"],
  ],
  workTypes: [
    ["journal-article", "Journal articles", "Dergi makaleleri"],
    ["book-chapter", "Books and chapters", "Kitaplar ve bölümler"],
    ["conference", "Conference papers", "Konferans bildirileri"],
    ["preprint", "Preprints", "Ön baskılar"],
    ["dataset", "Datasets", "Veri kümeleri"],
    ["thesis", "Theses", "Tezler"],
    ["report", "Reports and standards", "Raporlar ve standartlar"],
    ["creative-work", "Creative works and catalogues", "Yaratıcı çalışmalar ve kataloglar"],
  ],
  expertise: [
    ["secondary", "Secondary education", "Ortaöğretim"],
    ["undergraduate", "Undergraduate", "Lisans"],
    ["masters", "Master's", "Yüksek lisans"],
    ["doctoral", "Doctoral", "Doktora"],
    ["postdoctoral", "Postdoctoral", "Doktora sonrası"],
    ["faculty", "Faculty", "Öğretim üyesi"],
    ["professional", "Professional practice", "Mesleki uygulama"],
    ["independent", "Independent researcher", "Bağımsız araştırmacı"],
  ],
  sources: [
    ["openalex", "OpenAlex", "OpenAlex"],
    ["crossref", "Crossref", "Crossref"],
    ["datacite", "DataCite", "DataCite"],
    ["europe-pmc", "Europe PMC", "Europe PMC"],
    ["semantic-scholar", "Semantic Scholar", "Semantic Scholar"],
    ["library-of-congress", "Library of Congress", "Library of Congress"],
  ],
  ranking: [
    ["recent-attention", "Recent scholarly attention", "Yakın dönem akademik ilgisi"],
    ["normalized-influence", "Field- and age-normalized influence", "Alan ve yaşa göre normalleştirilmiş etki"],
    ["seminal", "Seminal or field-forming work", "Kurucu veya alanı biçimlendiren çalışmalar"],
    ["methodological", "Methodological relevance", "Yöntemsel ilgililik"],
    ["open-coverage", "Broad and open coverage", "Geniş ve açık kapsam"],
  ],
  outputs: [
    ["markdown", "Markdown (.md)", "Markdown (.md)"],
    ["plain", "Plain text (.txt)", "Düz metin (.txt)"],
    ["latex", "Rendered LaTeX (.pdf + .tex)", "İşlenmiş LaTeX (.pdf + .tex)"],
  ],
} as const;

function optionLabel(option: readonly [string, string, string], locale: "en" | "tr") {
  return locale === "en" ? option[1] : option[2];
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
  const outputMap: Record<string, string> = {
    markdown: "markdown",
    plain: "plain_text",
    latex: "latex_pdf",
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
    output_formats: draft.outputs.map((value) => outputMap[value]),
  };
}

function requestSucceeded(status: number) {
  return status >= 200 && status < 300;
}

/**
 * This is called only after the user confirms the immutable retrieval contract.
 * Browser development has an intentional local-only fallback; packaged builds
 * must use the authenticated native bridge and never silently downgrade on error.
 */
export async function executeGuidedRequest(
  draft: WizardData,
): Promise<SubmissionReceipt> {
  if (!nativeApi.available) return { kind: "local" };

  const specification = buildApiSpecification(draft);
  if (draft.mode === "one-off") {
    const response = await nativeApi.request<GeneratedReportReceipt>(
      "POST",
      "/v1/reports/generate",
      { specification, max_results: 25 },
    );
    if (!requestSucceeded(response.status)) {
      throw new Error("Report generation was not accepted.");
    }
    return { kind: "generated", report: response.body };
  }

  const created = await nativeApi.request<{ id: string }>("POST", "/v1/watches", {
    name: draft.topic.trim().slice(0, 160),
    specification,
    enabled: true,
  });
  if (!requestSucceeded(created.status) || !created.body.id) {
    throw new Error("Watch creation was not accepted.");
  }
  const watchId = created.body.id;
  const queued = await nativeApi.request<{
    run: { id: string; status: string };
  }>("POST", `/v1/watches/${encodeURIComponent(watchId)}/runs`, {});
  if (!requestSucceeded(queued.status) || !queued.body.run?.id) {
    throw new Error("The first watch run was not queued.");
  }
  return {
    kind: "watch",
    watchId,
    runId: queued.body.run.id,
    runStatus: queued.body.run.status,
  };
}

export function ReportWizardPage() {
  const { locale } = useI18n();
  const c = copy[locale];
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardData>(readDraft);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem("litehouse.report-draft.v1", JSON.stringify(draft));
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
      return Boolean(
        draft.fromDate &&
          draft.toDate &&
          draft.fromDate <= draft.toDate &&
          draft.languages.length &&
          (draft.mode === "one-off" || (draft.deliveryTime && draft.timezone.trim())),
      );
    }
    if (step === 2) return Boolean(draft.disciplines.length && draft.workTypes.length && draft.expertise.length);
    if (step === 3) return Boolean(draft.sources.length && draft.ranking.length);
    if (step === 4) return draft.outputs.length > 0;
    return true;
  }

  function next() {
    if (!validCurrentStep()) {
      setError(c.required);
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
      const nextReceipt = await executeGuidedRequest(draft);
      const stored = {
        ...draft,
        savedAt: new Date().toISOString(),
        revision: 1,
        submission: nextReceipt,
      };
      window.localStorage.setItem("litehouse.saved-request.v1", JSON.stringify(stored));
      setReceipt(nextReceipt);
      setSaved(true);
    } catch {
      setError(c.submitFailed);
      window.setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedLabels = useMemo(() => {
    const labels = (group: keyof typeof optionCopy, values: string[]) =>
      optionCopy[group]
        .filter((option) => values.includes(option[0]))
        .map((option) => optionLabel(option, locale))
        .join(", ");
    return {
      disciplines: labels("disciplines", draft.disciplines),
      workTypes: labels("workTypes", draft.workTypes),
      expertise: labels("expertise", draft.expertise),
      sources: labels("sources", draft.sources),
      ranking: labels("ranking", draft.ranking),
      outputs: labels("outputs", draft.outputs),
    };
  }, [draft, locale]);

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
        <nav className="lh-step-progress" aria-label={locale === "en" ? "Report request progress" : "Rapor isteği ilerlemesi"}>
          <span>{locale === "en" ? `Step ${step + 1} of ${steps.length}` : `${steps.length} adımın ${step + 1}. adımı`}</span>
          <strong aria-current="step">{c.steps[step]}</strong>
          <progress value={step + 1} max={steps.length} aria-label={locale === "en" ? "Report request completion" : "Rapor isteği tamamlanma durumu"} />
        </nav>

        <form className="lh-wizard-form" onSubmit={(event) => event.preventDefault()}>
          {step === 0 && <IntentStep c={c} draft={draft} update={update} />}
          {step === 1 && <CoverageStep c={c} locale={locale} draft={draft} update={update} />}
          {step === 2 && <ReaderStep c={c} locale={locale} draft={draft} update={update} />}
          {step === 3 && <EvidenceStep c={c} locale={locale} draft={draft} update={update} />}
          {step === 4 && <OutputStep c={c} locale={locale} draft={draft} update={update} />}
          {step === 5 && (
            <ReviewStep
              c={c}
              draft={draft}
              labels={selectedLabels}
              saved={saved}
              submitting={submitting}
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

type Copy = (typeof copy)["en"] | (typeof copy)["tr"];
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

function CoverageStep({ c, locale, draft, update }: { c: Copy; locale: "en" | "tr"; draft: WizardData; update: Update }) {
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
      <CheckboxGroup legend={c.languages} help={c.languageHelp} options={optionCopy.languages} values={draft.languages} locale={locale} onChange={(value) => update("languages", toggleValue(draft.languages, value))} />
    </WizardSection>
  );
}

function ReaderStep({ c, locale, draft, update }: { c: Copy; locale: "en" | "tr"; draft: WizardData; update: Update }) {
  function move(index: number, offset: -1 | 1) {
    const next = [...draft.expertise];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update("expertise", next);
  }
  return (
    <WizardSection title={c.readerTitle} index="03">
      <CheckboxGroup legend={c.disciplines} help={c.disciplinesHelp} options={optionCopy.disciplines} values={draft.disciplines} locale={locale} onChange={(value) => update("disciplines", toggleValue(draft.disciplines, value))} />
      <CheckboxGroup legend={c.workTypes} options={optionCopy.workTypes} values={draft.workTypes} locale={locale} onChange={(value) => update("workTypes", toggleValue(draft.workTypes, value))} />
      <fieldset className="lh-fieldset">
        <legend>{c.expertise}</legend>
        <p className="lh-field-help">{c.expertiseHelp}</p>
        <div className="lh-expertise-grid">
          <div className="lh-check-grid">
            {optionCopy.expertise.map((option) => (
              <label className="lh-checkbox" key={option[0]}>
                <input type="checkbox" checked={draft.expertise.includes(option[0])} onChange={() => update("expertise", toggleValue(draft.expertise, option[0]))} />
                <span>{optionLabel(option, locale)}</span>
              </label>
            ))}
          </div>
          <ol className="lh-order-list" aria-label={c.expertise}>
            {draft.expertise.map((value, index) => {
              const option = optionCopy.expertise.find((item) => item[0] === value);
              return (
                <li key={value}>
                  <span><b>{index + 1}</b>{option ? optionLabel(option, locale) : value}</span>
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

function EvidenceStep({ c, locale, draft, update }: { c: Copy; locale: "en" | "tr"; draft: WizardData; update: Update }) {
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
      <CheckboxGroup legend={c.sources} options={optionCopy.sources} values={draft.sources} locale={locale} onChange={(value) => update("sources", toggleValue(draft.sources, value))} />
      <CheckboxGroup legend={c.ranking} help={c.rankingHelp} options={optionCopy.ranking} values={draft.ranking} locale={locale} onChange={(value) => update("ranking", toggleValue(draft.ranking, value))} />
      <p className="lh-ranking-note"><Info aria-hidden="true" size={18} /> {c.rankingTruth}</p>
    </WizardSection>
  );
}

function OutputStep({ c, locale, draft, update }: { c: Copy; locale: "en" | "tr"; draft: WizardData; update: Update }) {
  return (
    <WizardSection title={c.outputTitle} index="05">
      <fieldset className="lh-fieldset">
        <legend>{c.depth}</legend>
        <div className="lh-card-choices three-column">
          {(["brief", "standard", "deep"] as const).map((value) => <OptionCard key={value} checked={draft.depth === value} name="depth" value={value} label={c[value]} onChange={() => update("depth", value)} />)}
        </div>
      </fieldset>
      <label className="lh-checkbox lh-feature-check"><input type="checkbox" checked={draft.recommendations} onChange={(event) => update("recommendations", event.target.checked)} /><span><b>{c.recommendations}</b><small>{c.recommendationsHelp}</small></span></label>
      <label className="lh-field lh-select-field"><span>{c.citation}</span><select value={draft.citation} onChange={(event) => update("citation", event.target.value)}><option value="apa-7">APA 7</option><option value="ieee">IEEE</option><option value="chicago-author-date">Chicago author–date</option><option value="mla-9">MLA 9</option><option value="vancouver">Vancouver</option><option value="harvard-cite-them-right">Harvard</option></select></label>
      <CheckboxGroup legend={c.formats} options={optionCopy.outputs} values={draft.outputs} locale={locale} onChange={(value) => update("outputs", toggleValue(draft.outputs, value))} />
      {draft.outputs.includes("latex") && <p className="lh-safety-note"><FileCheck2 aria-hidden="true" size={18} /> {c.latexHelp}</p>}
    </WizardSection>
  );
}

function ReviewStep({
  c,
  draft,
  labels,
  saved,
  submitting,
  receipt,
  onSubmit,
  onRestart,
}: {
  c: Copy;
  draft: WizardData;
  labels: Record<string, string>;
  saved: boolean;
  submitting: boolean;
  receipt: SubmissionReceipt | null;
  onSubmit: () => Promise<void>;
  onRestart: () => void;
}) {
  if (saved) {
    return (
      <section className="lh-saved-request" aria-labelledby="saved-request-title">
        <span className="lh-success-seal"><Check aria-hidden="true" size={28} /></span>
        <p className="section-index">
          06{receipt?.kind === "generated" ? ` · ${receipt.report.result_sha256.slice(0, 12)}` : ""}
        </p>
        <h2 id="saved-request-title">{c.savedTitle}</h2>
        <p>
          {receipt?.kind === "generated"
            ? c.preparedOne
            : receipt?.kind === "watch"
              ? c.queuedRun
              : draft.mode === "watch" ? c.savedWatch : c.savedOne}
        </p>

        {receipt?.kind === "generated" && (
          <div className="lh-preparation-receipt" aria-label={c.preparationReceipt}>
            <h3>{c.preparationReceipt}</h3>
            <dl className="lh-preparation-stats">
              <div><dt>{c.fetched}</dt><dd>{receipt.report.work_count}</dd></div>
              <div><dt>{c.included}</dt><dd>{receipt.report.claim_count}</dd></div>
              <div><dt>{c.returned}</dt><dd>{receipt.report.abstract_evidence_count + receipt.report.full_text_evidence_count}</dd></div>
              <div><dt>{c.sourceState}</dt><dd>{receipt.report.artifacts.length}</dd></div>
            </dl>
            <p className="lh-receipt-sources"><b>{c.synthesis}</b><span>{receipt.report.synthesis_status}</span></p>
            <p className="lh-receipt-sources"><b>{c.appliedCitation}</b><span>{receipt.report.applied_citation_style}</span></p>
            <details className="lh-receipt-details">
              <summary>{c.artifactIntegrity}</summary>
              <p className="lh-receipt-sha"><b>{c.resultSha}</b><code>{receipt.report.result_sha256}</code></p>
              <p className="lh-receipt-sha"><b>{c.preparationSha}</b><code>{receipt.report.preparation_sha256}</code></p>
              {receipt.report.source_errors.length > 0 ? (
                <div className="lh-partial-errors">
                  <b>{c.partialSources}</b>
                  <ul>{receipt.report.source_errors.map((sourceError) => <li key={`${sourceError.source}-${sourceError.code}`}>{sourceError.source} · {sourceError.code}</li>)}</ul>
                </div>
              ) : <p className="lh-complete-sources">{c.completeSources}</p>}
              {receipt.report.format_errors.length > 0 && (
                <div className="lh-partial-errors"><b>{c.formatIssues}</b><ul>{receipt.report.format_errors.map((code) => <li key={code}>{code}</li>)}</ul></div>
              )}
              <p className="lh-ranking-note"><Info aria-hidden="true" size={18} /> {c.rankingTruth}</p>
              {receipt.report.artifacts.length > 0 && (
                <div className="lh-first-results">
                  <b>{c.firstResults}</b>
                  <ol>{receipt.report.artifacts.map((artifact) => (
                    <li key={artifact.artifact_id}>
                      <span>{artifact.output_format} · {(artifact.size / 1024).toFixed(1)} KiB</span>
                      <small>{c.artifactIntegrity}: {artifact.artifact_sha256.slice(0, 16)}…{artifact.manifest_sha256 ? ` / ${artifact.manifest_sha256.slice(0, 16)}…` : ""}</small>
                    </li>
                  ))}</ol>
                </div>
              )}
            </details>
          </div>
        )}

        {receipt?.kind === "watch" && (
          <dl className="lh-watch-receipt" aria-label={c.queuedRun}>
            <div><dt>{c.watchIdentifier}</dt><dd><code>{receipt.watchId}</code></dd></div>
            <div><dt>{c.runIdentifier}</dt><dd><code>{receipt.runId}</code></dd></div>
            <div><dt>{c.runStatus}</dt><dd>{receipt.runStatus}</dd></div>
          </dl>
        )}

        {receipt?.kind === "local" && <p className="lh-local-caveat">{c.localCaveat}</p>}
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
        <div><dt>{c.deliverables}</dt><dd>{labels.outputs}<span>{draft.citation} · {c[draft.depth]} · {draft.recommendations ? c.recommendations : "—"}</span></dd></div>
      </dl>
      {!nativeApi.available && <p className="lh-local-caveat">{c.localCaveat}</p>}
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

function CheckboxGroup({ legend, help, options, values, locale, onChange }: { legend: string; help?: string; options: readonly (readonly [string, string, string])[]; values: string[]; locale: "en" | "tr"; onChange: (value: string) => void }) {
  return (
    <fieldset className="lh-fieldset">
      <legend>{legend}</legend>
      {help && <p className="lh-field-help">{help}</p>}
      <div className="lh-check-grid">
        {options.map((option) => <label className="lh-checkbox" key={option[0]}><input type="checkbox" checked={values.includes(option[0])} onChange={() => onChange(option[0])} /><span>{optionLabel(option, locale)}</span></label>)}
      </div>
    </fieldset>
  );
}
