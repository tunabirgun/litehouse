import {
  BellRing,
  BrainCircuit,
  Check,
  Database,
  DownloadCloud,
  ExternalLink,
  FileCheck2,
  FileOutput,
  Gauge,
  Keyboard,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useI18n } from "./i18n";
import {
  nativeApi,
  type NativePaths,
  type NativeUpdateInfo,
  type NativeVaultRelocationReceipt,
  setAutoCheckEnabled,
} from "./native";
import {
  bindingFromKeyboardEvent,
  formatShortcut,
  useShortcuts,
} from "./shortcuts";

type SettingsSection =
  | "profile"
  | "watches"
  | "sources"
  | "models"
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
  vaultPath: string;
  verifyOnOpen: boolean;
  encryptSecrets: boolean;
  encryptNotes: boolean;
  updateChannel: "stable" | "alpha";
  autoCheck: boolean;
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
  vaultPath: "~/Litehouse",
  verifyOnOpen: true,
  encryptSecrets: true,
  encryptNotes: false,
  updateChannel: "alpha",
  autoCheck: true,
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  "profile",
  "watches",
  "sources",
  "models",
  "citation",
  "appearance",
  "storage",
  "updates",
  "diagnostics",
  "shortcuts",
];

const copy = {
  en: {
    eyebrow: "Application preferences",
    title: "Settings",
    lede: "Local-first defaults remain explicit. Changes on this screen affect future requests; completed reports keep their original revision and hashes.",
    saved: "Preferences saved on this device",
    sectionPicker: "Settings section",
    researchGroup: "Research defaults",
    outputGroup: "Models and output",
    applicationGroup: "Application and data",
    section: {
      profile: "Profile & expertise",
      watches: "Watches & schedules",
      sources: "Sources & access",
      models: "Models & providers",
      citation: "Citation & export",
      appearance: "Appearance & language",
      storage: "Vault, privacy & encryption",
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
    watchesHelp: "Review recurring searches and their next scheduled local run.",
    watchDemo: "Demonstration watches — packaged Litehouse shows only your local records here.",
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
    modelHelp: "The native app recommends a local model after probing memory, architecture, and supported acceleration.",
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
    sectionPicker: "Ayar bölümü",
    researchGroup: "Araştırma varsayılanları",
    outputGroup: "Modeller ve çıktı",
    applicationGroup: "Uygulama ve veri",
    section: {
      profile: "Profil ve uzmanlık",
      watches: "İzlemeler ve programlar",
      sources: "Kaynaklar ve erişim",
      models: "Modeller ve sağlayıcılar",
      citation: "Kaynakça ve dışa aktarım",
      appearance: "Görünüm ve dil",
      storage: "Kasa, gizlilik ve şifreleme",
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
    watchesHelp: "Yinelenen taramaları ve sonraki yerel çalışma saatlerini inceleyin.",
    watchDemo: "Gösterim izlemeleri — paketlenmiş Litehouse burada yalnızca yerel kayıtlarınızı gösterir.",
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
    modelHelp: "Yerel uygulama belleği, mimariyi ve desteklenen hızlandırmayı ölçtükten sonra yerel model önerir.",
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
  const requestedSection = new URLSearchParams(location.search).get("section") as SettingsSection | null;
  const [section, setSection] = useState<SettingsSection>(requestedSection && SETTINGS_SECTIONS.includes(requestedSection) ? requestedSection : "profile");
  const [settings, setSettings] = useState<LocalSettings>(readSettings);
  const [status, setStatus] = useState("");

  useEffect(() => {
    window.localStorage.setItem("litehouse.settings.v1", JSON.stringify(settings));
  }, [settings]);

  function update<K extends keyof LocalSettings>(key: K, value: LocalSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function chooseSection(next: SettingsSection) {
    setSection(next);
    setStatus("");
    window.history.replaceState(null, "", `/settings?section=${next}`);
  }

  return (
    <main id="main-content" className="page lh-settings-page" tabIndex={-1}>
      <header className="page-heading lh-workspace-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
        <p className="lh-autosave"><Check aria-hidden="true" size={15} />{c.saved}</p>
      </header>
      <div className="lh-settings-shell">
        <label className="lh-settings-picker">
          <span>{c.sectionPicker}</span>
          <select value={section} onChange={(event) => chooseSection(event.target.value as SettingsSection)}>
            <optgroup label={c.researchGroup}>
              {(["profile", "watches", "sources"] as SettingsSection[]).map((key) => <option key={key} value={key}>{c.section[key]}</option>)}
            </optgroup>
            <optgroup label={c.outputGroup}>
              {(["models", "citation"] as SettingsSection[]).map((key) => <option key={key} value={key}>{c.section[key]}</option>)}
            </optgroup>
            <optgroup label={c.applicationGroup}>
              {(["appearance", "storage", "updates", "diagnostics", "shortcuts"] as SettingsSection[]).map((key) => <option key={key} value={key}>{c.section[key]}</option>)}
            </optgroup>
          </select>
        </label>
        <section className="lh-settings-panel" aria-labelledby={`settings-${section}`}>
          <p className="section-index">{String(SETTINGS_SECTIONS.indexOf(section) + 1).padStart(2, "0")}</p>
          <h2 id={`settings-${section}`}>{c.section[section]}</h2>
          {section === "profile" && <ProfileSettings c={c} settings={settings} update={update} />}
          {section === "watches" && <WatchSettings c={c} locale={locale} />}
          {section === "sources" && <SourceSettings c={c} settings={settings} update={update} />}
          {section === "models" && <ModelSettings c={c} settings={settings} update={update} setStatus={setStatus} />}
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

function WatchSettings({ c, locale }: { c: SettingsCopy; locale: "en" | "tr" }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; watches: NativeWatchReceipt[]; runs: NativeRunReceipt[] }
  >({ kind: "loading" });

  useEffect(() => {
    if (!nativeApi.available) return;
    let active = true;
    void Promise.all([
      nativeApi.request<NativeWatchReceipt[]>("GET", "/v1/watches"),
      nativeApi.request<NativeRunReceipt[]>("GET", "/v1/runs?limit=50"),
    ]).then(([watches, runs]) => {
      if (!active) return;
      if (watches.status !== 200 || runs.status !== 200 || !Array.isArray(watches.body) || !Array.isArray(runs.body)) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "ready", watches: watches.body, runs: runs.body });
    }).catch(() => active && setState({ kind: "error" }));
    return () => { active = false; };
  }, []);

  if (!nativeApi.available) {
    return <div className="lh-settings-content"><p className="lh-section-help">{c.watchesHelp}</p><p className="lh-demo-label">{c.watchDemo}</p><div className="lh-watch-list"><SettingsWatch title="Molecular interaction prediction" schedule="Daily · 07:30 · Europe/Istanbul" next="16 Jul · 07:30" active c={c} /><SettingsWatch title="Environmental humanities" schedule="Weekly · Monday · 09:00" next="—" active={false} c={c} /></div><Link className="button button-primary" to="/reports/new"><BellRing aria-hidden="true" size={17} />{c.newWatch}</Link></div>;
  }

  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.watchesHelp}</p>
      {state.kind === "loading" && <p className="lh-settings-state" role="status">{c.loadingWatches}</p>}
      {state.kind === "error" && <p className="lh-settings-state is-error" role="alert">{c.watchesUnavailable}</p>}
      {state.kind === "ready" && state.watches.length === 0 && <p className="lh-settings-state">{c.noWatches}</p>}
      {state.kind === "ready" && state.watches.length > 0 && (
        <div className="lh-watch-list">
          {state.watches.map((watch) => {
            const matchingRuns = state.runs.filter((run) => run.watch_revision_id === watch.active_revision.id);
            const queuedRun = matchingRuns
              .filter((run) => run.status === "queued")
              .sort((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at))[0];
            const recentRun = matchingRuns
              .sort((left, right) => Date.parse(right.scheduled_at) - Date.parse(left.scheduled_at))[0];
            const schedule = watch.active_revision.specification.schedule;
            const scheduleLabel = schedule.kind === "cron"
              ? `Cron ${schedule.expression} · ${watch.active_revision.specification.timezone}`
              : `${schedule.every} ${schedule.unit} · ${watch.active_revision.specification.timezone}`;
            const formatDate = (value: string) => new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
            return (
              <SettingsWatch
                key={watch.id}
                title={watch.name}
                schedule={scheduleLabel}
                next={queuedRun ? formatDate(queuedRun.scheduled_at) : c.noNextRun}
                active={watch.enabled}
                c={c}
                revision={watch.active_revision.number}
                specificationSha={watch.active_revision.specification_sha256}
                recentRun={recentRun ? `${recentRun.status} · ${formatDate(recentRun.scheduled_at)}` : "—"}
                sourceErrors={recentRun?.source_error_count ?? 0}
              />
            );
          })}
        </div>
      )}
      <Link className="button button-primary" to="/reports/new"><BellRing aria-hidden="true" size={17} />{c.newWatch}</Link>
    </div>
  );
}

function SettingsWatch({ title, schedule, next, active, c, revision, specificationSha, recentRun, sourceErrors }: { title: string; schedule: string; next: string; active: boolean; c: SettingsCopy; revision?: number; specificationSha?: string; recentRun?: string; sourceErrors?: number }) {
  return <article className="lh-settings-watch"><div><span className={`lh-state-chip${active ? " active" : ""}`}>{active ? c.active : c.paused}</span><h3>{title}</h3><p>{schedule}</p></div><div className="lh-settings-watch-next"><small>{c.nextRun}</small><b>{active ? next : "—"}</b>{revision !== undefined && <details><summary>{c.watchDetails}</summary><dl><div><dt>{c.revision}</dt><dd>{revision}</dd></div><div><dt>SHA-256</dt><dd><code>{specificationSha}</code></dd></div><div><dt>{c.recentRun}</dt><dd>{recentRun}</dd></div><div><dt>{c.runIssues}</dt><dd>{sourceErrors}</dd></div></dl></details>}</div></article>;
}

function SourceSettings({ c, settings, update }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate }) {
  const sources = [["openalex", "OpenAlex"], ["crossref", "Crossref"], ["datacite", "DataCite"], ["europe-pmc", "Europe PMC"], ["semantic-scholar", "Semantic Scholar"], ["library-of-congress", "Library of Congress"]] as const;
  return <div className="lh-settings-content"><p className="lh-section-help">{c.sourceHelp}</p><div className="lh-source-grid">{sources.map(([id, label]) => <label className="lh-switch-row" key={id}><span><Database aria-hidden="true" size={16} /><b>{label}</b><small>HTTPS · JSON · receipt</small></span><input type="checkbox" role="switch" checked={settings.sources[id]} onChange={(event) => update("sources", { ...settings.sources, [id]: event.target.checked })} /></label>)}</div><label className="lh-switch-row lh-wide-switch"><span><ShieldCheck aria-hidden="true" size={17} /><b>{c.oaDefault}</b><small>{c.oaHelp}</small></span><input type="checkbox" role="switch" checked={settings.openOnly} onChange={(event) => update("openOnly", event.target.checked)} /></label><p className="lh-safety-note"><LockKeyhole aria-hidden="true" size={18} />{c.noBypass}</p></div>;
}

function ModelSettings({ c, settings, update, setStatus }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void }) {
  const [system, setSystem] = useState<LocalModelRecommendationReceipt | null>(null);
  const [job, setJob] = useState<LocalModelInstallReceipt | null>(null);
  const [server, setServer] = useState<LocalModelServerReceipt | null>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsReceipt | null>(null);
  const [providerModel, setProviderModel] = useState("");
  const [credential, setCredential] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const [acting, setActing] = useState(false);
  const [providerActing, setProviderActing] = useState(false);

  async function measureSystem() {
    if (!nativeApi.available || measuring) {
      setStatus(c.nativeRequired);
      return;
    }
    setMeasuring(true);
    try {
      const response = await nativeApi.request<LocalModelRecommendationReceipt>(
        "GET",
        "/v1/local-model/recommendation",
      );
      if (
        response.status !== 200
        || !isLocalModelRecommendationReceipt(response.body)
      ) throw new Error("capability measurement rejected");
      setSystem(response.body);
      const statusResponse = await nativeApi.request<LocalModelStatusReceipt>(
        "GET",
        "/v1/local-model/status",
      );
      if (statusResponse.status === 200) {
        setJob(statusResponse.body.install);
        setServer(statusResponse.body.server);
      }
      setStatus(c.systemMeasured);
    } catch {
      setStatus(c.systemUnavailable);
    } finally {
      setMeasuring(false);
    }
  }

  useEffect(() => {
    if (!nativeApi.available) return;
    void measureSystem();
    void loadProviderSettings();
  // The native capability result is intentionally refreshed when this section mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!nativeApi.available || !job || !ACTIVE_MODEL_INSTALL_STATES.has(job.state)) return;
    let disposed = false;
    let timer: number | undefined;
    const jobId = job.job_id;
    async function poll() {
      try {
        const response = await nativeApi.request<LocalModelInstallReceipt>(
          "GET",
          `/v1/local-model/install/${jobId}`,
        );
        if (disposed || response.status !== 200) return;
        setJob(response.body);
        if (response.body.state === "ready") setStatus(c.localModelReady);
        if (response.body.state === "failed") setStatus(c.modelActionError);
        if (response.body.state === "cancelled") setStatus(c.modelStopped);
        if (ACTIVE_MODEL_INSTALL_STATES.has(response.body.state)) {
          timer = window.setTimeout(poll, 600);
        }
      } catch {
        if (!disposed) setStatus(c.modelActionError);
      }
    }
    timer = window.setTimeout(poll, 300);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [c.localModelReady, c.modelActionError, c.modelStopped, job?.job_id, job?.state, setStatus]);

  const selected = system?.options.find(({ tier }) => tier === settings.modelTier);
  const modelFile = selected ? `${(selected.model.size / 1024 ** 3).toFixed(2)} GiB` : null;
  const measuredSummary = selected
    ? `${selected.model.model_id} · ${selected.quantization} · ${modelFile ?? "—"}`
    : c.recommendationText;
  const installing = job ? ACTIVE_MODEL_INSTALL_STATES.has(job.state) : false;
  const ready = job?.state === "ready";

  async function installLocalModel() {
    if (!nativeApi.available || !selected || !system || acting || !selected.installable) {
      setStatus(nativeApi.available ? c.modelActionError : c.nativeRequired);
      return;
    }
    const prompt = c.modelInstallConfirm
      .replace("{{model}}", selected.model.model_id)
      .replace("{{model_sha}}", selected.model.sha256)
      .replace("{{runtime_sha}}", system.runtime.archive_sha256);
    if (!window.confirm(prompt)) return;
    setActing(true);
    setStatus(c.installingModel);
    try {
      const response = await nativeApi.request<LocalModelInstallReceipt>(
        "POST",
        "/v1/local-model/install",
        {
          tier: selected.tier,
          approved_model_sha256: selected.model.sha256,
          approved_runtime_sha256: system.runtime.archive_sha256,
        },
      );
      if (response.status !== 202) throw new Error("model install rejected");
      setJob(response.body);
    } catch {
      setStatus(c.modelActionError);
    } finally {
      setActing(false);
    }
  }

  async function cancelInstall() {
    if (!nativeApi.available || !job || acting) return;
    setActing(true);
    setStatus(c.cancellingModelInstall);
    try {
      const response = await nativeApi.request<LocalModelInstallReceipt>(
        "POST",
        `/v1/local-model/install/${job.job_id}/cancel`,
      );
      if (response.status !== 202) throw new Error("model cancellation rejected");
      setJob(response.body);
    } catch {
      setStatus(c.modelActionError);
    } finally {
      setActing(false);
    }
  }

  async function setServerRunning(running: boolean) {
    if (!nativeApi.available || acting) return;
    setActing(true);
    setStatus(running ? c.startingModel : c.stoppingModel);
    try {
      const response = await nativeApi.request<LocalModelServerReceipt>(
        "POST",
        running ? "/v1/local-model/server/start" : "/v1/local-model/server/stop",
      );
      if (response.status !== 200) throw new Error("model server action rejected");
      setServer(response.body);
      setStatus(response.body.running ? c.modelRunning : c.modelStopped);
    } catch {
      setStatus(c.modelActionError);
    } finally {
      setActing(false);
    }
  }

  async function loadProviderSettings() {
    if (!nativeApi.available) return;
    try {
      const response = await nativeApi.request<ProviderSettingsReceipt>(
        "GET",
        "/v1/model-provider",
      );
      if (response.status !== 200) throw new Error("provider settings rejected");
      setProviderSettings(response.body);
      update("provider", response.body.provider);
      update("customEndpoint", response.body.base_url ?? "");
      setProviderModel(response.body.model ?? "");
    } catch {
      setStatus(c.providerError);
    }
  }

  function chooseProvider(provider: LocalSettings["provider"]) {
    const defaults = PROVIDER_DEFAULTS[provider];
    update("provider", provider);
    update("customEndpoint", defaults.baseUrl);
    setProviderModel(defaults.model);
    setCredential("");
  }

  async function saveProvider() {
    if (!nativeApi.available || providerActing) {
      setStatus(c.nativeRequired);
      return;
    }
    const defaults = PROVIDER_DEFAULTS[settings.provider];
    const body = settings.provider === "integrated"
      ? { provider: "integrated" }
      : {
          provider: settings.provider,
          base_url: settings.customEndpoint.trim(),
          model: providerModel.trim(),
          display_name: defaults.displayName,
        };
    setProviderActing(true);
    setStatus(c.savingProvider);
    try {
      const response = await nativeApi.request<ProviderSettingsReceipt>(
        "POST",
        "/v1/model-provider/config",
        body,
      );
      if (response.status !== 200) throw new Error("provider configuration rejected");
      setProviderSettings(response.body);
      setStatus(c.providerSaved);
    } catch {
      setStatus(c.providerError);
    } finally {
      setProviderActing(false);
    }
  }

  async function storeCredential() {
    if (!nativeApi.available || providerActing || !credential) return;
    if (providerSettings?.provider !== settings.provider) {
      setStatus(c.saveBeforeCredential);
      return;
    }
    setProviderActing(true);
    setStatus(c.storingCredential);
    try {
      const response = await nativeApi.request<ProviderSettingsReceipt>(
        "POST",
        "/v1/model-provider/secret",
        { provider: settings.provider, secret: credential },
      );
      if (response.status !== 200) throw new Error("credential store rejected");
      setProviderSettings(response.body);
      setStatus(c.credentialStored);
    } catch {
      setStatus(c.credentialError);
    } finally {
      setCredential("");
      setProviderActing(false);
    }
  }

  async function deleteCredential() {
    if (!nativeApi.available || providerActing) return;
    setProviderActing(true);
    try {
      const response = await nativeApi.request<ProviderSettingsReceipt>(
        "POST",
        "/v1/model-provider/secret/delete",
        { provider: settings.provider },
      );
      if (response.status !== 200) throw new Error("credential delete rejected");
      setProviderSettings(response.body);
      setStatus(c.credentialDeleted);
    } catch {
      setStatus(c.credentialError);
    } finally {
      setProviderActing(false);
    }
  }

  const needsCredential = ["openai", "anthropic", "gemini", "custom"].includes(settings.provider);
  const fixedProviderEndpoint = ["openai", "anthropic", "gemini"].includes(settings.provider);
  const credentialLabel = providerSettings?.credential_state === "stored"
    ? c.credentialStored
    : providerSettings?.credential_state === "unavailable"
      ? c.credentialUnavailable
      : c.credentialMissing;

  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.modelHelp}</p>
      <div className="lh-model-recommendation">
        <div>
          <p className="eyebrow">{c.recommendation}</p>
          <h3>{measuredSummary}</h3>
          <p>{selected?.reasons[0] ?? c.recHelp}</p>
          {selected && (
            <small>
              {selected.model.license_spdx} · {selected.model.publisher}
            </small>
          )}
        </div>
        <ShieldCheck aria-hidden="true" size={30} />
      </div>
      {installing && job && <div className="lh-install-progress" role="status"><label htmlFor="model-install-progress">{c.installProgress}</label><progress id="model-install-progress" max={1} value={job.progress_fraction} /><small>{Math.round(job.progress_fraction * 100)}% · {(job.downloaded_bytes / 1024 ** 2).toFixed(0)} / {(job.total_bytes / 1024 ** 2).toFixed(0)} MiB</small></div>}
      <div className="lh-inline-actions">
        {installing ? (
          <button className="button button-secondary" type="button" disabled={acting || job?.state === "cancelling"} onClick={cancelInstall}>{c.cancelModelInstall}</button>
        ) : !ready ? (
          <button className="button button-primary" type="button" disabled={acting || measuring || !selected?.installable} onClick={installLocalModel}><DownloadCloud aria-hidden="true" size={17} />{c.installModel}</button>
        ) : server?.running ? (
          <button className="button button-secondary" type="button" disabled={acting} onClick={() => setServerRunning(false)}>{c.stopModel}</button>
        ) : (
          <button className="button button-primary" type="button" disabled={acting} onClick={() => setServerRunning(true)}><BrainCircuit aria-hidden="true" size={17} />{c.startModel}</button>
        )}
        <button className="button button-secondary" type="button" disabled={measuring || acting} onClick={measureSystem}><RefreshCw aria-hidden="true" size={17} /><span className="sr-only">{c.measureSystem}</span></button>
      </div>
      <details className="lh-settings-disclosure">
        <summary>{c.advancedProvider}</summary>
        <fieldset className="lh-fieldset">
          <legend>{c.tier}</legend>
          <div className="lh-card-choices three-column">
            {(["minimum", "balanced", "quality"] as const).map((tier) => {
              const measured = system?.options.find((item) => item.tier === tier);
              return <label key={tier} className={`lh-option-card${settings.modelTier === tier ? " is-selected" : ""}`}><input type="radio" name="model-tier" checked={settings.modelTier === tier} onChange={() => update("modelTier", tier)} /><span className="lh-option-mark" aria-hidden="true">{settings.modelTier === tier ? "■" : "□"}</span><span><b>{tier === "minimum" ? c.min : tier === "balanced" ? c.balanced : c.quality}</b><small>{measured ? `${measured.model.model_id} · ${(measured.estimated_working_set_bytes / 1024 ** 3).toFixed(1)} GiB` : tier === "minimum" ? "1–2 GB" : tier === "balanced" ? "3–6 GB" : "8+ GB"}</small></span></label>;
            })}
          </div>
        </fieldset>
        {selected && <p className="lh-provider-receipt">SHA-256 {selected.model.sha256}<br />llama.cpp SHA-256 {system?.runtime.archive_sha256}</p>}
        <div className="lh-two-fields compact">
          <label className="lh-field"><span>{c.provider}</span><select value={settings.provider} onChange={(event) => chooseProvider(event.target.value as LocalSettings["provider"])}><option value="integrated">Integrated llama.cpp</option><option value="local-compatible">Other local endpoint</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="custom">Custom compatible API</option></select></label>
          {settings.provider !== "integrated" && <label className="lh-field"><span>{c.endpoint}</span><input value={settings.customEndpoint} disabled={fixedProviderEndpoint} onChange={(event) => update("customEndpoint", event.target.value)} /></label>}
        </div>
        {settings.provider !== "integrated" && <label className="lh-field"><span>{c.providerModel}</span><input value={providerModel} autoComplete="off" spellCheck={false} onChange={(event) => setProviderModel(event.target.value)} /></label>}
        <div className="lh-inline-actions"><button className="button button-secondary" type="button" disabled={providerActing || (settings.provider !== "integrated" && (!providerModel.trim() || !settings.customEndpoint.trim()))} onClick={saveProvider}>{c.saveProvider}</button></div>
        {needsCredential && <div className="lh-provider-credential"><p className={`lh-credential-state ${providerSettings?.credential_state ?? "missing"}`}><LockKeyhole aria-hidden="true" size={16} />{credentialLabel}</p><label className="lh-field"><span>{c.credential}</span><input type="password" value={credential} autoComplete="new-password" spellCheck={false} onChange={(event) => setCredential(event.target.value)} /></label><div className="lh-inline-actions"><button className="button button-secondary" type="button" disabled={providerActing || !credential} onClick={storeCredential}>{c.storeCredential}</button>{providerSettings?.provider === settings.provider && providerSettings.credential_state === "stored" && <button className="button button-secondary" type="button" disabled={providerActing} onClick={deleteCredential}>{c.deleteCredential}</button>}</div></div>}
      </details>
      {system && (
        <p className="lh-info-strip">
          <Gauge aria-hidden="true" size={17} />
          {system.runtime.operating_system} · {system.runtime.architecture} · {system.runtime.available_backends.join(" / ")}
        </p>
      )}
      <p className="lh-info-strip"><LockKeyhole aria-hidden="true" size={17} />{c.secrets}</p>
      <p className="lh-safety-note"><ShieldCheck aria-hidden="true" size={18} />{c.downloadConsent}</p>
    </div>
  );
}

function CitationSettings({ c, settings, update, setStatus }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void }) {
  const [runtime, setRuntime] = useState<TectonicRuntimeReceipt | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  async function checkRuntime() {
    if (!nativeApi.available || checking) {
      setStatus(c.nativeRequired);
      return;
    }
    setChecking(true);
    try {
      const response = await nativeApi.request<TectonicRuntimeReceipt>(
        "GET",
        "/v1/system/latex-runtime",
      );
      if (response.status !== 200) throw new Error("runtime status rejected");
      setRuntime(response.body);
      setStatus(response.body.ready ? c.compilerInstalled : c.latexNotReady);
    } catch {
      setStatus(c.compilerError);
    } finally {
      setChecking(false);
    }
  }

  async function installRuntime() {
    if (!nativeApi.available || installing) {
      setStatus(c.nativeRequired);
      return;
    }
    const version = runtime?.version ?? "0.16.9";
    if (!window.confirm(c.compilerConfirm.replace("{{version}}", version))) return;
    setInstalling(true);
    setStatus(c.installingCompiler);
    try {
      const response = await nativeApi.request<TectonicRuntimeReceipt>(
        "POST",
        "/v1/system/latex-runtime",
        { confirmed: true },
      );
      if (response.status !== 200 || !response.body.ready) throw new Error("runtime install rejected");
      setRuntime(response.body);
      setStatus(c.compilerInstalled);
    } catch {
      setStatus(c.compilerError);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.citeHelp}</p>
      <label className="lh-field"><span>{c.citation}</span><select value={settings.citation} onChange={(event) => update("citation", event.target.value)}><option value="apa-7">APA 7</option><option value="ieee">IEEE</option><option value="chicago-author-date">Chicago author–date</option><option value="mla-9">MLA 9</option><option value="vancouver">Vancouver</option><option value="harvard-cite-them-right">Harvard Cite Them Right</option></select></label>
      <details className="lh-settings-disclosure lh-compiler-disclosure">
        <summary>{c.latexRuntime}</summary>
        <section className="lh-model-recommendation" aria-labelledby="latex-runtime-status">
          <div>
            <h3 id="latex-runtime-status">{runtime?.ready ? c.latexReady : c.latexNotReady}</h3>
            <p>{c.compilerCaveat}</p>
            {runtime?.archive_sha256 && <small>Tectonic {runtime.version} · SHA-256 {runtime.archive_sha256.slice(0, 16)}…{runtime.emulated ? " · x64 emulation" : ""}</small>}
          </div>
          <FileCheck2 aria-hidden="true" size={30} />
        </section>
        <div className="lh-inline-actions">
          <button className="button button-secondary" type="button" disabled={checking || installing} onClick={checkRuntime}>{c.checkCompiler}</button>
          {!runtime?.ready && <button className="button button-primary" type="button" disabled={checking || installing} onClick={installRuntime}>{installing ? c.installingCompiler : c.installCompiler}</button>}
        </div>
      </details>
    </div>
  );
}

function AppearanceSettings({ c }: { c: SettingsCopy }) {
  return <div className="lh-settings-content"><p className="lh-section-help">{c.appearanceHelp}</p><div className="lh-appearance-link"><span aria-hidden="true">Aa</span><div><h3>{c.appearanceSummary}</h3><p>EB Garamond · Source Sans 3 · light / dark / system · full / reduced / off</p></div><Link className="button button-secondary" to="/settings/appearance">{c.appearanceLink}<ExternalLink aria-hidden="true" size={16} /></Link></div></div>;
}

function StorageSettings({ c }: { c: SettingsCopy }) {
  const [paths, setPaths] = useState<NativePaths | null>(null);
  const [pathError, setPathError] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [relocationReceipt, setRelocationReceipt] = useState<NativeVaultRelocationReceipt | null>(null);
  const [relocationStatus, setRelocationStatus] = useState("");

  useEffect(() => {
    if (!nativeApi.available) return;
    let active = true;
    void nativeApi.paths().then((value) => active && setPaths(value)).catch(() => active && setPathError(true));
    return () => { active = false; };
  }, []);

  async function relocateVault() {
    if (!nativeApi.available || relocating || relocationReceipt) return;
    setRelocating(true);
    setRelocationStatus(c.relocatingVault);
    try {
      const result = await nativeApi.prepareVaultRelocation();
      if (result.status === "cancelled") {
        setRelocationStatus(c.relocationCancelled);
        return;
      }
      setRelocationReceipt(result.receipt);
      setRelocationStatus(c.relocationVerified);
    } catch {
      setRelocationStatus(c.relocationFailed);
    } finally {
      setRelocating(false);
    }
  }

  async function restart() {
    if (!relocationReceipt) return;
    setRelocationStatus(c.restartRequired);
    try {
      await nativeApi.restartAfterVaultRelocation();
    } catch {
      setRelocationStatus(c.relocationFailed);
    }
  }

  return (
    <div className="lh-settings-content">
      <p className="lh-section-help">{c.storageHelp}</p>
      <dl className="lh-storage-facts">
        <div><dt>{c.vaultPath}</dt><dd>{paths?.vault ?? c.vaultUnavailable}</dd></div>
        <div><dt>{c.verifyOpen}</dt><dd><ShieldCheck aria-hidden="true" size={16} />{c.enforced}</dd></div>
        <div><dt>{c.encryptSecrets}</dt><dd><LockKeyhole aria-hidden="true" size={16} />{c.credentialManaged}</dd></div>
      </dl>
      {pathError && <p className="lh-settings-state is-error" role="alert">{c.vaultUnavailable}</p>}
      <details className="lh-settings-disclosure lh-storage-relocation-slot">
        <summary>{c.relocationTitle}</summary>
        <p>{c.relocation}</p>
        {!nativeApi.available ? <p>{c.relocationPending}</p> : (
          <>
            {!relocationReceipt && <button className="button button-secondary" type="button" disabled={relocating} onClick={() => void relocateVault()}><Database aria-hidden="true" size={17} />{relocating ? c.relocatingVault : c.relocateVault}</button>}
            {relocationReceipt && (
              <div className="lh-vault-relocation-receipt">
                <p><FileCheck2 aria-hidden="true" size={18} /><strong>{c.relocationVerified}</strong></p>
                <dl>
                  <div><dt>{c.destinationVault}</dt><dd>{relocationReceipt.destination_root}</dd></div>
                  <div><dt>{c.filesVerified}</dt><dd>{relocationReceipt.files_verified.toLocaleString()}</dd></div>
                  <div><dt>{c.bytesVerified}</dt><dd>{relocationReceipt.bytes_verified.toLocaleString()}</dd></div>
                  <div><dt>{c.sourcePreserved}</dt><dd>{relocationReceipt.source_root}</dd></div>
                </dl>
                <p>{c.restartRequired}</p>
                <button className="button button-primary" type="button" onClick={() => void restart()}>{c.restartNow}</button>
              </div>
            )}
            <p role="status" aria-live="polite">{relocationStatus}</p>
          </>
        )}
      </details>
    </div>
  );
}

function UpdateSettings({ c, settings, update, setStatus }: { c: SettingsCopy; settings: LocalSettings; update: SettingsUpdate; setStatus: (status: string) => void }) {
  const [updateInfo, setUpdateInfo] = useState<NativeUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  async function checkForUpdate() {
    if (!nativeApi.available) {
      setStatus(c.updateStatus);
      return;
    }
    setChecking(true);
    setStatus(c.checkingUpdate);
    try {
      const result = await nativeApi.checkForUpdate();
      setUpdateInfo(result);
      setStatus(result.available ? c.updateAvailable : c.noUpdate);
    } catch {
      setStatus(c.updateError);
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    if (!updateInfo?.available || !updateInfo.version || installing) return;
    const approved = window.confirm(
      c.installConfirm.replace("{{version}}", updateInfo.version),
    );
    if (!approved) return;
    setInstalling(true);
    setStatus(c.installingUpdate);
    try {
      await nativeApi.installUpdate(updateInfo.version);
    } catch {
      setInstalling(false);
      setStatus(c.updateError);
    }
  }

  return <div className="lh-settings-content"><p className="lh-section-help">{c.updatesHelp}</p><p className="lh-info-strip"><DownloadCloud aria-hidden="true" size={17} /><b>{c.alphaChannel}</b></p><label className="lh-switch-row lh-wide-switch"><span><RefreshCw aria-hidden="true" size={17} /><b>{c.autoCheck}</b></span><input type="checkbox" role="switch" checked={settings.autoCheck} onChange={(event) => { update("autoCheck", event.target.checked); setAutoCheckEnabled(event.target.checked); }} /></label><p className="lh-safety-note"><ShieldCheck aria-hidden="true" size={18} /><span><b>{c.confirmInstall}</b><br /><small>Signature → release notes → confirmation → install</small></span></p>{updateInfo?.available && updateInfo.version && <section className="lh-update-card" aria-labelledby="available-update"><p className="eyebrow">{c.updateAvailable}</p><h3 id="available-update">Litehouse {updateInfo.version}</h3><dl><div><dt>{c.currentVersion}</dt><dd>{updateInfo.current_version}</dd></div><div><dt>{c.releaseVersion}</dt><dd>{updateInfo.version}</dd></div>{updateInfo.notes && <div><dt>{c.releaseNotes}</dt><dd>{updateInfo.notes}</dd></div>}{updateInfo.artifact_url && <div><dt>{c.artifact}</dt><dd><a href={updateInfo.artifact_url} target="_blank" rel="noreferrer">GitHub release <ExternalLink aria-hidden="true" size={14} /></a></dd></div>}</dl><button className="button button-primary" type="button" disabled={installing} onClick={install}><DownloadCloud aria-hidden="true" size={17} />{c.installUpdate}</button></section>}<button className="button button-secondary" type="button" disabled={checking || installing} onClick={checkForUpdate}><DownloadCloud aria-hidden="true" size={17} />{checking ? c.checkingUpdate : c.checkUpdate}</button></div>;
}

function DiagnosticSettings({ c, setStatus }: { c: SettingsCopy; setStatus: (status: string) => void }) {
  const platform = navigator.platform || "Unknown";
  const [paths, setPaths] = useState<NativePaths | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);

  async function refreshDiagnostics() {
    if (!nativeApi.available) {
      setStatus(c.nativeRequired);
      return;
    }
    try {
      const [nextPaths, health] = await Promise.all([
        nativeApi.paths(),
        nativeApi.request("GET", "/v1/health"),
      ]);
      setPaths(nextPaths);
      setApiReachable(health.status === 200);
      setStatus(c.diagnosticStatus);
    } catch {
      setApiReachable(false);
      setStatus(c.unavailable);
    }
  }

  async function copyDiagnostics() {
    const redacted = JSON.stringify({
      version: "0.1.0-alpha.1",
      platform,
      native: nativeApi.available,
      api_reachable: apiReachable,
      vault_configured: Boolean(paths?.vault),
      secrets: "redacted",
    }, null, 2);
    try {
      await navigator.clipboard.writeText(redacted);
      setStatus(c.diagnosticStatus);
    } catch {
      setStatus(c.unavailable);
    }
  }

  return <div className="lh-settings-content"><p className="lh-section-help">{c.diagnosticsHelp}</p><dl className="lh-diagnostics"><div><dt>{c.appVersion}</dt><dd>0.1.0-alpha.1</dd></div><div><dt>{c.platform}</dt><dd>{platform}</dd></div><div><dt>{c.api}</dt><dd><span className="lh-diagnostic-state pending">{apiReachable ? "■" : "◧"}</span> {apiReachable === null ? c.nativeRequired : apiReachable ? c.reachable : c.unavailable}</dd></div><div><dt>{c.vault}</dt><dd>{paths?.vault ?? c.nativeRequired}</dd></div><div><dt>{c.modelRuntime}</dt><dd><span className="lh-diagnostic-state pending">◧</span> {c.nativeRequired}</dd></div></dl><div className="lh-inline-actions"><button className="button button-secondary" type="button" onClick={refreshDiagnostics}><RefreshCw aria-hidden="true" size={17} />{c.refresh}</button><button className="button button-secondary" type="button" onClick={copyDiagnostics}>{c.copyDiagnostics}</button></div></div>;
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
