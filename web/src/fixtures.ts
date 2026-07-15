import type { Locale } from "./i18n";

export interface LocalizedText {
  en: string;
  tr: string;
}

export interface DigestStudy {
  id: string;
  discipline: "biomedicine" | "climate" | "computing" | "social" | "astronomy";
  disciplineLabel: LocalizedText;
  title: LocalizedText;
  authors: string;
  venue: string;
  date: LocalizedText;
  studyType: LocalizedText;
  evidence: LocalizedText;
  summary: LocalizedText;
  reason: LocalizedText;
  status: "new" | "correction";
  relevance: number;
  claimId: string;
}

export interface ClaimFixture {
  id: string;
  status: "verified" | "limited";
  statement: LocalizedText;
  scope: LocalizedText;
  locator: LocalizedText;
  span: string;
  sourceTitle: string;
  citation: string;
  doi: string;
  sourceUrl: string;
  hash: string;
  crosscheck: string;
}

export const digestStudies: DigestStudy[] = [
  {
    id: "bio-structure",
    discipline: "biomedicine",
    disciplineLabel: { en: "Biomedicine", tr: "Biyotıp" },
    title: {
      en: "Structure prediction expands from proteins to molecular interactions",
      tr: "Yapı tahmini proteinlerden moleküler etkileşimlere genişliyor",
    },
    authors: "Abramson et al.",
    venue: "Nature · 2024",
    date: { en: "Indexed today", tr: "Bugün dizine eklendi" },
    studyType: { en: "Methods paper", tr: "Yöntem makalesi" },
    evidence: { en: "Full text inspected", tr: "Tam metin incelendi" },
    summary: {
      en: "A model update broadens the represented biomolecular classes and uses a different coordinate-generation approach.",
      tr: "Bir model güncellemesi temsil edilen biyomolekül sınıflarını genişletiyor ve farklı bir koordinat üretim yaklaşımı kullanıyor.",
    },
    reason: {
      en: "Matches your watch for protein design and molecular interaction prediction.",
      tr: "Protein tasarımı ve moleküler etkileşim tahmini izlemenizle eşleşiyor.",
    },
    status: "new",
    relevance: 96,
    claimId: "C-001",
  },
  {
    id: "climate-budget",
    discipline: "climate",
    disciplineLabel: { en: "Climate science", tr: "İklim bilimi" },
    title: {
      en: "Annual indicators reconcile multiple estimates of human-driven warming",
      tr: "Yıllık göstergeler insan kaynaklı ısınmanın birden çok tahminini uzlaştırıyor",
    },
    authors: "Forster et al.",
    venue: "Earth System Science Data · 2024",
    date: { en: "Updated yesterday", tr: "Dün güncellendi" },
    studyType: { en: "Indicator synthesis", tr: "Gösterge sentezi" },
    evidence: { en: "Open full text", tr: "Açık tam metin" },
    summary: {
      en: "The update assembles traceable estimates for emissions, forcing, warming and the remaining carbon budget.",
      tr: "Güncelleme; emisyonlar, zorlama, ısınma ve kalan karbon bütçesi için izlenebilir tahminleri bir araya getiriyor.",
    },
    reason: {
      en: "Matches your watch for reproducible climate indicators and annual assessment updates.",
      tr: "Yeniden üretilebilir iklim göstergeleri ve yıllık değerlendirme güncellemeleri izlemenizle eşleşiyor.",
    },
    status: "new",
    relevance: 91,
    claimId: "C-002",
  },
  {
    id: "computing-calibration",
    discipline: "computing",
    disciplineLabel: { en: "Computer science", tr: "Bilgisayar bilimi" },
    title: {
      en: "Uncertainty calibration is evaluated under distribution shift",
      tr: "Belirsizlik kalibrasyonu dağılım kayması altında değerlendiriliyor",
    },
    authors: "Sample benchmark consortium",
    venue: "Demonstration record · 2026",
    date: { en: "Indexed today", tr: "Bugün dizine eklendi" },
    studyType: { en: "Benchmark fixture", tr: "Kıyaslama örneği" },
    evidence: { en: "Abstract only", tr: "Yalnızca özet" },
    summary: {
      en: "This fixture demonstrates how Litehouse marks evidence that is available only at abstract level.",
      tr: "Bu örnek, Litehouse'ın yalnızca özet düzeyinde bulunan kanıtı nasıl işaretlediğini gösterir.",
    },
    reason: {
      en: "Matches your methodological interest in model reliability.",
      tr: "Model güvenilirliğine yönelik yöntemsel ilginizle eşleşiyor.",
    },
    status: "new",
    relevance: 87,
    claimId: "C-003",
  },
  {
    id: "social-replication",
    discipline: "social",
    disciplineLabel: { en: "Social science", tr: "Sosyal bilim" },
    title: {
      en: "A multisite replication record receives a corrected appendix",
      tr: "Çok merkezli bir tekrar çalışması kaydına düzeltilmiş ek eklendi",
    },
    authors: "Demonstration collaboration",
    venue: "Demonstration record · 2026",
    date: { en: "Correction indexed today", tr: "Düzeltme bugün dizine eklendi" },
    studyType: { en: "Replication fixture", tr: "Tekrar çalışması örneği" },
    evidence: { en: "Status cross-checked", tr: "Durum çapraz kontrol edildi" },
    summary: {
      en: "The interface retains the record while making the corrected supplementary material impossible to miss.",
      tr: "Arayüz kaydı korurken düzeltilmiş ek materyalin gözden kaçmasını önler.",
    },
    reason: {
      en: "Matches your watch for replication studies and publication-status changes.",
      tr: "Tekrar çalışmaları ve yayın durumu değişiklikleri izlemenizle eşleşiyor.",
    },
    status: "correction",
    relevance: 83,
    claimId: "C-002",
  },
  {
    id: "astronomy-survey",
    discipline: "astronomy",
    disciplineLabel: { en: "Astronomy", tr: "Astronomi" },
    title: {
      en: "Survey data release documents calibration and selection effects",
      tr: "Tarama veri sürümü kalibrasyon ve seçim etkilerini belgeliyor",
    },
    authors: "Sample survey team",
    venue: "Demonstration record · 2026",
    date: { en: "Indexed two days ago", tr: "İki gün önce dizine eklendi" },
    studyType: { en: "Data release fixture", tr: "Veri sürümü örneği" },
    evidence: { en: "Metadata verified", tr: "Üstveri doğrulandı" },
    summary: {
      en: "A sample data-release record foregrounds calibration scope, known selection effects and reuse conditions.",
      tr: "Örnek veri sürümü kaydı kalibrasyon kapsamını, bilinen seçim etkilerini ve yeniden kullanım koşullarını öne çıkarır.",
    },
    reason: {
      en: "Matches your interest in open survey catalogues and reproducible pipelines.",
      tr: "Açık tarama katalogları ve yeniden üretilebilir iş akışları ilginizle eşleşiyor.",
    },
    status: "new",
    relevance: 78,
    claimId: "C-003",
  },
];

export const claims: ClaimFixture[] = [
  {
    id: "C-001",
    status: "verified",
    statement: {
      en: "The represented model extends prediction to complexes that include proteins, nucleic acids, small molecules, ions and modified residues.",
      tr: "Temsil edilen model; proteinler, nükleik asitler, küçük moleküller, iyonlar ve değiştirilmiş kalıntılar içeren komplekslere tahmini genişletir.",
    },
    scope: { en: "Publisher full text", tr: "Yayıncı tam metni" },
    locator: { en: "Abstract, sentence 2", tr: "Özet, cümle 2" },
    span: "including proteins, nucleic acids, small molecules, ions, and modified residues",
    sourceTitle: "Accurate structure prediction of biomolecular interactions with AlphaFold 3",
    citation: "Abramson et al. · Nature · 2024",
    doi: "10.1038/s41586-024-07487-w",
    sourceUrl: "https://doi.org/10.1038/s41586-024-07487-w",
    hash: "9b1e…d42a",
    crosscheck: "Crossref + publisher · matched",
  },
  {
    id: "C-002",
    status: "verified",
    statement: {
      en: "The coordinate-generation stage uses a diffusion-based architecture rather than the earlier frame-based structure module.",
      tr: "Koordinat üretim aşaması, önceki çerçeve tabanlı yapı modülü yerine difüzyon tabanlı bir mimari kullanır.",
    },
    scope: { en: "Publisher full text", tr: "Yayıncı tam metni" },
    locator: { en: "Methods, model architecture", tr: "Yöntemler, model mimarisi" },
    span: "a diffusion module that operates directly over raw atom coordinates",
    sourceTitle: "Accurate structure prediction of biomolecular interactions with AlphaFold 3",
    citation: "Abramson et al. · Nature · 2024",
    doi: "10.1038/s41586-024-07487-w",
    sourceUrl: "https://doi.org/10.1038/s41586-024-07487-w",
    hash: "9b1e…d42a",
    crosscheck: "Crossref + publisher · matched",
  },
  {
    id: "C-003",
    status: "limited",
    statement: {
      en: "Reported benchmark improvements should be read as task-specific rather than universal performance guarantees.",
      tr: "Bildirilen kıyaslama iyileştirmeleri, evrensel başarım garantileri yerine göreve özgü sonuçlar olarak okunmalıdır.",
    },
    scope: { en: "Abstract and metadata only", tr: "Yalnızca özet ve üstveri" },
    locator: { en: "Abstract, final sentence", tr: "Özet, son cümle" },
    span: "more accurate than many previous specialized tools on our benchmarks",
    sourceTitle: "Accurate structure prediction of biomolecular interactions with AlphaFold 3",
    citation: "Abramson et al. · Nature · 2024",
    doi: "10.1038/s41586-024-07487-w",
    sourceUrl: "https://doi.org/10.1038/s41586-024-07487-w",
    hash: "63ad…aa09",
    crosscheck: "Crossref + OpenAlex · matched",
  },
];

export function localize(text: LocalizedText, locale: Locale) {
  return text[locale];
}
