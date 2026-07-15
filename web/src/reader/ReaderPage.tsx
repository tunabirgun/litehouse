import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileQuestion,
  Files,
  Highlighter,
  ListTree,
  RotateCw,
  Save,
  Search,
  ShieldCheck,
  StickyNote,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { useI18n } from "../i18n";
import { nativeApi } from "../native";
import {
  annotationsToJson,
  annotationsToMarkdown,
  createAnnotation,
} from "./anchors";
import { createDemoPdf } from "./demoPdf";
import { PdfSurface, PdfThumbnail } from "./PdfSurface";
import { loadAnnotations, loadProgress, saveAnnotations, saveProgress } from "./storage";
import type {
  ReaderAnnotation,
  ReaderDocumentRecord,
  ReaderFitMode,
  ReaderLoadState,
  ReaderOutlineEntry,
  ReaderProgress,
  ReaderSearchResult,
  TextQuoteAnchor,
} from "./types";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DEMO_SHA256 = "652af05f7e4b2250527d86bc34f611d4b9acc138e0633079b3401504701facc6";
const MAX_LOCAL_PDF_BYTES = 100 * 1024 * 1024;

const demoRecord: ReaderDocumentRecord = {
  id: "litehouse-reader-demonstration",
  title: "Reading evidence, not summaries",
  authors: "Litehouse contributors",
  citation: "Litehouse contributors. (2026). Litehouse Reader Demonstration [Software fixture].",
  sourceUrl: "https://github.com/tunabirgun/litehouse",
  sourceLabel: "Litehouse open demonstration record",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sha256: DEMO_SHA256,
  byteLength: 3532,
  acquiredAt: "2026-07-15T07:30:00+03:00",
  acquisition: "Bundled fixture · parsed locally · no reader network requests",
};

interface VaultReaderReceipt {
  item: {
    id: string;
    title: string;
    added_at: string;
  };
  artifact: {
    id: string;
    library_item_id: string;
    kind: "article_pdf" | "report_pdf";
    media_type: "application/pdf";
    sha256: string;
    size: number;
    created_at: string;
    source: {
      name: string | null;
      url: string | null;
      license_expression: string | null;
      license_url: string | null;
    };
  };
}

const readerCopy = {
  en: {
    back: "Back to Today",
    eyebrow: "Library / saved article",
    demo: "Open demonstration PDF",
    local: "Open local PDF",
    localHelp: "The selected file remains on this device and is not uploaded.",
    page: "Page",
    previous: "Previous page",
    next: "Next page",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    fitWidth: "Fit width",
    fitPage: "Fit page",
    rotate: "Rotate clockwise",
    search: "Search document",
    searchPlaceholder: "Find words in this PDF…",
    result: "result",
    results: "results",
    noResults: "No matches in this document.",
    pages: "Pages",
    outline: "Outline",
    noOutline: "This PDF does not provide an outline.",
    document: "Evidence",
    notes: "Notes",
    sourceReceipt: "Source receipt",
    receiptDetails: "Source, license, and full integrity receipt",
    integrity: "Integrity",
    verified: "SHA-256 verified",
    checking: "Checking source bytes…",
    mismatch: "Source bytes do not match the recorded SHA-256.",
    source: "Source",
    license: "Reuse license",
    acquired: "Acquired",
    bytes: "Bytes",
    privacy: "Reading privacy",
    privacyText: "Rendering, search, progress, and notes run locally. Opening the source link is the only external action on this page.",
    selection: "Selected passage",
    highlight: "Highlight",
    addNote: "Add note",
    notePlaceholder: "Why does this passage matter?",
    saveNote: "Save anchored note",
    cancel: "Cancel",
    annotations: "Anchored annotations",
    noAnnotations: "Select article text to add a highlight or note.",
    delete: "Delete annotation",
    editNote: "Edit note",
    exportMd: "Export Markdown",
    exportJson: "Export JSON",
    save: "Save reading state",
    saved: "Reading position and annotations saved on this device.",
    unsaved: "Unsaved reader changes",
    progress: "Reading progress",
    missingTitle: "The PDF is not available",
    missingText: "The library record exists, but no readable local artifact is attached.",
    corruptTitle: "The PDF is corrupt or incomplete",
    corruptText: "Litehouse refused to render bytes that did not form a valid PDF. The original artifact was not modified.",
    unsupportedTitle: "This PDF is not supported",
    unsupportedText: "Encrypted, password-protected, oversized, or unsupported PDFs must be converted or unlocked by their owner before reading.",
    retry: "Return to the verified fixture",
    loading: "Opening PDF in the local sandbox…",
    selectedFirst: "Select text on the current page before adding an annotation.",
    fileTooLarge: "The local PDF exceeds the 100 MiB reader limit.",
    fileInvalid: "The selected file does not have a valid PDF header.",
    localLicense: "License not recorded",
    vaultSource: "Local Litehouse vault",
    vaultAcquisition: "Verified vault artifact · authenticated loopback session · no external reader requests",
    vaultMetadataInvalid: "The local vault returned inconsistent PDF metadata.",
    removeSelection: "Dismiss selection",
    current: "Current search result",
    contextMenuFailed: "The native selection menu could not be opened.",
  },
  tr: {
    back: "Bugün'e dön",
    eyebrow: "Kütüphane / kayıtlı makale",
    demo: "Açık gösterim PDF'i",
    local: "Yerel PDF aç",
    localHelp: "Seçilen dosya bu cihazda kalır ve yüklenmez.",
    page: "Sayfa",
    previous: "Önceki sayfa",
    next: "Sonraki sayfa",
    zoomOut: "Uzaklaştır",
    zoomIn: "Yakınlaştır",
    fitWidth: "Genişliğe sığdır",
    fitPage: "Sayfaya sığdır",
    rotate: "Saat yönünde döndür",
    search: "Belgede ara",
    searchPlaceholder: "Bu PDF'de sözcük bul…",
    result: "sonuç",
    results: "sonuç",
    noResults: "Bu belgede eşleşme yok.",
    pages: "Sayfalar",
    outline: "İçindekiler",
    noOutline: "Bu PDF bir içindekiler yapısı sunmuyor.",
    document: "Kanıt",
    notes: "Notlar",
    sourceReceipt: "Kaynak makbuzu",
    receiptDetails: "Kaynak, lisans ve tam bütünlük makbuzu",
    integrity: "Bütünlük",
    verified: "SHA-256 doğrulandı",
    checking: "Kaynak baytları denetleniyor…",
    mismatch: "Kaynak baytları kayıtlı SHA-256 ile eşleşmiyor.",
    source: "Kaynak",
    license: "Yeniden kullanım lisansı",
    acquired: "Edinme zamanı",
    bytes: "Bayt",
    privacy: "Okuma gizliliği",
    privacyText: "Görüntüleme, arama, ilerleme ve notlar yerel çalışır. Kaynak bağlantısını açmak bu sayfadaki tek dış eylemdir.",
    selection: "Seçili bölüm",
    highlight: "Vurgula",
    addNote: "Not ekle",
    notePlaceholder: "Bu bölüm neden önemli?",
    saveNote: "Bağlantılı notu kaydet",
    cancel: "İptal",
    annotations: "Bağlantılı ek açıklamalar",
    noAnnotations: "Vurgu veya not eklemek için makale metnini seçin.",
    delete: "Ek açıklamayı sil",
    editNote: "Notu düzenle",
    exportMd: "Markdown aktar",
    exportJson: "JSON aktar",
    save: "Okuma durumunu kaydet",
    saved: "Okuma konumu ve notlar bu cihaza kaydedildi.",
    unsaved: "Kaydedilmemiş okuyucu değişiklikleri",
    progress: "Okuma ilerlemesi",
    missingTitle: "PDF kullanılamıyor",
    missingText: "Kütüphane kaydı var, ancak okunabilir yerel bir dosya eklenmemiş.",
    corruptTitle: "PDF bozuk veya eksik",
    corruptText: "Litehouse geçerli PDF oluşturmayan baytları görüntülemeyi reddetti. Asıl dosya değiştirilmedi.",
    unsupportedTitle: "Bu PDF desteklenmiyor",
    unsupportedText: "Şifreli, parola korumalı, aşırı büyük veya desteklenmeyen PDF'ler sahibi tarafından dönüştürülmeli ya da açılmalıdır.",
    retry: "Doğrulanmış örneğe dön",
    loading: "PDF yerel korumalı alanda açılıyor…",
    selectedFirst: "Ek açıklama eklemeden önce geçerli sayfada metin seçin.",
    fileTooLarge: "Yerel PDF 100 MiB okuyucu sınırını aşıyor.",
    fileInvalid: "Seçilen dosyanın geçerli bir PDF üstbilgisi yok.",
    localLicense: "Lisans kaydedilmemiş",
    vaultSource: "Yerel Litehouse kasası",
    vaultAcquisition: "Doğrulanmış kasa dosyası · kimlik doğrulamalı yerel oturum · dış okuyucu isteği yok",
    vaultMetadataInvalid: "Yerel kasa tutarsız PDF üstverisi döndürdü.",
    removeSelection: "Seçimi kapat",
    current: "Geçerli arama sonucu",
    contextMenuFailed: "Yerel seçim menüsü açılamadı.",
  },
} as const;

function isPdfHeader(bytes: Uint8Array): boolean {
  return new TextDecoder("ascii").decode(bytes.slice(0, 5)) === "%PDF-";
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isVaultReaderReceipt(value: unknown, itemId: string): value is VaultReaderReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<VaultReaderReceipt>;
  const item = receipt.item;
  const artifact = receipt.artifact;
  return Boolean(
    item && artifact && artifact.source &&
    item.id === itemId &&
    typeof item.title === "string" && item.title.trim() &&
    typeof item.added_at === "string" && Number.isFinite(Date.parse(item.added_at)) &&
    artifact.library_item_id === itemId &&
    isOpaqueId(artifact.id) &&
    (artifact.kind === "article_pdf" || artifact.kind === "report_pdf") &&
    artifact.media_type === "application/pdf" &&
    /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.size) && artifact.size >= 5 &&
    typeof artifact.created_at === "string" && Number.isFinite(Date.parse(artifact.created_at)) &&
    [artifact.source.name, artifact.source.url, artifact.source.license_expression, artifact.source.license_url]
      .every((entry) => entry === null || typeof entry === "string")
  );
}

function rawIpcBytes(value: unknown): Uint8Array {
  if (value && typeof value === "object") {
    try {
      const buffer = ArrayBuffer.prototype.slice.call(value, 0) as ArrayBuffer;
      return new Uint8Array(buffer);
    } catch {
      // Continue to the typed-array brand check.
    }
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
    if (view.BYTES_PER_ELEMENT === 1) {
      return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
  }
  throw new Error("The native PDF command returned a non-binary response.");
}

function safeExternalUrl(value: string | null): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await window.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function textFromItems(items: readonly unknown[]): string {
  return items.flatMap((item) =>
    item && typeof item === "object" && "str" in item && typeof item.str === "string"
      ? [item.str]
      : [],
  ).join(" ");
}

function searchDocument(pageTexts: readonly string[], rawQuery: string): ReaderSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  return pageTexts.flatMap((text, pageIndex) => {
    const haystack = text.toLocaleLowerCase();
    const matches: ReaderSearchResult[] = [];
    let from = 0;
    while (from < haystack.length) {
      const start = haystack.indexOf(query, from);
      if (start < 0) break;
      const end = start + query.length;
      const snippetStart = Math.max(0, start - 45);
      const snippetEnd = Math.min(text.length, end + 65);
      matches.push({
        id: `${pageIndex + 1}:${start}:${end}`,
        page: pageIndex + 1,
        start,
        end,
        snippet: `${snippetStart ? "…" : ""}${text.slice(snippetStart, snippetEnd)}${snippetEnd < text.length ? "…" : ""}`,
      });
      from = Math.max(end, start + 1);
    }
    return matches;
  });
}

function downloadText(filename: string, mime: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function progressSnapshot(
  page: number,
  zoom: number,
  fitMode: ReaderFitMode,
  rotation: 0 | 90 | 180 | 270,
): ReaderProgress {
  return { page, zoom, fitMode, rotation, savedAt: new Date().toISOString() };
}

function fitZoom(
  fitMode: ReaderFitMode,
  customZoom: number,
  availableWidth: number,
  rotation: 0 | 90 | 180 | 270,
): number {
  if (fitMode === "custom") return customZoom;
  const baseWidth = rotation % 180 === 0 ? 612 : 792;
  const baseHeight = rotation % 180 === 0 ? 792 : 612;
  const byWidth = Math.max(0.45, Math.min(2.4, (availableWidth - 48) / baseWidth));
  if (fitMode === "width") return byWidth;
  const byHeight = Math.max(0.45, Math.min(2.4, (window.innerHeight - 248) / baseHeight));
  return Math.min(byWidth, byHeight);
}

export default function ReaderPage() {
  const { locale } = useI18n();
  const copy = readerCopy[locale];
  const { itemId = "demo" } = useParams<{ itemId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const forcedState = searchParams.get("state") as ReaderLoadState | null;
  const demoBytes = useMemo(() => createDemoPdf(), []);
  const fixtureMode = itemId === "demo" || !nativeApi.available;
  const [bytes, setBytes] = useState<Uint8Array | null>(
    fixtureMode && forcedState !== "missing" ? demoBytes : null,
  );
  const [record, setRecord] = useState<ReaderDocumentRecord>(demoRecord);
  const [loadState, setLoadState] = useState<ReaderLoadState>(
    forcedState === "missing" || forcedState === "unsupported" ? forcedState : "ready",
  );
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(loadState === "ready");
  const [artifactLoading, setArtifactLoading] = useState(!fixtureMode);
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const [outline, setOutline] = useState<ReaderOutlineEntry[]>([]);
  const restored = useMemo(() => loadProgress(record.sha256), [record.sha256]);
  const [page, setPage] = useState(restored?.page ?? 1);
  const [zoom, setZoom] = useState(restored?.zoom ?? 1);
  const [fitMode, setFitMode] = useState<ReaderFitMode>(restored?.fitMode ?? "width");
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(restored?.rotation ?? 0);
  const [availableWidth, setAvailableWidth] = useState(900);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [sideTab, setSideTab] = useState<"document" | "notes">("document");
  const [selectionAnchor, setSelectionAnchor] = useState<TextQuoteAnchor | null>(null);
  const [noteDraftOpen, setNoteDraftOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>(() =>
    loadAnnotations(record.sha256),
  );
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [integrity, setIntegrity] = useState<"checking" | "verified" | "mismatch">("checking");
  const readerViewport = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const effectiveZoom = fitZoom(fitMode, zoom, availableWidth, rotation);
  const results = useMemo(() => searchDocument(pageTexts, query), [pageTexts, query]);
  const activeSearchResult = results[activeResult] ?? null;
  const pageCount = pdfDocument?.numPages ?? 0;
  const progressPercent = pageCount ? Math.round((page / pageCount) * 100) : 0;

  useEffect(() => {
    const element = readerViewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (fixtureMode) {
      setArtifactLoading(false);
      setRecord(demoRecord);
      setStatus("");
      if (forcedState === "missing" || forcedState === "unsupported") {
        setBytes(null);
        setLoadState(forcedState);
        setLoading(false);
      } else {
        setBytes(demoBytes);
        setLoadState("ready");
      }
      return;
    }
    if (forcedState === "missing" || forcedState === "unsupported") {
      setArtifactLoading(false);
      setBytes(null);
      setLoadState(forcedState);
      setLoading(false);
      return;
    }
    setArtifactLoading(true);
    setBytes(null);
    setStatus("");
    setLoadState("ready");
    const load = async () => {
      if (!isOpaqueId(itemId)) throw new Error(copy.missingText);
      const metadata = await nativeApi.request<unknown>(
        "GET",
        `/v1/library/items/${encodeURIComponent(itemId)}/reader`,
      );
      if (metadata.status === 404) throw new Error(copy.missingText);
      if (metadata.status !== 200 || !isVaultReaderReceipt(metadata.body, itemId)) {
        throw new Error(copy.vaultMetadataInvalid);
      }
      const receipt = metadata.body;
      if (receipt.artifact.size > MAX_LOCAL_PDF_BYTES) throw new Error(copy.fileTooLarge);
      const pdfBytes = rawIpcBytes(await nativeApi.openLibraryPdf(receipt.artifact.id));
      if (pdfBytes.byteLength !== receipt.artifact.size) {
        throw new Error(copy.vaultMetadataInvalid);
      }
      if (!isPdfHeader(pdfBytes)) throw new Error(copy.fileInvalid);
      if (cancelled) return;
      const sourceLabel = receipt.artifact.source.name
        || receipt.artifact.source.url
        || copy.vaultSource;
      setRecord({
        id: receipt.artifact.id,
        title: receipt.item.title,
        authors: receipt.artifact.source.name || copy.vaultSource,
        citation: `${receipt.item.title} · ${receipt.artifact.kind.replaceAll("_", " ")}`,
        sourceUrl: safeExternalUrl(receipt.artifact.source.url),
        sourceLabel,
        license: receipt.artifact.source.license_expression || copy.localLicense,
        licenseUrl: safeExternalUrl(receipt.artifact.source.license_url),
        sha256: receipt.artifact.sha256,
        byteLength: receipt.artifact.size,
        acquiredAt: receipt.artifact.created_at,
        acquisition: copy.vaultAcquisition,
      });
      setLoading(true);
      setBytes(pdfBytes);
      setLoadState("ready");
    };
    void load().catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : copy.missingText;
      const nextState: ReaderLoadState = /100 MiB|supported PDF/i.test(message)
        ? "unsupported"
        : /SHA-256|integrity|receipt|metadata|valid PDF|PDF üstverisi/i.test(message)
          ? "corrupt"
          : "missing";
      setBytes(null);
      setLoading(false);
      setLoadState(nextState);
      setStatus(message);
    }).finally(() => {
      if (!cancelled) setArtifactLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    copy.fileInvalid,
    copy.fileTooLarge,
    copy.localLicense,
    copy.missingText,
    copy.vaultAcquisition,
    copy.vaultMetadataInvalid,
    copy.vaultSource,
    demoBytes,
    fixtureMode,
    forcedState,
    itemId,
  ]);

  useEffect(() => {
    if (!bytes) {
      setPdfDocument(null);
      setLoading(false);
      return;
    }
    if (forcedState === "unsupported") {
      setPdfDocument(null);
      setLoading(false);
      setLoadState("unsupported");
      return;
    }
    const sourceBytes = forcedState === "corrupt" ? new TextEncoder().encode("%PDF-1.7\ncorrupt") : bytes;
    const task = getDocument({
      data: sourceBytes.slice(),
      stopAtErrors: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      maxImageSize: 50_000_000,
    });
    let cancelled = false;
    setLoading(true);
    setPdfDocument(null);
    setPageTexts([]);
    setOutline([]);

    void task.promise.then(async (documentProxy) => {
      if (cancelled) return;
      const texts = await Promise.all(
        Array.from({ length: documentProxy.numPages }, async (_, index) => {
          const loadedPage = await documentProxy.getPage(index + 1);
          const text = textFromItems((await loadedPage.getTextContent()).items);
          loadedPage.cleanup();
          return text;
        }),
      );
      const pdfOutline = await documentProxy.getOutline();
      const entries = await Promise.all((pdfOutline ?? []).map(async (item) => {
        try {
          const destination = typeof item.dest === "string"
            ? await documentProxy.getDestination(item.dest)
            : item.dest;
          const target = Array.isArray(destination) ? destination[0] : null;
          const targetPage = typeof target === "number"
            ? target + 1
            : target && typeof target === "object"
              ? (await documentProxy.getPageIndex(target)) + 1
              : null;
          return { title: item.title, page: targetPage } satisfies ReaderOutlineEntry;
        } catch {
          return { title: item.title, page: null } satisfies ReaderOutlineEntry;
        }
      }));
      if (cancelled) return;
      setPdfDocument(documentProxy);
      setPageTexts(texts);
      setOutline(entries);
      setPage((current) => Math.max(1, Math.min(current, documentProxy.numPages)));
      setLoadState("ready");
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setPdfDocument(null);
      setLoading(false);
      setLoadState(error instanceof PasswordException ? "unsupported" : "corrupt");
      if (!(error instanceof InvalidPDFException) && !(error instanceof PasswordException)) {
        setStatus(error instanceof Error ? error.message : copy.corruptText);
      }
    });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes, copy.corruptText, forcedState]);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    setIntegrity("checking");
    void sha256(bytes).then((digest) => {
      if (!cancelled) setIntegrity(digest === record.sha256 ? "verified" : "mismatch");
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, record.sha256]);

  useEffect(() => {
    setAnnotations(loadAnnotations(record.sha256));
    const progress = loadProgress(record.sha256);
    setPage(progress?.page ?? 1);
    setZoom(progress?.zoom ?? 1);
    setFitMode(progress?.fitMode ?? "width");
    setRotation(progress?.rotation ?? 0);
    setDirty(false);
  }, [record.sha256]);

  const goToPage = useCallback((candidate: number) => {
    if (!pdfDocument) return;
    setPage(Math.max(1, Math.min(candidate, pdfDocument.numPages)));
    setSelectionAnchor(null);
  }, [pdfDocument]);

  const changeZoom = useCallback((delta: number) => {
    setZoom(Math.max(0.4, Math.min(3.5, effectiveZoom + delta)));
    setFitMode("custom");
    setDirty(true);
  }, [effectiveZoom]);

  const saveReaderState = useCallback(() => {
    saveAnnotations(record.sha256, annotations);
    saveProgress(record.sha256, progressSnapshot(page, zoom, fitMode, rotation));
    setDirty(false);
    setStatus(copy.saved);
  }, [annotations, copy.saved, fitMode, page, record.sha256, rotation, zoom]);

  const exportNotes = useCallback((format: "markdown" | "json") => {
    const safeName = record.title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (format === "markdown") {
      downloadText(
        `${safeName || "litehouse-notes"}.md`,
        "text/markdown",
        annotationsToMarkdown(record.title, record.citation, record.sha256, annotations),
      );
      return;
    }
    downloadText(
      `${safeName || "litehouse-notes"}.json`,
      "application/json",
      annotationsToJson(record.title, record.citation, record.sha256, annotations),
    );
  }, [annotations, record]);

  useEffect(() => {
    function onReaderCommand(event: Event) {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id === "reader.search") {
        setSearchOpen(true);
        window.setTimeout(() => searchInput.current?.focus(), 0);
      } else if (id === "reader.nextPage") {
        goToPage(page + 1);
      } else if (id === "reader.previousPage") {
        goToPage(page - 1);
      } else if (id === "reader.addNote") {
        if (selectionAnchor) {
          setNoteDraftOpen(true);
          setSideTab("notes");
        } else {
          setStatus(copy.selectedFirst);
        }
      } else if (id === "reader.save") {
        saveReaderState();
      } else if (id === "reader.exportNotes") {
        exportNotes("markdown");
      }
    }
    window.addEventListener("litehouse:reader-command", onReaderCommand);
    return () => window.removeEventListener("litehouse:reader-command", onReaderCommand);
  }, [copy.selectedFirst, exportNotes, goToPage, page, saveReaderState, selectionAnchor]);

  useEffect(() => {
    if (!results.length) {
      setActiveResult(0);
      return;
    }
    setActiveResult((current) => Math.min(current, results.length - 1));
  }, [results.length]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  function selectSearchResult(index: number) {
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    setActiveResult(next);
    goToPage(results[next].page);
  }

  function addHighlight() {
    if (!selectionAnchor) return;
    const next = createAnnotation({
      documentSha256: record.sha256,
      kind: "highlight",
      anchor: selectionAnchor,
    });
    setAnnotations((current) => [...current.filter((item) => item.id !== next.id), next]);
    setDirty(true);
    setSelectionAnchor(null);
    window.getSelection()?.removeAllRanges();
  }

  function addNote() {
    if (!selectionAnchor) return;
    const next = createAnnotation({
      documentSha256: record.sha256,
      kind: "note",
      anchor: selectionAnchor,
      body: noteDraft,
    });
    setAnnotations((current) => [...current.filter((item) => item.id !== next.id), next]);
    setDirty(true);
    setNoteDraft("");
    setNoteDraftOpen(false);
    setSelectionAnchor(null);
    setSideTab("notes");
    window.getSelection()?.removeAllRanges();
  }

  function updateNote(id: string, body: string) {
    setAnnotations((current) => current.map((item) =>
      item.id === id ? { ...item, body, updatedAt: new Date().toISOString() } : item,
    ));
    setDirty(true);
  }

  function removeAnnotation(id: string) {
    setAnnotations((current) => current.filter((item) => item.id !== id));
    setDirty(true);
  }

  async function openLocalPdf(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_LOCAL_PDF_BYTES) {
      setStatus(copy.fileTooLarge);
      setLoadState("unsupported");
      setBytes(null);
      return;
    }
    const localBytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdfHeader(localBytes)) {
      setStatus(copy.fileInvalid);
      setLoadState("corrupt");
      setBytes(null);
      return;
    }
    const digest = await sha256(localBytes);
    setRecord({
      id: `local-${digest.slice(0, 12)}`,
      title: file.name.replace(/\.pdf$/i, ""),
      authors: "Local file",
      citation: `${file.name} · local artifact`,
      sourceUrl: "",
      sourceLabel: file.name,
      license: copy.localLicense,
      licenseUrl: "",
      sha256: digest,
      byteLength: file.size,
      acquiredAt: new Date(file.lastModified).toISOString(),
      acquisition: copy.localHelp,
    });
    setSearchParams({});
    setStatus("");
    setLoadState("ready");
    setBytes(localBytes);
  }

  function retryDemo() {
    setSearchParams({});
    setRecord(demoRecord);
    setBytes(createDemoPdf());
    setLoadState("ready");
    setStatus("");
  }

  if (artifactLoading) {
    return (
      <main id="main-content" className="page reader-route-loading" tabIndex={-1}>
        <p role="status">{copy.loading}</p>
      </main>
    );
  }

  if (loadState !== "ready" && !loading) {
    const stateContent = loadState === "missing"
      ? [copy.missingTitle, copy.missingText]
      : loadState === "unsupported"
        ? [copy.unsupportedTitle, copy.unsupportedText]
        : [copy.corruptTitle, copy.corruptText];
    return (
      <main id="main-content" className="page reader-error-page" tabIndex={-1}>
        <Link className="back-link" to="/today"><ChevronLeft aria-hidden="true" size={17} /> {copy.back}</Link>
        <section className="reader-error-state" role="alert" aria-labelledby="reader-error-title">
          {loadState === "missing" ? <FileQuestion aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
          <p className="eyebrow">Litehouse PDF reader</p>
          <h1 id="reader-error-title">{stateContent[0]}</h1>
          <p>{stateContent[1]}</p>
          {status && <p className="reader-error-detail">{status}</p>}
          <button className="button button-primary" type="button" onClick={retryDemo}>{copy.retry}</button>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" className="reader-page" tabIndex={-1}>
      <header className="reader-document-header">
        <div>
          <Link className="back-link" to="/today"><ChevronLeft aria-hidden="true" size={17} /> {copy.back}</Link>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{record.title}</h1>
          <p>{record.authors} · {record.license}</p>
        </div>
        <div className="reader-header-actions">
          <label className="button button-secondary reader-file-button" title={copy.localHelp}>
            <Upload aria-hidden="true" size={17} /> {copy.local}
            <input className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => void openLocalPdf(event)} />
          </label>
          <button className="button button-primary" type="button" onClick={saveReaderState}>
            <Save aria-hidden="true" size={17} /> {copy.save}
          </button>
        </div>
      </header>

      <div
        className="reader-progress"
        role="progressbar"
        aria-label={copy.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
      >
        <span style={{ width: `${progressPercent}%` }} />
      </div>

      <nav className="reader-toolbar" aria-label="PDF reader controls">
        <div className="reader-tool-group">
          <button type="button" title={copy.previous} aria-label={copy.previous} disabled={page <= 1} onClick={() => goToPage(page - 1)}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <label className="reader-page-input">
            <span>{copy.page}</span>
            <input
              aria-label={copy.page}
              type="number"
              min={1}
              max={Math.max(1, pageCount)}
              value={page}
              onChange={(event) => goToPage(Number(event.target.value))}
            />
            <span>/ {pageCount || "—"}</span>
          </label>
          <button type="button" title={copy.next} aria-label={copy.next} disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="reader-tool-group">
          <button type="button" title={copy.zoomOut} aria-label={copy.zoomOut} onClick={() => changeZoom(-0.15)}><ZoomOut aria-hidden="true" /></button>
          <span className="reader-zoom-value">{Math.round(effectiveZoom * 100)}%</span>
          <button type="button" title={copy.zoomIn} aria-label={copy.zoomIn} onClick={() => changeZoom(0.15)}><ZoomIn aria-hidden="true" /></button>
          <button className={fitMode === "width" ? "is-active" : ""} type="button" title={copy.fitWidth} aria-label={copy.fitWidth} aria-pressed={fitMode === "width"} onClick={() => setFitMode("width")}>↔</button>
          <button className={fitMode === "page" ? "is-active" : ""} type="button" title={copy.fitPage} aria-label={copy.fitPage} aria-pressed={fitMode === "page"} onClick={() => setFitMode("page")}>□</button>
          <button type="button" title={copy.rotate} aria-label={copy.rotate} onClick={() => {
            setRotation((current) => ((current + 90) % 360) as 0 | 90 | 180 | 270);
            setDirty(true);
          }}><RotateCw aria-hidden="true" /></button>
        </div>
        <div className="reader-tool-group reader-search-control">
          <button
            className={searchOpen ? "is-active" : ""}
            type="button"
            aria-expanded={searchOpen}
            aria-controls="reader-search-panel"
            title={copy.search}
            onClick={() => {
              setSearchOpen((current) => !current);
              window.setTimeout(() => searchInput.current?.focus(), 0);
            }}
          ><Search aria-hidden="true" /> <span>{copy.search}</span></button>
        </div>
      </nav>

      {searchOpen && (
        <section id="reader-search-panel" className="reader-search-panel" aria-label={copy.search}>
          <label>
            <Search aria-hidden="true" size={17} />
            <span className="sr-only">{copy.search}</span>
            <input ref={searchInput} type="search" value={query} placeholder={copy.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <span className="reader-search-count" aria-live="polite">
            {query ? `${results.length} ${results.length === 1 ? copy.result : copy.results}` : ""}
          </span>
          <button type="button" aria-label="Previous search result" disabled={!results.length} onClick={() => selectSearchResult(activeResult - 1)}><ChevronLeft aria-hidden="true" /></button>
          <button type="button" aria-label="Next search result" disabled={!results.length} onClick={() => selectSearchResult(activeResult + 1)}><ChevronRight aria-hidden="true" /></button>
          <button type="button" aria-label="Close document search" onClick={() => setSearchOpen(false)}><X aria-hidden="true" /></button>
          {query && !results.length && <p>{copy.noResults}</p>}
          {activeSearchResult && (
            <button className="reader-search-snippet" type="button" onClick={() => goToPage(activeSearchResult.page)}>
              <span>{copy.current} · {copy.page} {activeSearchResult.page}</span>
              {activeSearchResult.snippet}
            </button>
          )}
        </section>
      )}

      <div className="reader-workspace">
        <aside className="reader-left-rail" aria-label="Document navigation">
          <details className="reader-rail-disclosure">
            <summary id="reader-pages-title"><Files aria-hidden="true" size={15} /> <span>{copy.pages}</span><small>{page}/{pageCount || "—"}</small></summary>
            <div className="reader-thumbnails">
              {pdfDocument && Array.from({ length: pdfDocument.numPages }, (_, index) => (
                <PdfThumbnail
                  key={index + 1}
                  document={pdfDocument}
                  pageNumber={index + 1}
                  active={page === index + 1}
                  onSelect={() => goToPage(index + 1)}
                />
              ))}
            </div>
          </details>
          <details className="reader-rail-disclosure">
            <summary id="reader-outline-title"><ListTree aria-hidden="true" size={15} /> <span>{copy.outline}</span></summary>
            {outline.length ? (
              <ol className="reader-outline-list">
                {outline.map((entry, index) => (
                  <li key={`${entry.title}-${index}`}>
                    <button type="button" disabled={!entry.page} onClick={() => entry.page && goToPage(entry.page)}>{entry.title}</button>
                  </li>
                ))}
              </ol>
            ) : <p className="reader-muted">{copy.noOutline}</p>}
          </details>
        </aside>

        <section
          ref={readerViewport}
          className="reader-viewport"
          aria-label="PDF document viewport"
          tabIndex={0}
          onContextMenu={(event) => {
            if (!nativeApi.available || !selectionAnchor) return;
            event.preventDefault();
            void nativeApi.showContextMenu("reader-selection").catch(() => {
              setStatus(copy.contextMenuFailed);
            });
          }}
        >
          {loading && <div className="reader-loading" role="status">{copy.loading}</div>}
          {pdfDocument && (
            <PdfSurface
              document={pdfDocument}
              pageNumber={page}
              zoom={effectiveZoom}
              rotation={rotation}
              annotations={annotations}
              activeSearchText={activeSearchResult?.page === page ? query : ""}
              onSelection={(anchor) => {
                setSelectionAnchor(anchor);
                setNoteDraftOpen(false);
                setStatus("");
              }}
            />
          )}
        </section>

        <aside className="reader-right-rail" aria-label="Reading notes and source evidence">
          <div className="reader-side-tabs" role="tablist" aria-label="Reader details">
            <button role="tab" aria-selected={sideTab === "document"} type="button" onClick={() => setSideTab("document")}><ShieldCheck aria-hidden="true" /> {copy.document}</button>
            <button role="tab" aria-selected={sideTab === "notes"} type="button" onClick={() => setSideTab("notes")}><StickyNote aria-hidden="true" /> {copy.notes} <span>{annotations.length}</span></button>
          </div>
          {sideTab === "document" ? (
            <div className="reader-side-content" role="tabpanel">
              <h2>{copy.sourceReceipt}</h2>
              <div className={`reader-integrity ${integrity}`} role="status">
                {integrity === "verified" ? <Check aria-hidden="true" /> : integrity === "mismatch" ? <AlertTriangle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                <span><b>{copy.integrity}</b>{integrity === "verified" ? copy.verified : integrity === "mismatch" ? copy.mismatch : copy.checking}</span>
              </div>
              <details className="reader-receipt-details">
                <summary>{copy.receiptDetails}</summary>
                <dl className="reader-source-details">
                  <div><dt>{copy.source}</dt><dd>{record.sourceUrl ? <a href={record.sourceUrl} target="_blank" rel="noreferrer">{record.sourceLabel} <ExternalLink aria-hidden="true" size={13} /></a> : record.sourceLabel}</dd></div>
                  <div><dt>{copy.license}</dt><dd>{record.licenseUrl ? <a href={record.licenseUrl} target="_blank" rel="noreferrer">{record.license} <ExternalLink aria-hidden="true" size={13} /></a> : record.license}</dd></div>
                  <div><dt>SHA-256</dt><dd><code>{record.sha256}</code></dd></div>
                  <div><dt>{copy.bytes}</dt><dd>{record.byteLength.toLocaleString(locale)}</dd></div>
                  <div><dt>{copy.acquired}</dt><dd><time dateTime={record.acquiredAt}>{new Date(record.acquiredAt).toLocaleString(locale)}</time></dd></div>
                </dl>
                <p className="reader-acquisition">{record.acquisition}</p>
                <section className="reader-privacy-note">
                  <h3>{copy.privacy}</h3>
                  <p>{copy.privacyText}</p>
                </section>
              </details>
            </div>
          ) : (
            <div className="reader-side-content" role="tabpanel">
              <div className="reader-notes-heading">
                <h2>{copy.annotations}</h2>
                <span className={dirty ? "reader-dirty" : "reader-saved"}>{dirty ? copy.unsaved : copy.saved}</span>
              </div>
              <div className="reader-export-actions">
                <button type="button" onClick={() => exportNotes("markdown")}><Download aria-hidden="true" /> {copy.exportMd}</button>
                <button type="button" onClick={() => exportNotes("json")}><Download aria-hidden="true" /> {copy.exportJson}</button>
              </div>
              {annotations.length ? (
                <ol className="reader-annotation-list">
                  {annotations.map((annotation) => (
                    <li key={annotation.id}>
                      <button className="reader-annotation-anchor" type="button" onClick={() => goToPage(annotation.anchor.page)}>
                        <span>{annotation.kind === "highlight" ? <Highlighter aria-hidden="true" /> : <StickyNote aria-hidden="true" />} {copy.page} {annotation.anchor.page}</span>
                        <q>{annotation.anchor.exact}</q>
                      </button>
                      {annotation.kind === "note" && (
                        <label>
                          <span className="sr-only">{copy.editNote}</span>
                          <textarea value={annotation.body} aria-label={copy.editNote} onChange={(event) => updateNote(annotation.id, event.target.value)} />
                        </label>
                      )}
                      <button className="reader-delete-annotation" type="button" aria-label={copy.delete} onClick={() => removeAnnotation(annotation.id)}><X aria-hidden="true" /> {copy.delete}</button>
                    </li>
                  ))}
                </ol>
              ) : <p className="reader-muted">{copy.noAnnotations}</p>}
            </div>
          )}
        </aside>
      </div>

      {selectionAnchor && (
        <aside className="reader-selection-bar" aria-labelledby="reader-selection-title">
          <div>
            <p id="reader-selection-title">{copy.selection} · {copy.page} {selectionAnchor.page}</p>
            <q>{selectionAnchor.exact}</q>
          </div>
          {noteDraftOpen ? (
            <div className="reader-note-draft">
              <label><span className="sr-only">{copy.notePlaceholder}</span><textarea autoFocus value={noteDraft} placeholder={copy.notePlaceholder} onChange={(event) => setNoteDraft(event.target.value)} /></label>
              <button className="button button-primary" type="button" onClick={addNote}>{copy.saveNote}</button>
              <button className="button button-secondary" type="button" onClick={() => setNoteDraftOpen(false)}>{copy.cancel}</button>
            </div>
          ) : (
            <div className="reader-selection-actions">
              <button className="button button-secondary" type="button" onClick={addHighlight}><Highlighter aria-hidden="true" /> {copy.highlight}</button>
              <button className="button button-primary" type="button" onClick={() => {
                setNoteDraftOpen(true);
                setSideTab("notes");
              }}><StickyNote aria-hidden="true" /> {copy.addNote}</button>
              <button className="reader-dismiss-selection" type="button" aria-label={copy.removeSelection} onClick={() => setSelectionAnchor(null)}><X aria-hidden="true" /></button>
            </div>
          )}
        </aside>
      )}

      <div className="reader-live-status" role="status" aria-live="polite">{status}</div>
    </main>
  );
}
