import {
  BookMarked,
  Check,
  ChevronDown,
  Ellipsis,
  FileDown,
  FileText,
  Hash,
  Search,
  ShieldCheck,
  Tags,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  type IntegrityState,
  libraryFixtures,
  type LibraryExportArtifact,
  type LibraryItemFixture,
  type LibraryReadingState,
} from "./library-fixtures";
import { useI18n } from "./i18n";
import { nativeApi } from "./native";

interface VaultLibraryItemResponse {
  id: string;
  title: string;
  kind: string;
  added_at: string;
}

interface VaultArtifactResponse {
  id: string;
  kind: string;
  media_type: string;
  sha256: string;
}

interface OpenAccessAcquisitionResponse {
  item: VaultLibraryItemResponse;
  pdf_artifact: VaultArtifactResponse;
  receipt_artifact: VaultArtifactResponse;
  access_assertion: "open_access";
  access_evidence_url: string;
  reuse_license_expression: null;
  reuse_license_verified: false;
}

const copy = {
  en: {
    eyebrow: "Local research vault",
    title: "Library",
    lede: "Articles, books, reports, notes, and rendered reviews stay searchable with their source and integrity state.",
    fixture: "Demonstration records",
    fixtureHelp: "The records below test multidisciplinary library workflows. They are not the result of a live search in this session.",
    live: "Local vault records",
    liveHelp: "These records and hashes come from the authenticated local vault on this device.",
    loading: "Loading the local vault…",
    loadFailed: "The local vault could not be loaded. No demonstration records were substituted.",
    search: "Search title, author, venue, identifier, or tag",
    discipline: "Discipline",
    state: "Reading state",
    integrity: "Integrity",
    collection: "Collection",
    filters: "Filters",
    activeFilters: "{{count}} active",
    all: "All",
    unread: "Unread",
    reading: "Reading",
    read: "Read",
    verified: "SHA verified",
    changed: "File changed",
    metadataOnly: "Metadata only",
    results: "{{count}} library items",
    noResults: "No library items match these filters.",
    clear: "Clear filters",
    open: "Open",
    openReader: "Open in reader",
    openRecord: "Open evidence record",
    markRead: "Mark as read",
    markUnread: "Mark as unread",
    verify: "Verify SHA-256",
    export: "Export artifact",
    exportTitle: "Export {{title}}",
    exportIntro: "Choose one verified vault artifact. Every export is rehashed before the native save dialog opens.",
    exportClose: "Close export chooser",
    exportIntegrity: "SHA-256 receipt",
    reportPdf: "Rendered report · PDF",
    articlePdf: "Article · PDF",
    reportMarkdown: "Report · Markdown",
    reportText: "Report · plain text",
    reportLatex: "LaTeX source · TEX",
    cslJson: "References · CSL JSON",
    ris: "References · RIS",
    bibtex: "References · BibTeX",
    biblatex: "References · BibLaTeX",
    endnoteXml: "References · EndNote XML",
    exported: "Exported {{name}} after SHA-256 verification.",
    exportFailed: "The verified artifact could not be exported.",
    addCollection: "Add to collection",
    menu: "More actions for {{title}}",
    tags: "Tags",
    recordDetails: "Collection, tags, and integrity receipt",
    source: "Source",
    access: "Access",
    checked: "Integrity check completed for {{title}}.",
    noteOpen: "A verified or local full-text file opens in the reader. Abstract-only records open their evidence record.",
    openFull: "Open full text",
    abstractOnly: "Abstract only",
    localCopy: "Local copy",
    acquire: "Save open-access PDF",
    acquireTitle: "Save from an approved repository",
    acquireIntro: "Enter a repository identifier. Litehouse constructs the official address; arbitrary download URLs are never accepted.",
    provider: "Repository",
    recordTitle: "Article title",
    identifier: "Repository identifier",
    exactPath: "Canonical PMC OA PDF path",
    arxivHelp: "Example: 2607.01234 or hep-th/9901001v2",
    pmcHelp: "Use the exact path from the PMC Open Access file list, such as /pub/pmc/oa_pdf/ab/cd/file.PMC1234567.pdf.",
    acquisitionPolicy: "Only fixed arXiv and PMC hosts are allowed. Redirects are refused, the PDF is capped at 100 MiB, and its SHA-256 is verified before registration.",
    licenseCaveat: "Open-access evidence does not establish a reuse license. Litehouse records no license unless a separate license has been verified.",
    cancel: "Cancel",
    save: "Save verified PDF",
    saving: "Saving and verifying…",
    saved: "Verified PDF saved",
    savedDetail: "Receipt SHA-256",
    close: "Close",
    acquisitionFailed: "The repository PDF could not be saved. Check the canonical identifier and try again.",
  },
  tr: {
    eyebrow: "Yerel araştırma kasası",
    title: "Kütüphane",
    lede: "Makaleler, kitaplar, raporlar, notlar ve işlenmiş incelemeler; kaynak ve bütünlük durumlarıyla aranabilir kalır.",
    fixture: "Gösterim kayıtları",
    fixtureHelp: "Aşağıdaki kayıtlar çok alanlı kütüphane iş akışlarını sınar. Bu oturumdaki canlı taramanın sonucu değildir.",
    live: "Yerel kasa kayıtları",
    liveHelp: "Bu kayıtlar ve karma değerleri bu cihazdaki kimlik doğrulamalı yerel kasadan gelir.",
    loading: "Yerel kasa yükleniyor…",
    loadFailed: "Yerel kasa yüklenemedi. Yerine gösterim kayıtları konmadı.",
    search: "Başlık, yazar, yayın, tanımlayıcı veya etiket ara",
    discipline: "Alan",
    state: "Okuma durumu",
    integrity: "Bütünlük",
    collection: "Koleksiyon",
    filters: "Süzgeçler",
    activeFilters: "{{count}} etkin",
    all: "Tümü",
    unread: "Okunmadı",
    reading: "Okunuyor",
    read: "Okundu",
    verified: "SHA doğrulandı",
    changed: "Dosya değişti",
    metadataOnly: "Yalnızca üstveri",
    results: "{{count}} kütüphane kaydı",
    noResults: "Bu süzgeçlere uyan kütüphane kaydı yok.",
    clear: "Süzgeçleri temizle",
    open: "Aç",
    openReader: "Okuyucuda aç",
    openRecord: "Kanıt kaydını aç",
    markRead: "Okundu olarak işaretle",
    markUnread: "Okunmadı olarak işaretle",
    verify: "SHA-256 doğrula",
    export: "Dosyayı dışa aktar",
    exportTitle: "{{title}} öğesini dışa aktar",
    exportIntro: "Doğrulanmış kasa eserlerinden birini seçin. Yerel kaydetme penceresi açılmadan önce her dışa aktarım yeniden karmalanır.",
    exportClose: "Dışa aktarma seçicisini kapat",
    exportIntegrity: "SHA-256 makbuzu",
    reportPdf: "İşlenmiş rapor · PDF",
    articlePdf: "Makale · PDF",
    reportMarkdown: "Rapor · Markdown",
    reportText: "Rapor · düz metin",
    reportLatex: "LaTeX kaynağı · TEX",
    cslJson: "Kaynaklar · CSL JSON",
    ris: "Kaynaklar · RIS",
    bibtex: "Kaynaklar · BibTeX",
    biblatex: "Kaynaklar · BibLaTeX",
    endnoteXml: "Kaynaklar · EndNote XML",
    exported: "{{name}}, SHA-256 doğrulamasından sonra dışa aktarıldı.",
    exportFailed: "Doğrulanmış dosya dışa aktarılamadı.",
    addCollection: "Koleksiyona ekle",
    menu: "{{title}} için ek işlemler",
    tags: "Etiketler",
    recordDetails: "Koleksiyon, etiketler ve bütünlük makbuzu",
    source: "Kaynak",
    access: "Erişim",
    checked: "{{title}} için bütünlük denetimi tamamlandı.",
    noteOpen: "Doğrulanmış veya yerel tam metin okuyucuda açılır. Yalnızca-özet kayıtları kanıt kaydını açar.",
    openFull: "Açık tam metin",
    abstractOnly: "Yalnızca özet",
    localCopy: "Yerel kopya",
    acquire: "Açık erişimli PDF'yi kaydet",
    acquireTitle: "Onaylı bir depodan kaydet",
    acquireIntro: "Depo tanımlayıcısını girin. Litehouse resmi adresi oluşturur; rastgele indirme URL'leri hiçbir zaman kabul edilmez.",
    provider: "Depo",
    recordTitle: "Makale başlığı",
    identifier: "Depo tanımlayıcısı",
    exactPath: "Standart PMC açık erişim PDF yolu",
    arxivHelp: "Örnek: 2607.01234 veya hep-th/9901001v2",
    pmcHelp: "PMC Açık Erişim dosya listesindeki tam yolu kullanın; örneğin /pub/pmc/oa_pdf/ab/cd/file.PMC1234567.pdf.",
    acquisitionPolicy: "Yalnızca sabit arXiv ve PMC sunucularına izin verilir. Yönlendirmeler reddedilir, PDF 100 MiB ile sınırlıdır ve kayıttan önce SHA-256 doğrulanır.",
    licenseCaveat: "Açık erişim kanıtı yeniden kullanım lisansı oluşturmaz. Ayrı bir lisans doğrulanmadıkça Litehouse lisans kaydetmez.",
    cancel: "İptal",
    save: "Doğrulanmış PDF'yi kaydet",
    saving: "Kaydediliyor ve doğrulanıyor…",
    saved: "Doğrulanmış PDF kaydedildi",
    savedDetail: "Makbuz SHA-256",
    close: "Kapat",
    acquisitionFailed: "Depo PDF'si kaydedilemedi. Standart tanımlayıcıyı denetleyip yeniden deneyin.",
  },
} as const;

const disciplineLabels = {
  en: {
    arts: "Arts",
    humanities: "Humanities",
    "life-sciences": "Life sciences",
    "natural-sciences": "Natural sciences",
    "social-sciences": "Social sciences",
    technology: "Technology",
    interdisciplinary: "Interdisciplinary",
  },
  tr: {
    arts: "Sanat",
    humanities: "Beşeri bilimler",
    "life-sciences": "Yaşam bilimleri",
    "natural-sciences": "Doğa bilimleri",
    "social-sciences": "Sosyal bilimler",
    technology: "Teknoloji",
    interdisciplinary: "Disiplinlerarası",
  },
} as const;

type ContextMenuState = { itemId: string; x: number; y: number } | null;

const EXPORTABLE_ARTIFACT_MEDIA = new Map<string, ReadonlySet<string>>([
  ["article_pdf", new Set(["application/pdf"])],
  ["report_pdf", new Set(["application/pdf"])],
  ["report_markdown", new Set(["text/markdown"])],
  ["report_text", new Set(["text/plain"])],
  ["report_latex", new Set(["application/x-tex"])],
  ["reference_export", new Set([
    "application/vnd.citationstyles.csl+json",
    "application/x-research-info-systems",
    "application/x-bibtex",
    "application/x-biblatex",
    "application/xml",
  ])],
]);

function exportArtifactsFrom(receipts: readonly VaultArtifactResponse[]): LibraryExportArtifact[] {
  return receipts
    .filter((artifact) =>
      EXPORTABLE_ARTIFACT_MEDIA.get(artifact.kind)?.has(artifact.media_type)
      && /^[0-9a-f]{64}$/.test(artifact.sha256),
    )
    .map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      mediaType: artifact.media_type,
      sha256: artifact.sha256,
    }));
}

export function LibraryPage() {
  const { locale } = useI18n();
  const c = copy[locale];
  const searchRef = useRef<HTMLInputElement>(null);
  const acquisitionTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [discipline, setDiscipline] = useState("all");
  const [readingFilter, setReadingFilter] = useState("all");
  const [integrityFilter, setIntegrityFilter] = useState("all");
  const [collection, setCollection] = useState("all");
  const [readingStates, setReadingStates] = useState<Record<string, LibraryReadingState>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [status, setStatus] = useState("");
  const [acquisitionOpen, setAcquisitionOpen] = useState(false);
  const [exportItemId, setExportItemId] = useState<string | null>(null);
  const [items, setItems] = useState<readonly LibraryItemFixture[]>(
    nativeApi.available ? [] : libraryFixtures,
  );
  const [vaultState, setVaultState] = useState<"demo" | "loading" | "live" | "error">(
    nativeApi.available ? "loading" : "demo",
  );

  useEffect(() => {
    if (!nativeApi.available) return;
    let cancelled = false;
    void nativeApi.request<VaultLibraryItemResponse[]>("GET", "/v1/library/items?limit=200")
      .then(async (response) => {
        if (response.status !== 200) throw new Error("library list rejected");
        const records = await Promise.all(response.body.map(async (item) => {
          const artifacts = await nativeApi.request<VaultArtifactResponse[]>(
            "GET",
            `/v1/library/items/${encodeURIComponent(item.id)}/artifacts?limit=200`,
          );
          if (artifacts.status !== 200) throw new Error("artifact list rejected");
          const pdf = artifacts.body.find((artifact) =>
            artifact.media_type === "application/pdf" &&
            (artifact.kind === "article_pdf" || artifact.kind === "report_pdf"),
          );
          const exportArtifacts = exportArtifactsFrom(artifacts.body);
          const firstArtifact = pdf ?? artifacts.body[0];
          const year = new Date(item.added_at).getUTCFullYear();
          return {
            id: item.id,
            title: item.title,
            authors: "Litehouse vault",
            venue: item.kind.replaceAll("_", " "),
            year: Number.isFinite(year) ? year : new Date().getUTCFullYear(),
            discipline: "interdisciplinary" as const,
            kind: item.kind === "work" ? "article" as const : "report" as const,
            readingState: "unread" as const,
            integrity: "metadata-only" as const,
            access: pdf ? "local-copy" as const : "abstract-only" as const,
            tags: [item.kind],
            collection: "Local vault",
            identifier: `vault:${item.id}`,
            sha256: firstArtifact?.sha256,
            live: true,
            artifactId: pdf?.id,
            verificationArtifactId: firstArtifact?.id,
            exportArtifacts,
          } satisfies LibraryItemFixture;
        }));
        if (!cancelled) {
          setItems(records);
          setVaultState("live");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setVaultState("error");
          setStatus(c.loadFailed);
        }
      });
    return () => { cancelled = true; };
  }, [c.loadFailed]);

  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener("litehouse:library-search", focusSearch);
    return () => window.removeEventListener("litehouse:library-search", focusSearch);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(), 0);
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", close);
    };
  }, [contextMenu]);

  const collections = useMemo(() => [...new Set(items.map((item) => item.collection))].sort(), [items]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return items.filter((item) => {
      const state = readingStates[item.id] ?? item.readingState;
      const searchable = [item.title, item.authors, item.venue, item.identifier, ...item.tags]
        .join(" ")
        .toLocaleLowerCase(locale);
      return (
        (!needle || searchable.includes(needle)) &&
        (discipline === "all" || item.discipline === discipline) &&
        (readingFilter === "all" || state === readingFilter) &&
        (integrityFilter === "all" || item.integrity === integrityFilter) &&
        (collection === "all" || item.collection === collection)
      );
    });
  }, [collection, discipline, integrityFilter, items, locale, query, readingFilter, readingStates]);
  const activeFilterCount = [discipline, readingFilter, integrityFilter, collection]
    .filter((value) => value !== "all").length;

  function clearFilters() {
    setQuery("");
    setDiscipline("all");
    setReadingFilter("all");
    setIntegrityFilter("all");
    setCollection("all");
    searchRef.current?.focus();
  }

  function openMenu(itemId: string, x: number, y: number, trigger?: HTMLElement) {
    menuReturnFocus.current = trigger ?? null;
    setContextMenu({
      itemId,
      x: Math.min(x, window.innerWidth - 244),
      y: Math.min(y, window.innerHeight - 260),
    });
  }

  function closeMenu(restoreFocus = false) {
    const target = menuReturnFocus.current;
    setContextMenu(null);
    if (restoreFocus && target) window.setTimeout(() => target.focus(), 0);
  }

  function toggleRead(item: LibraryItemFixture) {
    const current = readingStates[item.id] ?? item.readingState;
    setReadingStates((states) => ({ ...states, [item.id]: current === "read" ? "unread" : "read" }));
    closeMenu();
  }

  async function verify(item: LibraryItemFixture) {
    if (item.live && item.verificationArtifactId && nativeApi.available) {
      try {
        const response = await nativeApi.request<{ status: "intact" | "changed" | "missing" }>(
          "POST",
          `/v1/library/artifacts/${encodeURIComponent(item.verificationArtifactId)}/verify`,
          {},
        );
        if (response.status !== 200) throw new Error("verification rejected");
        setItems((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, integrity: response.body.status === "intact" ? "verified" : "changed" }
          : candidate));
      } catch {
        setStatus(c.loadFailed);
        closeMenu();
        return;
      }
    }
    setStatus(c.checked.replace("{{title}}", item.title));
    closeMenu();
  }

  async function exportArtifact(item: LibraryItemFixture, artifact: LibraryExportArtifact, suggestedName: string) {
    if (!nativeApi.available || !item.live) {
      return;
    }
    try {
      const result = await nativeApi.exportLibraryArtifact(
        artifact.id,
        `${item.title}-${suggestedName}`,
      );
      setStatus(result.status === "saved"
        ? c.exported.replace("{{name}}", result.file_name)
        : "");
    } catch {
      setStatus(c.exportFailed);
    }
  }

  const contextItem = contextMenu ? items.find((item) => item.id === contextMenu.itemId) : undefined;
  const exportItem = exportItemId ? items.find((item) => item.id === exportItemId) : undefined;

  return (
    <main id="main-content" className="page lh-library-page" tabIndex={-1}>
      <header className="page-heading lh-workspace-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
        {nativeApi.available && (
          <button ref={acquisitionTriggerRef} className="button button-primary lh-acquire-trigger" type="button" onClick={() => setAcquisitionOpen(true)}>
            <FileDown aria-hidden="true" size={17} /> {c.acquire}
          </button>
        )}
      </header>
      <aside className="lh-fixture-notice" aria-labelledby="library-fixture-title">
        <BookMarked aria-hidden="true" size={19} />
        <div>
          <h2 id="library-fixture-title">{vaultState === "demo" ? c.fixture : c.live}</h2>
          <p>{vaultState === "demo" ? c.fixtureHelp : vaultState === "loading" ? c.loading : vaultState === "error" ? c.loadFailed : c.liveHelp}</p>
        </div>
      </aside>

      <section className="lh-library-tools" aria-label={locale === "en" ? "Library search and filters" : "Kütüphane arama ve süzgeçleri"}>
        <label className="lh-library-search"><Search aria-hidden="true" size={18} /><span className="sr-only">{c.search}</span><input ref={searchRef} type="search" placeholder={c.search} value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘/Ctrl F</kbd></label>
        <details className="lh-library-filter-disclosure">
          <summary>{c.filters}{activeFilterCount > 0 && <span>{c.activeFilters.replace("{{count}}", String(activeFilterCount))}</span>}</summary>
          <div className="lh-library-filters">
            <FilterSelect label={c.discipline} value={discipline} onChange={setDiscipline} options={Object.entries(disciplineLabels[locale])} allLabel={c.all} />
            <FilterSelect label={c.state} value={readingFilter} onChange={setReadingFilter} options={[["unread", c.unread], ["reading", c.reading], ["read", c.read]]} allLabel={c.all} />
            <FilterSelect label={c.integrity} value={integrityFilter} onChange={setIntegrityFilter} options={[["verified", c.verified], ["changed", c.changed], ["metadata-only", c.metadataOnly]]} allLabel={c.all} />
            <FilterSelect label={c.collection} value={collection} onChange={setCollection} options={collections.map((value) => [value, value])} allLabel={c.all} />
          </div>
        </details>
      </section>

      <div className="lh-result-heading">
        <p aria-live="polite">{c.results.replace("{{count}}", String(filtered.length))}</p>
        {(query || discipline !== "all" || readingFilter !== "all" || integrityFilter !== "all" || collection !== "all") && <button type="button" onClick={clearFilters}>{c.clear}</button>}
      </div>

      {filtered.length ? (
        <div className="lh-library-list">
          {filtered.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              state={readingStates[item.id] ?? item.readingState}
              locale={locale}
              c={c}
              onMenu={openMenu}
            />
          ))}
        </div>
      ) : (
        <div className="lh-empty-library"><Search aria-hidden="true" size={24} /><p>{c.noResults}</p><button className="button button-secondary" type="button" onClick={clearFilters}>{c.clear}</button></div>
      )}
      <p className="lh-reader-note"><FileText aria-hidden="true" size={17} /> {c.noteOpen}</p>
      {!exportItemId && <p className="sr-only" role="status" aria-live="polite">{status}</p>}

      {contextMenu && contextItem && (
        <div
          ref={menuRef}
          className="lh-context-menu"
          role="menu"
          aria-label={c.menu.replace("{{title}}", contextItem.title)}
          style={{ left: Math.max(8, contextMenu.x), top: Math.max(8, contextMenu.y) }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu(true);
            }
          }}
        >
          {contextItem.live && !contextItem.artifactId
            ? <button role="menuitem" type="button" disabled><FileText aria-hidden="true" size={16} />{c.openRecord}</button>
            : <Link role="menuitem" to={openPathFor(contextItem)}><FileText aria-hidden="true" size={16} />{contextItem.access === "abstract-only" ? c.openRecord : c.openReader}</Link>}
          {!contextItem.live && <button role="menuitem" type="button" onClick={() => toggleRead(contextItem)}><Check aria-hidden="true" size={16} />{(readingStates[contextItem.id] ?? contextItem.readingState) === "read" ? c.markUnread : c.markRead}</button>}
          <button role="menuitem" type="button" onClick={() => void verify(contextItem)} disabled={contextItem.live ? !contextItem.verificationArtifactId : !contextItem.sha256}><Hash aria-hidden="true" size={16} />{c.verify}</button>
          <button role="menuitem" type="button" disabled={!nativeApi.available || !contextItem.live || !contextItem.exportArtifacts?.length} onClick={() => { setStatus(""); setExportItemId(contextItem.id); closeMenu(); }}><FileDown aria-hidden="true" size={16} />{c.export}</button>
        </div>
      )}
      {exportItem?.exportArtifacts?.length && (
        <LibraryExportDialog
          c={c}
          item={exportItem}
          artifacts={exportItem.exportArtifacts}
          status={status}
          onExport={(artifact, suggestedName) => void exportArtifact(exportItem, artifact, suggestedName)}
          onClose={() => {
            setExportItemId(null);
            window.setTimeout(() => menuReturnFocus.current?.focus(), 0);
          }}
        />
      )}
      {acquisitionOpen && (
        <OpenAccessAcquisitionDialog
          c={c}
          onClose={() => {
            setAcquisitionOpen(false);
            window.setTimeout(() => acquisitionTriggerRef.current?.focus(), 0);
          }}
          onSaved={(response) => {
            const year = new Date(response.item.added_at).getUTCFullYear();
            setItems((current) => [{
              id: response.item.id,
              title: response.item.title,
              authors: "Litehouse vault",
              venue: "open-access import",
              year: Number.isFinite(year) ? year : new Date().getUTCFullYear(),
              discipline: "interdisciplinary",
              kind: "article",
              readingState: "unread",
              integrity: "verified",
              access: "local-copy",
              tags: ["open access", "verified PDF"],
              collection: "Local vault",
              identifier: `vault:${response.item.id}`,
              sha256: response.pdf_artifact.sha256,
              live: true,
              artifactId: response.pdf_artifact.id,
              verificationArtifactId: response.pdf_artifact.id,
              exportArtifacts: [{
                id: response.pdf_artifact.id,
                kind: response.pdf_artifact.kind,
                mediaType: response.pdf_artifact.media_type,
                sha256: response.pdf_artifact.sha256,
              }],
            }, ...current.filter((item) => item.id !== response.item.id)]);
            setVaultState("live");
          }}
        />
      )}
    </main>
  );
}

type LibraryCopy = (typeof copy)["en"] | (typeof copy)["tr"];

function artifactPresentation(
  artifact: LibraryExportArtifact,
  c: LibraryCopy,
): { label: string; suggestedName: string } {
  if (artifact.kind === "article_pdf") return { label: c.articlePdf, suggestedName: "article-pdf" };
  if (artifact.kind === "report_pdf") return { label: c.reportPdf, suggestedName: "report-pdf" };
  if (artifact.kind === "report_markdown") return { label: c.reportMarkdown, suggestedName: "report-markdown" };
  if (artifact.kind === "report_text") return { label: c.reportText, suggestedName: "report-text" };
  if (artifact.kind === "report_latex") return { label: c.reportLatex, suggestedName: "report-latex" };
  if (artifact.mediaType === "application/vnd.citationstyles.csl+json") return { label: c.cslJson, suggestedName: "references-csl-json" };
  if (artifact.mediaType === "application/x-research-info-systems") return { label: c.ris, suggestedName: "references-ris" };
  if (artifact.mediaType === "application/xml") return { label: c.endnoteXml, suggestedName: "references-endnote-xml" };
  if (artifact.mediaType === "application/x-biblatex") return { label: c.biblatex, suggestedName: "references-biblatex" };
  return { label: c.bibtex, suggestedName: "references-bibtex" };
}

function LibraryExportDialog({ c, item, artifacts, status, onExport, onClose }: { c: LibraryCopy; item: LibraryItemFixture; artifacts: readonly LibraryExportArtifact[]; status: string; onExport: (artifact: LibraryExportArtifact, suggestedName: string) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".lh-artifact-export-list button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop lh-library-export-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="lh-library-export-dialog" role="dialog" aria-modal="true" aria-labelledby="library-export-title" aria-describedby="library-export-intro">
        <header className="dialog-header">
          <div><p className="eyebrow">{c.export}</p><h2 id="library-export-title">{c.exportTitle.replace("{{title}}", item.title)}</h2></div>
          <button className="icon-button" type="button" aria-label={c.exportClose} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="lh-library-export-body">
          <p id="library-export-intro">{c.exportIntro}</p>
          <div className="lh-artifact-export-list">
            {artifacts.map((artifact) => {
              const presentation = artifactPresentation(artifact, c);
              return (
                <button key={artifact.id} type="button" onClick={() => onExport(artifact, presentation.suggestedName)}>
                  <FileDown aria-hidden="true" size={18} />
                  <span><b>{presentation.label}</b><small>{c.exportIntegrity}: <code>{artifact.sha256.slice(0, 16)}…</code></small></span>
                </button>
              );
            })}
          </div>
          <p className="lh-export-visible-status" role="status" aria-live="polite">{status}</p>
        </div>
      </div>
    </div>
  );
}

function OpenAccessAcquisitionDialog({
  c,
  onClose,
  onSaved,
}: {
  c: LibraryCopy;
  onClose: () => void;
  onSaved: (response: OpenAccessAcquisitionResponse) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<"arxiv" | "pmc">("arxiv");
  const [title, setTitle] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [exactPath, setExactPath] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<OpenAccessAcquisitionResponse | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && requestState !== "saving") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, requestState]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nativeApi.available || requestState === "saving") return;
    setRequestState("saving");
    setError("");
    try {
      const response = await nativeApi.request<OpenAccessAcquisitionResponse>(
        "POST",
        "/v1/library/open-access/acquisitions",
        {
          provider,
          repository_id: repositoryId.trim(),
          title: title.trim(),
          ...(provider === "pmc" ? { exact_pdf_path: exactPath.trim() } : {}),
        },
      );
      if (response.status !== 201) {
        const body = response.body as unknown as { detail?: { message?: string } | string };
        throw new Error(typeof body.detail === "string" ? body.detail : body.detail?.message);
      }
      setSaved(response.body);
      setRequestState("saved");
      onSaved(response.body);
    } catch (reason) {
      setRequestState("idle");
      setError(reason instanceof Error && reason.message ? reason.message : c.acquisitionFailed);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && requestState !== "saving") onClose();
    }}>
      <div ref={dialogRef} className="export-dialog lh-acquisition-dialog" role="dialog" aria-modal="true" aria-labelledby="oa-acquisition-title" aria-describedby="oa-acquisition-description">
        <header className="dialog-header">
          <div>
            <h2 id="oa-acquisition-title">{requestState === "saved" ? c.saved : c.acquireTitle}</h2>
            <p id="oa-acquisition-description">{c.acquireIntro}</p>
          </div>
          <button type="button" aria-label={c.close} disabled={requestState === "saving"} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {saved ? (
          <div className="lh-acquisition-success">
            <ShieldCheck aria-hidden="true" size={28} />
            <p><strong>{saved.item.title}</strong></p>
            <p>{c.savedDetail}<code>{saved.receipt_artifact.sha256}</code></p>
            <p>{c.licenseCaveat}</p>
          </div>
        ) : (
          <form className="lh-acquisition-form" onSubmit={(event) => void submit(event)}>
            <label><span>{c.provider}</span><select value={provider} onChange={(event) => {
              setProvider(event.target.value as "arxiv" | "pmc");
              setExactPath("");
              setError("");
            }}><option value="arxiv">arXiv</option><option value="pmc">PubMed Central (PMC)</option></select></label>
            <label><span>{c.recordTitle}</span><input ref={titleRef} required maxLength={1000} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>{c.identifier}</span><input aria-label={c.identifier} required maxLength={128} value={repositoryId} placeholder={provider === "arxiv" ? "2607.01234" : "PMC1234567"} onChange={(event) => setRepositoryId(event.target.value)} /><small>{provider === "arxiv" ? c.arxivHelp : c.pmcHelp}</small></label>
            {provider === "pmc" && <label><span>{c.exactPath}</span><input aria-label={c.exactPath} required maxLength={256} value={exactPath} placeholder="/pub/pmc/oa_pdf/ab/cd/file.PMC1234567.pdf" onChange={(event) => setExactPath(event.target.value)} /></label>}
            <div className="lh-acquisition-policy"><ShieldCheck aria-hidden="true" size={18} /><p>{c.acquisitionPolicy}<br />{c.licenseCaveat}</p></div>
            {error && <p className="lh-acquisition-error" role="alert">{error}</p>}
            <footer className="dialog-footer">
              <button className="button button-secondary" type="button" disabled={requestState === "saving"} onClick={onClose}>{c.cancel}</button>
              <button className="button button-primary" type="submit" disabled={requestState === "saving"}>{requestState === "saving" ? c.saving : c.save}</button>
            </footer>
          </form>
        )}
        {saved && <footer className="dialog-footer"><button className="button button-secondary" type="button" onClick={onClose}>{c.close}</button><Link className="button button-primary" to={`/library/${encodeURIComponent(saved.item.id)}/read`}>{c.openReader}</Link></footer>}
      </div>
    </div>
  );
}

function LibraryCard({ item, state, locale, c, onMenu }: { item: LibraryItemFixture; state: LibraryReadingState; locale: "en" | "tr"; c: LibraryCopy; onMenu: (id: string, x: number, y: number, trigger?: HTMLElement) => void }) {
  const openPath = openPathFor(item);
  const integrity = integrityLabel(item.integrity, c);
  const access = item.access === "open-full-text" ? c.openFull : item.access === "local-copy" ? c.localCopy : c.abstractOnly;
  return (
    <article
      className="lh-library-card"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(item.id, event.clientX, event.clientY);
      }}
    >
      <div className={`lh-integrity-rail ${item.integrity}`} aria-hidden="true" />
      <div className="lh-library-copy">
        <div className="lh-library-kickers"><span>{disciplineLabels[locale][item.discipline]}</span><span>{item.kind.replace("-", " ")}</span><span>{state === "unread" ? c.unread : state === "reading" ? c.reading : c.read}</span></div>
        <h2>{item.live && !item.artifactId ? item.title : <Link to={openPath}>{item.title}</Link>}</h2>
        <p className="lh-library-citation">{item.authors} · {item.venue} · {item.year}</p>
        <dl className="lh-library-meta">
          <div><dt><ShieldCheck aria-hidden="true" size={14} />{c.integrity}</dt><dd>{integrity}</dd></div>
          <div><dt><FileText aria-hidden="true" size={14} />{c.access}</dt><dd>{access}</dd></div>
        </dl>
        <details className="lh-library-record-details">
          <summary>{c.recordDetails}</summary>
          <dl className="lh-library-secondary-meta"><div><dt><BookMarked aria-hidden="true" size={14} />{c.collection}</dt><dd>{item.collection}</dd></div></dl>
          <div className="lh-tag-row" aria-label={c.tags}><Tags aria-hidden="true" size={14} />{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          <p className="lh-identifier"><code>{item.identifier}</code>{item.sha256 && <span>SHA-256 {item.sha256}</span>}</p>
        </details>
      </div>
      <div className="lh-library-actions">
        {item.live && !item.artifactId ? <button className="button button-secondary" type="button" disabled>{c.open}</button> : <Link className="button button-secondary" to={openPath}>{c.open}</Link>}
        <button type="button" aria-label={c.menu.replace("{{title}}", item.title)} aria-haspopup="menu" onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onMenu(item.id, bounds.right - 224, bounds.bottom + 5, event.currentTarget);
        }}><Ellipsis aria-hidden="true" size={20} /></button>
      </div>
    </article>
  );
}

function openPathFor(item: LibraryItemFixture) {
  if (item.live && item.artifactId) return `/library/${encodeURIComponent(item.id)}/read`;
  return item.access === "abstract-only" ? "/reports/demo" : "/library/demo/read";
}

function integrityLabel(state: IntegrityState, c: LibraryCopy) {
  if (state === "verified") return c.verified;
  if (state === "changed") return c.changed;
  return c.metadataOnly;
}

function FilterSelect({ label, value, onChange, options, allLabel }: { label: string; value: string; onChange: (value: string) => void; options: readonly (readonly [string, string])[]; allLabel: string }) {
  return (
    <label className="lh-filter-select"><span>{label}</span><span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">{allLabel}</option>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><ChevronDown aria-hidden="true" size={15} /></span></label>
  );
}
