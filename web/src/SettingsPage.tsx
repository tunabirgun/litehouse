import {
  BellRing,
  BookOpenText,
  BrainCircuit,
  Check,
  Database,
  DownloadCloud,
  ExternalLink,
  FileOutput,
  Gauge,
  Keyboard,
  LockKeyhole,
  Palette,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useI18n } from "./i18n";
import {
  bindingFromKeyboardEvent,
  formatShortcut,
  useShortcuts,
} from "./shortcuts";
import { RemoteProviderPanel } from "./providers/RemoteProviderPanel";
import { browserStorageStatus, listBrowserReports, type BrowserStorageStatus } from "./browser/vault";
import { BrowserModelPanel } from "./llm/BrowserModelPanel";
import { useAppearance, type ThemePreference, type MotionPreference } from "./appearance";
import "./settings.css";

type SettingsSection =
  | "profile"
  | "watches"
  | "sources"
  | "models"
  | "providers"
  | "citation"
  | "appearance"
  | "storage"
  | "updates"
  | "diagnostics"
  | "shortcuts";

interface LocalSettings {
  priorKnowledge: string;
  expertise: string;
  defaultTimezone: string;
  sources: Record<string, boolean>;
  openOnly: boolean;
  provider: "integrated" | "local-compatible" | "openai" | "anthropic" | "gemini" | "custom";
  modelTier: "minimum" | "balanced" | "quality";
  customEndpoint: string;
  citation: string;
  verifyOnOpen: boolean;
  encryptSecrets: boolean;
  encryptNotes: boolean;
}

interface LocalModelRecommendationReceipt {
  selected_tier: "minimum" | "balanced" | "quality";
  options: {
    tier: "minimum" | "balanced" | "quality";
    system_recommended: boolean;
    installable: boolean;
    quantization: string;
    estimated_working_set_bytes: number;
    context_tokens: number;
    preferred_backend: string;
    reasons: string[];
    model: {
      model_id: string;
      repository_id: string;
      revision: string;
      filename: string;
      size: number;
      sha256: string;
      license_spdx: string;
      publisher: string;
    };
  }[];
  runtime: {
    release_tag: string;
    commit: string;
    archive_filename: string;
    archive_size: number;
    archive_sha256: string;
    license_spdx: string;
    operating_system: string;
    architecture: string;
    available_backends: string[];
  };
}

interface LocalModelInstallReceipt {
  job_id: string;
  state: "queued" | "installing_model" | "installing_runtime" | "verifying" | "cancelling" | "ready" | "cancelled" | "failed";
  tier: "minimum" | "balanced" | "quality";
  model_sha256: string;
  runtime_sha256: string;
  downloaded_bytes: number;
  total_bytes: number;
  progress_fraction: number;
  error_code: string | null;
  retryable: boolean;
  model_receipt: { sha256: string; model_id: string } | null;
  runtime_receipt: { archive_sha256: string; server_sha256: string } | null;
}

interface LocalModelServerReceipt {
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  running: boolean;
  model_id: string | null;
  backend: string | null;
  context_tokens: number | null;
  error_code: string | null;
}

interface LocalModelStatusReceipt {
  status: "ok" | "degraded";
  install: LocalModelInstallReceipt | null;
  server: LocalModelServerReceipt;
}

interface ProviderSettingsReceipt {
  provider: LocalSettings["provider"];
  protocol: string | null;
  base_url: string | null;
  model: string | null;
  display_name: string;
  configuration_valid: boolean;
  credential_state: "not_required" | "stored" | "missing" | "unavailable";
}

interface NativeWatchReceipt {
  id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  active_revision: {
    id: string;
    number: number;
    specification_sha256: string;
    specification: {
      timezone: string;
      schedule:
        | { kind: "interval"; every: number; unit: string; start_at: string }
        | { kind: "cron"; expression: string };
    };
  };
}

interface NativeRunReceipt {
  id: string;
  watch_revision_id: string;
  status: string;
  scheduled_at: string;
  finished_at: string | null;
  result_sha256: string | null;
  artifact_count: number;
  source_error_count: number;
}

const ACTIVE_MODEL_INSTALL_STATES = new Set<LocalModelInstallReceipt["state"]>([
  "queued",
  "installing_model",
  "installing_runtime",
  "verifying",
  "cancelling",
]);

function isLocalModelRecommendationReceipt(value: unknown): value is LocalModelRecommendationReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalModelRecommendationReceipt>;
  if (!Array.isArray(candidate.options) || candidate.options.length !== 3) return false;
  if (!candidate.runtime || typeof candidate.runtime !== "object") return false;
  return candidate.options.every((option) =>
    option
    && ["minimum", "balanced", "quality"].includes(option.tier)
    && typeof option.installable === "boolean"
    && typeof option.model?.model_id === "string"
    && /^[0-9a-f]{64}$/.test(option.model?.sha256 ?? ""),
  ) && /^[0-9a-f]{64}$/.test(candidate.runtime.archive_sha256 ?? "");
}

const PROVIDER_DEFAULTS: Record<
  LocalSettings["provider"],
  { baseUrl: string; model: string; displayName: string }
> = {
  integrated: { baseUrl: "", model: "", displayName: "Integrated llama.cpp" },
  "local-compatible": {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    displayName: "Local compatible endpoint",
  },
  openai: { baseUrl: "https://api.openai.com/v1", model: "", displayName: "OpenAI" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "", displayName: "Anthropic" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "",
    displayName: "Gemini",
  },
  custom: { baseUrl: "https://", model: "", displayName: "Custom compatible provider" },
};

interface TectonicRuntimeReceipt {
  installed: boolean;
  ready: boolean;
  version: string;
  platform_id: string | null;
  emulated: boolean;
  source_url: string | null;
  archive_sha256: string | null;
  binary_sha256: string | null;
  bundle_digest: string;
  reason: string | null;
}

const DEFAULT_SETTINGS: LocalSettings = {
  priorKnowledge: "",
  expertise: "doctoral",
  defaultTimezone: "Europe/Istanbul",
  sources: {
    openalex: true,
    crossref: true,
    datacite: true,
    "europe-pmc": true,
    "semantic-scholar": true,
    "library-of-congress": true,
  },
  openOnly: true,
  provider: "integrated",
  modelTier: "balanced",
  customEndpoint: "http://127.0.0.1:8080/v1",
  citation: "apa-7",
  verifyOnOpen: true,
  encryptSecrets: true,
  encryptNotes: false,
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  "profile",
  "watches",
  "sources",
  "models",
  "providers",
  "citation",
  "appearance",
  "storage",
  "updates",
  "diagnostics",
  "shortcuts",
];

const SETTINGS_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: BookOpenText,
  watches: BellRing,
  sources: Database,
  models: BrainCircuit,
  providers: ServerCog,
  citation: FileOutput,
  appearance: Palette,
  storage: ShieldCheck,
  updates: DownloadCloud,
  diagnostics: Gauge,
  shortcuts: Keyboard,
};

const copy = {
  en: {
    eyebrow: "Application preferences",
    title: "Settings",
    lede: "Local-first defaults remain explicit. Changes on this screen affect future requests; completed reports keep their original revision and hashes.",
    saved: "Preferences saved on this device",
    researchGroup: "Research defaults",
    intelligenceGroup: "Intelligence",
    outputGroup: "Output",
    applicationGroup: "Application",
    advancedGroup: "Advanced",
    navigation: "Settings sections",
    section: {
      profile: "Research defaults",
      watches: "Watches & schedules",
      sources: "Sources & access",
      models: "Local AI",
      providers: "API providers",
      citation: "Exports & reports",
      appearance: "Appearance",
      storage: "Privacy & data",
      updates: "Updates",
      diagnostics: "Diagnostics",
      shortcuts: "Keyboard shortcuts",
    },
    profileHelp: "Set the assumptions Litehouse may make when no request-specific reader profile is supplied.",
    primaryExpertise: "Default education or expertise",
    priorKnowledge: "Default prior-knowledge note",
    priorPlaceholder: "Methods, disciplines, terminology, or practical experience the report may assume…",
    timezone: "Default time zone (IANA)",
    perRequest: "Every guided request can override these defaults without changing your profile.",
    watchesHelp: "Save reusable search definitions for later review. The static web alpha does not run a background scheduler.",
    watchDemo: "Watch definitions and first-run reports stay in this browser. Start future updates manually while Litehouse is open.",
    loadingWatches: "Loading local watches…",
    watchesUnavailable: "Local watches could not be loaded. Demonstration records were not substituted.",
    noWatches: "No recurring watches have been created on this device.",
    active: "Active",
    paused: "Paused",
    nextRun: "Next run",
    noNextRun: "No queued run",
    watchDetails: "Revision and integrity",
    revision: "Revision",
    recentRun: "Most recent run",
    runIssues: "Source errors",
    newWatch: "Create a watch",
    sourceHelp: "Enable source adapters. Each request still chooses a bounded subset appropriate to its field.",
    oaDefault: "Open-access full text by default",
    oaHelp: "When enabled, paid work remains metadata-only unless a request explicitly opts in to available abstracts.",
    noBypass: "Access controls and publisher terms are never bypassed.",
    testSources: "Test enabled sources",
    tested: "Source check queued. Results will show request receipts and sanitized failures.",
    modelHelp: "Litehouse recommends a local model after measuring memory, architecture, and supported acceleration on this device.",
    providerHelp: "Choose where report synthesis runs. External providers receive only the material you explicitly submit to them.",
    provider: "Default provider",
    tier: "Local model tier",
    endpoint: "OpenAI-compatible endpoint",
    secrets: "API secrets are referenced from the operating-system credential store; Litehouse does not write raw keys to this settings file.",
    testProvider: "Test provider",
    providerReady: "Configuration is syntactically valid. A packaged app performs the authenticated endpoint check.",
    recommendation: "Balanced local recommendation",
    recommendationText: "Qwen3 4B · Q4_K_M · about 2.5 GB model file",
    recHelp: "The final recommendation may change after the native capability probe. Downloads require a pinned source URL, license record, and SHA-256 match.",
    measureSystem: "Measure this system",
    systemMeasured: "System capability measurement completed locally.",
    systemUnavailable: "System capabilities could not be measured safely.",
    downloadConsent: "Model and runtime downloads require your confirmation before any network request.",
    installModel: "Install verified local model",
    installingModel: "Installing and verifying local model…",
    cancelModelInstall: "Cancel install",
    cancellingModelInstall: "Cancelling after the current verified operation…",
    localModelReady: "Verified local model and runtime are ready.",
    startModel: "Start local model",
    startingModel: "Starting authenticated local model…",
    stopModel: "Stop local model",
    stoppingModel: "Stopping local model…",
    modelRunning: "Local evidence synthesis is running.",
    modelStopped: "Local evidence synthesis stopped.",
    modelActionError: "The local model action could not be completed safely.",
    modelInstallConfirm: "Download {{model}} and llama.cpp from their pinned sources?\n\nModel SHA-256: {{model_sha}}\nRuntime SHA-256: {{runtime_sha}}\n\nLitehouse will reject every byte that does not match these receipts.",
    installProgress: "Verified install progress",
    verificationReceipt: "Verification receipt",
    advancedProvider: "Advanced provider configuration",
    providerModel: "Provider model identifier",
    saveProvider: "Save provider",
    savingProvider: "Saving provider configuration…",
    providerSaved: "Provider configuration saved.",
    providerError: "The provider configuration could not be saved safely.",
    credential: "API credential",
    credentialStored: "Credential stored in the operating-system credential store",
    credentialMissing: "No credential stored",
    credentialUnavailable: "Operating-system credential store unavailable",
    storeCredential: "Store or replace credential",
    storingCredential: "Storing credential…",
    deleteCredential: "Delete stored credential",
    credentialDeleted: "Stored credential deleted.",
    credentialError: "The credential operation could not be completed safely.",
    browserVaultHelp: "Reports, notes, PDFs, and model caches stay in this browser profile. Litehouse has no account database or application server.",
    browserVault: "Browser-local vault",
    browserVaultPersistent: "Protected from routine storage eviction",
    browserVaultBestEffort: "Best-effort browser storage",
    browserVaultRequest: "Request durable local storage",
    browserVaultUsage: "Origin storage",
    browserVaultReports: "Saved reports",
    browserVaultBackup: "Export vault backup",
    browserVaultEncryption: "Litehouse does not claim application-level encryption for IndexedDB. Protection depends on this browser profile, device login, and disk encryption.",
    browserVaultClear: "Clearing site data in your browser removes this vault and downloaded models. Export a backup first.",
    webUpdateHelp: "The web alpha is delivered from the public, reviewable GitHub source. A new commit-linked site artifact with a SHA-256 manifest is deployed only after the public web verification workflow passes.",
    webUpdateReload: "Reload the web app",
    webUpdateSource: "View source and build history",
    saveBeforeCredential: "Save this provider before storing its credential.",
    min: "Minimum",
    balanced: "Balanced",
    quality: "Quality",
    citeHelp: "Choose the reference style for new reports and inspect the verified offline compiler.",
    citation: "Default reference style",
    attachment: "Export legally reusable attachments when their license is verified",
    duplicate: "Default duplicate rule",
    latexRuntime: "LaTeX compiler",
    latexReady: "Verified offline compiler ready",
    latexNotReady: "The verified compiler is not installed",
    checkCompiler: "Check compiler",
    installCompiler: "Review and install compiler",
    installingCompiler: "Installing and verifying the compiler…",
    compilerInstalled: "The verified LaTeX compiler is installed and passed its offline build probe.",
    compilerError: "The verified LaTeX compiler could not be checked or installed.",
    compilerConfirm: "Install Tectonic {{version}} from the pinned source? Litehouse will verify the archive SHA-256 and TeX bundle before enabling offline report builds.",
    compilerCaveat: "Installation makes one confirmed network request sequence. Report compilation then runs offline, untrusted, and fail-closed.",
    appearanceHelp: "Theme, motion, and interface language have a dedicated preview surface.",
    appearanceLink: "Open appearance settings",
    appearanceSummary: "System theme · full motion · English unless changed locally",
    storageHelp: "The vault stores content-addressed source files, reports, notes, and immutable manifests under a root you control.",
    vaultPath: "Vault root",
    chooseFolder: "Choose folder",
    verifyOpen: "Verify SHA-256 when a saved artifact is opened",
    encryptSecrets: "Keep provider secrets in the OS credential store",
    encryptNotes: "Encrypt notes and annotations at rest",
    encryptNotesHelp: "Optional. Lost encryption credentials cannot be recovered by Litehouse.",
    relocation: "Changing the root requires a copy and full hash verification. The source vault is preserved and is never deleted automatically.",
    backup: "Export vault manifest",
    enforced: "Enforced by Litehouse",
    credentialManaged: "Provider credentials are stored only in the operating-system credential store.",
    vaultUnavailable: "Vault path is available in the packaged desktop app.",
    relocationTitle: "Vault relocation",
    relocationPending: "Relocation controls appear only when the native app can copy and verify every artifact safely.",
    relocateVault: "Choose destination and verify",
    relocatingVault: "Copying and SHA-256 verifying the vault…",
    relocationCancelled: "Vault relocation was cancelled. The source remains active.",
    relocationFailed: "Vault relocation failed safely. The source remains active and was not deleted.",
    relocationVerified: "The new vault is verified. The source vault remains preserved.",
    destinationVault: "Verified destination",
    filesVerified: "Files verified",
    bytesVerified: "Bytes verified",
    sourcePreserved: "Source preserved",
    restartRequired: "Restart is required before Litehouse can write to the new vault.",
    restartNow: "Restart Litehouse",
    updatesHelp: "Litehouse accepts an update only when the signed release manifest and artifact signature verify.",
    alphaChannel: "Alpha preview channel",
    channel: "Update channel",
    stable: "Stable",
    alpha: "Alpha previews",
    autoCheck: "Check automatically when Litehouse starts",
    confirmInstall: "Always ask before install and restart",
    checkUpdate: "Check for updates",
    updateStatus: "No signed update manifest was checked in this browser preview.",
    checkingUpdate: "Checking the signed release manifest…",
    updateAvailable: "Signed update available",
    noUpdate: "Litehouse is current on the selected channel.",
    currentVersion: "Current version",
    releaseVersion: "Release version",
    releaseNotes: "Release notes",
    artifact: "Release artifact",
    installUpdate: "Review and install update",
    installConfirm: "Install signed Litehouse {{version}} and restart the app? Save open notes before continuing.",
    installingUpdate: "Installing the verified update. Litehouse will restart when installation finishes.",
    updateError: "The signed update could not be checked or installed.",
    diagnosticsHelp: "Inspect local services without exposing research queries, notes, or credential values.",
    appVersion: "App version",
    platform: "Browser platform",
    api: "Local API",
    vault: "Vault integrity",
    modelRuntime: "Model runtime",
    refresh: "Refresh diagnostics",
    copyDiagnostics: "Copy redacted diagnostics",
    diagnosticStatus: "Diagnostics refreshed. Sensitive values remain redacted.",
    nativeRequired: "Available in the packaged desktop app",
    reachable: "Reachable",
    unavailable: "Unavailable",
    shortcutHelp: "Shortcuts use Command on macOS and Control on Windows or Linux. They work only while Litehouse is focused.",
    shortcutCommand: "Command",
    shortcutBinding: "Binding",
    shortcutAction: "Edit",
    capture: "Record shortcut",
    recording: "Press a key combination…",
    reset: "Reset",
    resetAll: "Reset all shortcuts",
    reserved: "That combination is reserved by the operating system or app shell.",
    invalid: "Use one non-modifier key, optionally with Command/Control, Alt, or Shift.",
    conflict: "That combination is already assigned to {{command}}.",
    appScoped: "Litehouse never registers global shortcuts or intercepts keys while another application is focused.",
    palette: "Open command palette",
    paletteHelp: "Search every available app command",
  },
  tr: {
    eyebrow: "Uygulama tercihleri",
    title: "Ayarlar",
    lede: "Yerel öncelikli varsayılanlar açık kalır. Bu ekrandaki değişiklikler gelecek istekleri etkiler; tamamlanmış raporlar ilk revizyonlarını ve karmalarını korur.",
    saved: "Tercihler bu cihazda kaydedildi",
    researchGroup: "Araştırma varsayılanları",
    intelligenceGroup: "Zekâ",
    outputGroup: "Çıktı",
    applicationGroup: "Uygulama",
    advancedGroup: "Gelişmiş",
    navigation: "Ayar bölümleri",
    section: {
      profile: "Araştırma varsayılanları",
      watches: "İzlemeler ve programlar",
      sources: "Kaynaklar ve erişim",
      models: "Yerel yapay zekâ",
      providers: "API sağlayıcıları",
      citation: "Dışa aktarım ve raporlar",
      appearance: "Görünüm",
      storage: "Gizlilik ve veriler",
      updates: "Güncellemeler",
      diagnostics: "Tanılama",
      shortcuts: "Klavye kısayolları",
    },
    profileHelp: "İsteğe özgü okuyucu profili verilmediğinde Litehouse'un yapabileceği varsayımları belirleyin.",
    primaryExpertise: "Varsayılan eğitim veya uzmanlık",
    priorKnowledge: "Varsayılan ön bilgi notu",
    priorPlaceholder: "Raporun bilindiğini varsayabileceği yöntemler, alanlar, terminoloji veya uygulama deneyimi…",
    timezone: "Varsayılan saat dilimi (IANA)",
    perRequest: "Her yönlendirmeli istek bu varsayılanları profilinizi değiştirmeden geçersiz kılabilir.",
    watchesHelp: "Daha sonra incelemek üzere yeniden kullanılabilir arama tanımları kaydedin. Statik web alfa arka planda zamanlayıcı çalıştırmaz.",
    watchDemo: "İzleme tanımları ve ilk çalışma raporları bu tarayıcıda kalır. Sonraki güncellemeleri Litehouse açıkken elle başlatın.",
    loadingWatches: "Yerel izlemeler yükleniyor…",
    watchesUnavailable: "Yerel izlemeler yüklenemedi. Gösterim kayıtları bunların yerine kullanılmadı.",
    noWatches: "Bu cihazda henüz yinelenen izleme oluşturulmadı.",
    active: "Etkin",
    paused: "Duraklatıldı",
    nextRun: "Sonraki çalışma",
    noNextRun: "Sıraya alınmış çalışma yok",
    watchDetails: "Revizyon ve bütünlük",
    revision: "Revizyon",
    recentRun: "En son çalışma",
    runIssues: "Kaynak hataları",
    newWatch: "İzleme oluştur",
    sourceHelp: "Kaynak bağdaştırıcılarını etkinleştirin. Her istek alanına uygun sınırlı bir alt küme seçer.",
    oaDefault: "Varsayılan olarak açık erişim tam metin",
    oaHelp: "Etkinse ücretli çalışmalar, bir istek mevcut özetlere açıkça onay vermedikçe yalnızca üstveri olarak kalır.",
    noBypass: "Erişim denetimleri ve yayıncı koşulları aşılmaz.",
    testSources: "Etkin kaynakları sına",
    tested: "Kaynak denetimi sıraya alındı. Sonuçlar istek makbuzlarını ve temizlenmiş hataları gösterecek.",
    modelHelp: "Litehouse bu cihazdaki belleği, mimariyi ve desteklenen hızlandırmayı ölçtükten sonra yerel model önerir.",
    providerHelp: "Rapor sentezinin nerede çalışacağını seçin. Dış sağlayıcılar yalnızca açıkça gönderdiğiniz içeriği alır.",
    provider: "Varsayılan sağlayıcı",
    tier: "Yerel model düzeyi",
    endpoint: "OpenAI uyumlu uç nokta",
    secrets: "API sırları işletim sistemi kimlik kasasından referanslanır; Litehouse ham anahtarları bu ayar dosyasına yazmaz.",
    testProvider: "Sağlayıcıyı sına",
    providerReady: "Yapılandırmanın sözdizimi geçerli. Paketlenmiş uygulama kimliği doğrulanmış uç nokta denetimini yapar.",
    recommendation: "Dengeli yerel öneri",
    recommendationText: "Qwen3 4B · Q4_K_M · yaklaşık 2,5 GB model dosyası",
    recHelp: "Son öneri yerel yetenek ölçümünden sonra değişebilir. İndirmeler sabitlenmiş kaynak adresi, lisans kaydı ve SHA-256 eşleşmesi gerektirir.",
    measureSystem: "Bu sistemi ölç",
    systemMeasured: "Sistem yetenek ölçümü yerel olarak tamamlandı.",
    systemUnavailable: "Sistem yetenekleri güvenli biçimde ölçülemedi.",
    downloadConsent: "Model ve çalışma zamanı indirmeleri herhangi bir ağ isteğinden önce onayınızı gerektirir.",
    installModel: "Doğrulanmış yerel modeli kur",
    installingModel: "Yerel model kuruluyor ve doğrulanıyor…",
    cancelModelInstall: "Kurulumu iptal et",
    cancellingModelInstall: "Geçerli doğrulanmış işlemden sonra iptal ediliyor…",
    localModelReady: "Doğrulanmış yerel model ve çalışma zamanı hazır.",
    startModel: "Yerel modeli başlat",
    startingModel: "Kimliği doğrulanmış yerel model başlatılıyor…",
    stopModel: "Yerel modeli durdur",
    stoppingModel: "Yerel model durduruluyor…",
    modelRunning: "Yerel kanıt sentezi çalışıyor.",
    modelStopped: "Yerel kanıt sentezi durduruldu.",
    modelActionError: "Yerel model işlemi güvenli biçimde tamamlanamadı.",
    modelInstallConfirm: "{{model}} ve llama.cpp sabitlenmiş kaynaklarından indirilsin mi?\n\nModel SHA-256: {{model_sha}}\nÇalışma zamanı SHA-256: {{runtime_sha}}\n\nLitehouse bu makbuzlarla eşleşmeyen her baytı reddeder.",
    installProgress: "Doğrulanmış kurulum ilerlemesi",
    verificationReceipt: "Doğrulama makbuzu",
    advancedProvider: "Gelişmiş sağlayıcı yapılandırması",
    providerModel: "Sağlayıcı model tanımlayıcısı",
    saveProvider: "Sağlayıcıyı kaydet",
    savingProvider: "Sağlayıcı yapılandırması kaydediliyor…",
    providerSaved: "Sağlayıcı yapılandırması kaydedildi.",
    providerError: "Sağlayıcı yapılandırması güvenli biçimde kaydedilemedi.",
    credential: "API kimlik bilgisi",
    credentialStored: "Kimlik bilgisi işletim sistemi kimlik kasasında saklanıyor",
    credentialMissing: "Saklanmış kimlik bilgisi yok",
    credentialUnavailable: "İşletim sistemi kimlik kasası kullanılamıyor",
    storeCredential: "Kimlik bilgisini sakla veya değiştir",
    storingCredential: "Kimlik bilgisi saklanıyor…",
    deleteCredential: "Saklanmış kimlik bilgisini sil",
    credentialDeleted: "Saklanmış kimlik bilgisi silindi.",
    credentialError: "Kimlik bilgisi işlemi güvenli biçimde tamamlanamadı.",
    browserVaultHelp: "Raporlar, notlar, PDF'ler ve model önbellekleri bu tarayıcı profilinde kalır. Litehouse'ın hesap veritabanı veya uygulama sunucusu yoktur.",
    browserVault: "Tarayıcı-yerel kasa",
    browserVaultPersistent: "Olağan depolama temizliğine karşı korunuyor",
    browserVaultBestEffort: "En iyi çaba tarayıcı depolaması",
    browserVaultRequest: "Kalıcı yerel depolama iste",
    browserVaultUsage: "Kaynak depolaması",
    browserVaultReports: "Kayıtlı raporlar",
    browserVaultBackup: "Kasa yedeğini dışa aktar",
    browserVaultEncryption: "Litehouse, IndexedDB için uygulama düzeyinde şifreleme iddiasında bulunmaz. Koruma tarayıcı profiline, cihaz oturumuna ve disk şifrelemesine bağlıdır.",
    browserVaultClear: "Tarayıcıda site verilerini temizlemek bu kasayı ve indirilen modelleri siler. Önce yedek alın.",
    webUpdateHelp: "Web alfa, herkese açık ve incelenebilir GitHub kaynağından sunulur. SHA-256 bildirimi olan, commit'e bağlı yeni site eseri yalnızca herkese açık web doğrulama iş akışı geçtikten sonra yayımlanır.",
    webUpdateReload: "Web uygulamasını yenile",
    webUpdateSource: "Kaynağı ve derleme geçmişini görüntüle",
    saveBeforeCredential: "Kimlik bilgisini saklamadan önce bu sağlayıcıyı kaydedin.",
    min: "Asgari",
    balanced: "Dengeli",
    quality: "Kalite",
    citeHelp: "Yeni raporların kaynak gösterme stilini seçin ve doğrulanmış çevrimdışı derleyiciyi inceleyin.",
    citation: "Varsayılan kaynak gösterme stili",
    attachment: "Lisansı doğrulanmış, yasal olarak yeniden kullanılabilir ekleri dışa aktar",
    duplicate: "Varsayılan yinelenen kuralı",
    latexRuntime: "LaTeX derleyicisi",
    latexReady: "Doğrulanmış çevrimdışı derleyici hazır",
    latexNotReady: "Doğrulanmış derleyici kurulu değil",
    checkCompiler: "Derleyiciyi denetle",
    installCompiler: "Derleyiciyi incele ve kur",
    installingCompiler: "Derleyici kuruluyor ve doğrulanıyor…",
    compilerInstalled: "Doğrulanmış LaTeX derleyicisi kuruldu ve çevrimdışı derleme sınamasını geçti.",
    compilerError: "Doğrulanmış LaTeX derleyicisi denetlenemedi veya kurulamadı.",
    compilerConfirm: "Sabitlenmiş kaynaktan Tectonic {{version}} kurulsun mu? Litehouse, çevrimdışı rapor derlemelerini etkinleştirmeden önce arşiv SHA-256 değerini ve TeX paketini doğrulayacak.",
    compilerCaveat: "Kurulum, onaylanan tek bir ağ isteği dizisi yapar. Rapor derleme daha sonra çevrimdışı, güvenilmeyen kipte ve kapalı hata ilkesiyle çalışır.",
    appearanceHelp: "Tema, hareket ve arayüz dilinin özel önizleme yüzeyi vardır.",
    appearanceLink: "Görünüm ayarlarını aç",
    appearanceSummary: "Sistem teması · tam hareket · yerelde değiştirilmediyse İngilizce",
    storageHelp: "Kasa; içerik adresli kaynak dosyalarını, raporları, notları ve değişmez manifestleri denetlediğiniz bir kökte saklar.",
    vaultPath: "Kasa kökü",
    chooseFolder: "Klasör seç",
    verifyOpen: "Kaydedilmiş eser açıldığında SHA-256 doğrula",
    encryptSecrets: "Sağlayıcı sırlarını işletim sistemi kimlik kasasında tut",
    encryptNotes: "Notları ve ek açıklamaları diskte şifrele",
    encryptNotesHelp: "İsteğe bağlıdır. Kaybolan şifreleme bilgileri Litehouse tarafından kurtarılamaz.",
    relocation: "Kökü değiştirmek kopyalama ve tam karma doğrulaması gerektirir. Kaynak kasa korunur ve hiçbir zaman otomatik olarak silinmez.",
    backup: "Kasa manifestini dışa aktar",
    enforced: "Litehouse tarafından zorunlu",
    credentialManaged: "Sağlayıcı kimlik bilgileri yalnızca işletim sistemi kimlik kasasında saklanır.",
    vaultUnavailable: "Kasa yolu paketlenmiş masaüstü uygulamasında kullanılabilir.",
    relocationTitle: "Kasayı taşıma",
    relocationPending: "Taşıma denetimleri yalnızca yerel uygulama her eseri güvenle kopyalayıp doğrulayabildiğinde görünür.",
    relocateVault: "Hedefi seç ve doğrula",
    relocatingVault: "Kasa kopyalanıyor ve SHA-256 ile doğrulanıyor…",
    relocationCancelled: "Kasa taşıma işlemi iptal edildi. Kaynak etkin kalır.",
    relocationFailed: "Kasa taşıma güvenle başarısız oldu. Kaynak etkin kaldı ve silinmedi.",
    relocationVerified: "Yeni kasa doğrulandı. Kaynak kasa korunmaya devam ediyor.",
    destinationVault: "Doğrulanmış hedef",
    filesVerified: "Doğrulanan dosyalar",
    bytesVerified: "Doğrulanan baytlar",
    sourcePreserved: "Kaynak korundu",
    restartRequired: "Litehouse'un yeni kasaya yazabilmesi için yeniden başlatma gerekir.",
    restartNow: "Litehouse'u yeniden başlat",
    updatesHelp: "Litehouse güncellemeyi yalnızca imzalı sürüm manifesti ve eser imzası doğrulanırsa kabul eder.",
    alphaChannel: "Alfa önizleme kanalı",
    channel: "Güncelleme kanalı",
    stable: "Kararlı",
    alpha: "Alfa önizlemeleri",
    autoCheck: "Litehouse açıldığında otomatik denetle",
    confirmInstall: "Kurulum ve yeniden başlatma öncesinde her zaman sor",
    checkUpdate: "Güncellemeleri denetle",
    updateStatus: "Bu tarayıcı önizlemesinde imzalı güncelleme manifesti denetlenmedi.",
    checkingUpdate: "İmzalı sürüm manifesti denetleniyor…",
    updateAvailable: "İmzalı güncelleme var",
    noUpdate: "Litehouse seçilen kanalda güncel.",
    currentVersion: "Geçerli sürüm",
    releaseVersion: "Sürüm",
    releaseNotes: "Sürüm notları",
    artifact: "Sürüm eseri",
    installUpdate: "Güncellemeyi incele ve kur",
    installConfirm: "İmzalı Litehouse {{version}} sürümü kurulsun ve uygulama yeniden başlatılsın mı? Devam etmeden önce açık notları kaydedin.",
    installingUpdate: "Doğrulanmış güncelleme kuruluyor. Kurulum bitince Litehouse yeniden başlayacak.",
    updateError: "İmzalı güncelleme denetlenemedi veya kurulamadı.",
    diagnosticsHelp: "Araştırma sorgularını, notları veya kimlik bilgilerini açığa çıkarmadan yerel hizmetleri inceleyin.",
    appVersion: "Uygulama sürümü",
    platform: "Tarayıcı platformu",
    api: "Yerel API",
    vault: "Kasa bütünlüğü",
    modelRuntime: "Model çalışma zamanı",
    refresh: "Tanılamayı yenile",
    copyDiagnostics: "Temizlenmiş tanılamayı kopyala",
    diagnosticStatus: "Tanılama yenilendi. Hassas değerler gizli kaldı.",
    nativeRequired: "Paketlenmiş masaüstü uygulamasında kullanılabilir",
    reachable: "Erişilebilir",
    unavailable: "Kullanılamıyor",
    shortcutHelp: "Kısayollar macOS'ta Command, Windows ve Linux'ta Control kullanır. Yalnızca Litehouse odaktayken çalışır.",
    shortcutCommand: "Komut",
    shortcutBinding: "Kısayol",
    shortcutAction: "Düzenle",
    capture: "Kısayol kaydet",
    recording: "Bir tuş birleşimine basın…",
    reset: "Sıfırla",
    resetAll: "Tüm kısayolları sıfırla",
    reserved: "Bu birleşim işletim sistemi veya uygulama kabuğu tarafından ayrılmıştır.",
    invalid: "Command/Control, Alt veya Shift ile birlikte isteğe bağlı tek bir değiştirici olmayan tuş kullanın.",
    conflict: "Bu birleşim {{command}} komutuna atanmış.",
    appScoped: "Litehouse küresel kısayol kaydetmez veya başka bir uygulama odaktayken tuşları yakalamaz.",
    palette: "Komut paletini aç",
    paletteHelp: "Kullanılabilir tüm uygulama komutlarında ara",
  },
} as const;

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("litehouse.settings.v1") ?? "{}") as Partial<LocalSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, sources: { ...DEFAULT_SETTINGS.sources, ...(parsed.sources ?? {}) } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function SettingsPage() {
  const { locale } = useI18n();
  const c = copy[locale];
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSection = new URLSearchParams(location.search).get("section") as SettingsSection | null;
  const section: SettingsSection = requestedSection && SETTINGS_SECTIONS.includes(requestedSection) ? requestedSection : "profile";
  const [settings, setSettings] = useState<LocalSettings>(readSettings);
  const [status, setStatus] = useState("");

  useEffect(() => {
    window.localStorage.setItem("litehouse.settings.v1", JSON.stringify(settings));
  }, [settings]);

  function update<K extends keyof LocalSettings>(key: K, value: LocalSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function chooseSection(next: SettingsSection) {
    setStatus("");
    void navigate({ pathname: "/settings", search: `?section=${next}` }, { replace: true });
  }

  const groups = [
    { id: "research", label: c.researchGroup, sections: ["profile", "watches", "sources"] as SettingsSection[] },
    { id: "intelligence", label: c.intelligenceGroup, sections: ["models", "providers"] as SettingsSection[] },
    { id: "output", label: c.outputGroup, sections: ["citation"] as SettingsSection[] },
    { id: "application", label: c.applicationGroup, sections: ["appearance", "storage"] as SettingsSection[] },
    { id: "advanced", label: c.advancedGroup, sections: ["updates", "diagnostics", "shortcuts"] as SettingsSection[] },
  ];
  const activeGroup = groups.find((group) => group.sections.includes(section));

  return (
    <main id="main-content" className="page lh-settings-page" tabIndex={-1}>
      <header className="page-heading lh-workspace-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
        <p className="lh-autosave"><Check aria-hidden="true" size={15} />{c.saved}</p>
      </header>
      <div className="lh-settings-shell">
        <nav className="lh-settings-nav" aria-label={c.navigation}>
          {groups.map((group) => (
            <div className="lh-settings-nav-group" key={group.id}>
              <p id={`settings-group-${group.id}`}>{group.label}</p>
              <div aria-labelledby={`settings-group-${group.id}`}>
                {group.sections.map((key) => {
                  const Icon = SETTINGS_ICONS[key];
                  return (
                    <button
                      aria-controls="settings-panel"
                      aria-current={section === key ? "page" : undefined}
                      key={key}
                      onClick={() => chooseSection(key)}
                      type="button"
                    >
                      <Icon aria-hidden="true" />
                      <span>{c.section[key]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <section className="lh-settings-panel" id="settings-panel" aria-labelledby={`settings-heading-${section}`} key={section}>
          <header className="lh-settings-panel-heading">
            <p>{activeGroup?.label}</p>
            <h2 id={`settings-heading-${section}`}>{c.section[section]}</h2>
          </header>
          {section === "profile" && <ProfileSettings c={c} settings={settings} update={update} />}
          {section === "watches" && <WatchSettings c={c} locale={locale} />}
          {section === "sources" && <SourceSettings c={c} settings={settings} update={update} />}
          {section === "models" && <ModelSettings c={c} settings={settings} update={update} setStatus={setStatus} mode="local" />}
          {section === "providers" && <ModelSettings c={c} settings={settings} update={update} setStatus={setStatus} mode="providers" />}
          {section === "citation" && <CitationSettings c={c} settings={settings} update={update} setStatus={setStatus} />}
          {section === "appearance" && <AppearanceSettings c={c} />}
          {section === "storage" && <StorageSettings c={c} />}
          {section === "updates" && <UpdateSettings c={c} settings={settings} update={update} setStatus={setStatus} />}
          {section === "diagnostics" && <DiagnosticSettings c={c} setStatus={setStatus} />}
          {section === "shortcuts" && <ShortcutSettings c={c} />}
          <p className="lh-settings-status" role="status" aria-live="polite">{status}</p>
        </section>
      </div>
    </main>
  );
}

type SettingsCopy = (typeof copy)["en"] | (typeof copy)["tr"];
type SettingsUpdate = <K extends keyof LocalSettings>(key: K, value: LocalSettings[K]) => void;

function ProfileSettings({ c, settings, update }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate }) {
  return <div className="lh-settings-content"><p className="lh-section-help">{c.profileHelp}</p><div className="lh-two-fields compact"><label className="lh-field"><span>{c.primaryExpertise}</span><select value={settings.expertise} onChange={(event) => update("expertise", event.target.value)}><option value="undergraduate">Undergraduate</option><option value="masters">Master's</option><option value="doctoral">Doctoral</option><option value="postdoctoral">Postdoctoral</option><option value="faculty">Faculty</option><option value="professional">Professional</option><option value="independent">Independent researcher</option></select></label><label className="lh-field"><span>{c.timezone}</span><input value={settings.defaultTimezone} onChange={(event) => update("defaultTimezone", event.target.value)} /></label></div><label className="lh-field"><span>{c.priorKnowledge}</span><textarea rows={7} maxLength={4000} placeholder={c.priorPlaceholder} value={settings.priorKnowledge} onChange={(event) => update("priorKnowledge", event.target.value)} /><small>{settings.priorKnowledge.length}/4000</small></label><p className="lh-info-strip"><SlidersHorizontal aria-hidden="true" size={17} />{c.perRequest}</p></div>;
}

function WatchSettings({ c }: { c: SettingsCopy; locale: "en" | "tr" }) {
  return <div className="lh-settings-content"><p className="lh-section-help">{c.watchesHelp}</p><p className="lh-demo-label">{c.watchDemo}</p><Link className="button button-primary" to="/reports/new"><BellRing aria-hidden="true" size={17} />{c.newWatch}</Link></div>;
}

function SettingsWatch({ title, schedule, next, active, c, revision, specificationSha, recentRun, sourceErrors }: { title: string; schedule: string; next: string; active: boolean; c: SettingsCopy; revision?: number; specificationSha?: string; recentRun?: string; sourceErrors?: number }) {
  return <article className="lh-settings-watch"><div><span className={`lh-state-chip${active ? " active" : ""}`}>{active ? c.active : c.paused}</span><h3>{title}</h3><p>{schedule}</p></div><div className="lh-settings-watch-next"><small>{c.nextRun}</small><b>{active ? next : "—"}</b>{revision !== undefined && <details><summary>{c.watchDetails}</summary><dl><div><dt>{c.revision}</dt><dd>{revision}</dd></div><div><dt>SHA-256</dt><dd><code>{specificationSha}</code></dd></div><div><dt>{c.recentRun}</dt><dd>{recentRun}</dd></div><div><dt>{c.runIssues}</dt><dd>{sourceErrors}</dd></div></dl></details>}</div></article>;
}

function SourceSettings({ c, settings, update }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate }) {
  const sources = [["openalex", "OpenAlex"], ["crossref", "Crossref"], ["datacite", "DataCite"], ["europe-pmc", "Europe PMC"], ["semantic-scholar", "Semantic Scholar"]] as const;
  return <div className="lh-settings-content"><p className="lh-section-help">{c.sourceHelp}</p><div className="lh-source-grid">{sources.map(([id, label]) => <label className="lh-switch-row" key={id}><span><Database aria-hidden="true" size={16} /><b>{label}</b><small>HTTPS · JSON · receipt</small></span><input type="checkbox" role="switch" checked={settings.sources[id]} onChange={(event) => update("sources", { ...settings.sources, [id]: event.target.checked })} /></label>)}</div><label className="lh-switch-row lh-wide-switch"><span><ShieldCheck aria-hidden="true" size={17} /><b>{c.oaDefault}</b><small>{c.oaHelp}</small></span><input type="checkbox" role="switch" checked={settings.openOnly} onChange={(event) => update("openOnly", event.target.checked)} /></label><p className="lh-safety-note"><LockKeyhole aria-hidden="true" size={18} />{c.noBypass}</p></div>;
}

type ModelSettingsProps = { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void; mode: "local" | "providers" };

function ModelSettings(props: ModelSettingsProps) {
  return props.mode === "local"
    ? <div className="lh-settings-content"><p className="lh-section-help">{props.c.modelHelp}</p><BrowserModelPanel onReadyChange={(ready) => { if (ready) props.setStatus("Private browser model ready for evidence-bounded synthesis."); }} /></div>
    : <RemoteProviderPanel onStatus={props.setStatus} />;
}

function CitationSettings({ c, settings, update }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void }) {
  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.citeHelp}</p>
      <label className="lh-field"><span>{c.citation}</span><select value={settings.citation} onChange={(event) => update("citation", event.target.value)}><option value="apa-7">APA 7</option><option value="ieee">IEEE</option><option value="chicago-author-date">Chicago author–date</option><option value="mla-9">MLA 9</option><option value="vancouver">Vancouver</option><option value="harvard-cite-them-right">Harvard Cite Them Right</option></select></label>
    </div>
  );
}

const THEME_CHOICES: ReadonlyArray<[ThemePreference, string, string]> = [
  ["system", "System", "Follow the operating system"],
  ["light", "Reading room", "Warm parchment, ink text"],
  ["dark", "Night watch", "Low-light reading surface"],
];

const MOTION_CHOICES: ReadonlyArray<[MotionPreference, string, string]> = [
  ["full", "Full", "Transitions and thematic motion"],
  ["reduced", "Reduced", "Only essential state changes"],
  ["off", "Off", "No animation"],
];

function AppearanceSettings({ c }: { c: SettingsCopy }) {
  const { theme, setTheme, motion, setMotion } = useAppearance();
  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.appearanceHelp}</p>
      <fieldset className="lh-appearance-group">
        <legend>Theme</legend>
        <div className="lh-choice-row">
          {THEME_CHOICES.map(([value, label, hint]) => (
            <label key={value} className={`lh-choice-card${theme === value ? " is-selected" : ""}`}>
              <input type="radio" name="theme" value={value} aria-label={label} checked={theme === value} onChange={() => setTheme(value)} />
              <span><b>{label}</b><small>{hint}</small></span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="lh-appearance-group">
        <legend>Motion</legend>
        <div className="lh-choice-row">
          {MOTION_CHOICES.map(([value, label, hint]) => (
            <label key={value} className={`lh-choice-card${motion === value ? " is-selected" : ""}`}>
              <input type="radio" name="motion" value={value} aria-label={label} checked={motion === value} onChange={() => setMotion(value)} />
              <span><b>{label}</b><small>{hint}</small></span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function StorageSettings({ c }: { c: SettingsCopy }) {
  return <BrowserStorageSettings c={c} />;
}

function BrowserStorageSettings({ c }: { c: SettingsCopy }) {
  const [storage, setStorage] = useState<BrowserStorageStatus | null>(null);
  const [reportCount, setReportCount] = useState(0);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh(requestPersistence = false) {
    setActing(true);
    try {
      const [nextStorage, reports] = await Promise.all([
        browserStorageStatus(requestPersistence),
        listBrowserReports(),
      ]);
      setStorage(nextStorage);
      setReportCount(reports.length);
      if (requestPersistence) setMessage(nextStorage.persistent ? c.browserVaultPersistent : c.browserVaultBestEffort);
    } catch {
      setMessage(c.vaultUnavailable);
    } finally {
      setActing(false);
    }
  }

  useEffect(() => {
    void refresh();
  // The browser-vault status is measured once when the panel opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function exportBackup() {
    setActing(true);
    try {
      const reports = await listBrowserReports();
      const payload = JSON.stringify({
        schema: "https://litehouse.pub/schemas/browser-vault-backup/v1",
        exportedAt: new Date().toISOString(),
        origin: window.location.origin,
        reports,
      }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `litehouse-vault-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage(c.browserVaultBackup);
    } catch {
      setMessage(c.vaultUnavailable);
    } finally {
      setActing(false);
    }
  }

  const formatBytes = (value?: number) => value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(value / 1024 ** 2);

  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.browserVaultHelp}</p>
      <dl className="lh-storage-facts">
        <div><dt>{c.browserVault}</dt><dd><Database aria-hidden="true" size={16} />IndexedDB · {window.location.origin}</dd></div>
        <div><dt>{c.browserVaultUsage}</dt><dd>{formatBytes(storage?.usage)} / {formatBytes(storage?.quota)}</dd></div>
        <div><dt>{c.browserVaultReports}</dt><dd>{reportCount}</dd></div>
        <div><dt>Eviction policy</dt><dd><ShieldCheck aria-hidden="true" size={16} />{storage?.persistent ? c.browserVaultPersistent : c.browserVaultBestEffort}</dd></div>
      </dl>
      <div className="lh-inline-actions">
        {!storage?.persistent && <button className="button button-primary" type="button" disabled={acting} onClick={() => void refresh(true)}><ShieldCheck aria-hidden="true" size={17} />{c.browserVaultRequest}</button>}
        <button className="button button-secondary" type="button" disabled={acting} onClick={() => void exportBackup()}><FileOutput aria-hidden="true" size={17} />{c.browserVaultBackup}</button>
        <Link className="button button-secondary" to="/privacy"><ExternalLink aria-hidden="true" size={16} />Privacy architecture</Link>
      </div>
      <p className="lh-safety-note"><LockKeyhole aria-hidden="true" size={18} />{c.browserVaultEncryption}</p>
      <p className="lh-info-strip"><ShieldCheck aria-hidden="true" size={17} />{c.browserVaultClear}</p>
      <p role="status" aria-live="polite">{message}</p>
    </div>
  );
}

function UpdateSettings({ c }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void }) {
  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.webUpdateHelp}</p>
      <div className="lh-model-recommendation">
        <div><p className="eyebrow">GitHub Pages</p><h3>Litehouse web alpha</h3><p>HTTPS · commit-linked build · SHA-256 manifest</p></div>
        <ShieldCheck aria-hidden="true" size={30} />
      </div>
      <div className="lh-inline-actions">
        <button className="button button-primary" type="button" onClick={() => window.location.reload()}><RefreshCw aria-hidden="true" size={17} />{c.webUpdateReload}</button>
        <a className="button button-secondary" href="https://github.com/tunabirgun/litehouse/actions" target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={16} />{c.webUpdateSource}</a>
      </div>
      <p className="lh-safety-note"><LockKeyhole aria-hidden="true" size={18} />No installer, updater daemon, or Litehouse account service runs on this device.</p>
    </div>
  );
}

function DiagnosticSettings({ c, setStatus }: { c: SettingsCopy; setStatus: (status: string) => void }) {
  const platform = navigator.platform || "Unknown";
  const offlineShell = document.documentElement.dataset.offlineShell;

  async function copyDiagnostics() {
    const redacted = JSON.stringify({
      version: "0.1.0-alpha.1",
      platform,
      mode: "static-web",
      origin: window.location.origin,
      secure_context: window.isSecureContext,
      indexed_db: "indexedDB" in window,
      web_gpu: "gpu" in navigator,
      service_worker: "serviceWorker" in navigator,
      offline_shell: offlineShell ?? "registration-pending",
      secrets: "redacted",
    }, null, 2);
    try {
      await navigator.clipboard.writeText(redacted);
      setStatus(c.diagnosticStatus);
    } catch {
      setStatus(c.unavailable);
    }
  }

  const offlineShellLabel = !("serviceWorker" in navigator)
    ? "Unavailable"
    : offlineShell === "failed"
      ? "Registration failed — online mode still works"
      : offlineShell === "registered"
        ? "Registered for this app scope"
        : "Registration pending";
  return <div className="lh-settings-content"><p className="lh-section-help">Capability facts are computed in this browser. The copied diagnostic contains no keys, report text, search terms, file names, or vault contents.</p><dl className="lh-diagnostics"><div><dt>{c.appVersion}</dt><dd>0.1.0-alpha.1 · web</dd></div><div><dt>{c.platform}</dt><dd>{platform}</dd></div><div><dt>Secure context</dt><dd><span className="lh-diagnostic-state pending">{window.isSecureContext ? "■" : "◧"}</span> {window.isSecureContext ? "HTTPS active" : "HTTPS required"}</dd></div><div><dt>Browser vault</dt><dd><span className="lh-diagnostic-state pending">{"indexedDB" in window ? "■" : "◧"}</span> {"indexedDB" in window ? "IndexedDB available" : "Unavailable"}</dd></div><div><dt>Local AI</dt><dd><span className="lh-diagnostic-state pending">{"gpu" in navigator ? "■" : "◧"}</span> {"gpu" in navigator ? "WebGPU exposed" : "WebGPU not exposed"}</dd></div><div><dt>Offline shell</dt><dd><span className="lh-diagnostic-state pending">{offlineShell === "registered" ? "■" : "◧"}</span> {offlineShellLabel}</dd></div></dl><div className="lh-inline-actions"><button className="button button-secondary" type="button" onClick={copyDiagnostics}>{c.copyDiagnostics}</button><Link className="button button-secondary" to="/privacy">Privacy architecture</Link></div></div>;
}

function ShortcutSettings({ c }: { c: SettingsCopy }) {
  const { commands, getBinding, setBinding, resetBinding, resetAllBindings, platform } = useShortcuts();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rows = useMemo(() => [{ id: "app.commandPalette", label: c.palette, description: c.paletteHelp }, ...commands], [c.palette, c.paletteHelp, commands]);

  function capture(event: KeyboardEvent<HTMLButtonElement>, commandId: string) {
    if (event.key === "Escape") {
      event.preventDefault();
      setCapturing(null);
      setError("");
      return;
    }
    const binding = bindingFromKeyboardEvent(event.nativeEvent, platform);
    if (!binding) return;
    event.preventDefault();
    const result = setBinding(commandId, binding);
    if (result.ok) {
      setCapturing(null);
      setError("");
      return;
    }
    if (result.reason === "reserved") setError(c.reserved);
    else if (result.reason === "invalid") setError(c.invalid);
    else {
      const conflict = rows.find((row) => row.id === result.conflictWith)?.label ?? result.conflictWith ?? "";
      setError(c.conflict.replace("{{command}}", conflict));
    }
  }

  return <div className="lh-settings-content"><p className="lh-section-help">{c.shortcutHelp}</p><p className="lh-safety-note"><Keyboard aria-hidden="true" size={18} />{c.appScoped}</p><div className="lh-shortcut-table" role="table" aria-label={c.section.shortcuts}><div className="lh-shortcut-head" role="row"><span role="columnheader">{c.shortcutCommand}</span><span role="columnheader">{c.shortcutBinding}</span><span role="columnheader">{c.shortcutAction}</span></div>{rows.map((command) => { const binding = getBinding(command.id); const isCapturing = capturing === command.id; return <div className="lh-shortcut-row" role="row" key={command.id}><span role="cell"><b>{command.label}</b><small>{command.description}</small></span><span role="cell"><kbd>{binding ? formatShortcut(binding, platform) : "—"}</kbd></span><span role="cell"><button className={isCapturing ? "is-recording" : ""} type="button" onClick={() => { setCapturing(command.id); setError(""); }} onKeyDown={(event) => isCapturing && capture(event, command.id)}>{isCapturing ? c.recording : c.capture}</button><button type="button" onClick={() => { resetBinding(command.id); setError(""); }}><RotateCcw aria-hidden="true" size={14} /><span className="sr-only">{c.reset} {command.label}</span></button></span></div>; })}</div>{error && <p className="lh-form-error" role="alert">{error}</p>}<button className="button button-secondary" type="button" onClick={() => { resetAllBindings(); setError(""); setCapturing(null); }}><RotateCcw aria-hidden="true" size={17} />{c.resetAll}</button></div>;
}
