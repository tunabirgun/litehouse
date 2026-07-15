import type { Locale } from "./i18n";

export interface LocalizedText {
  en: string;
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
    disciplineLabel: { en: "Biomedicine" },
    title: {
      en: "Structure prediction expands from proteins to molecular interactions",
    },
    authors: "Abramson et al.",
    venue: "Nature · 2024",
    date: { en: "Indexed today" },
    studyType: { en: "Methods paper" },
    evidence: { en: "Full text inspected" },
    summary: {
      en: "A model update broadens the represented biomolecular classes and uses a different coordinate-generation approach.",
    },
    reason: {
      en: "Matches your watch for protein design and molecular interaction prediction.",
    },
    status: "new",
    relevance: 96,
    claimId: "C-001",
  },
  {
    id: "climate-budget",
    discipline: "climate",
    disciplineLabel: { en: "Climate science" },
    title: {
      en: "Annual indicators reconcile multiple estimates of human-driven warming",
    },
    authors: "Forster et al.",
    venue: "Earth System Science Data · 2024",
    date: { en: "Updated yesterday" },
    studyType: { en: "Indicator synthesis" },
    evidence: { en: "Open full text" },
    summary: {
      en: "The update assembles traceable estimates for emissions, forcing, warming and the remaining carbon budget.",
    },
    reason: {
      en: "Matches your watch for reproducible climate indicators and annual assessment updates.",
    },
    status: "new",
    relevance: 91,
    claimId: "C-002",
  },
  {
    id: "computing-calibration",
    discipline: "computing",
    disciplineLabel: { en: "Computer science" },
    title: {
      en: "Uncertainty calibration is evaluated under distribution shift",
    },
    authors: "Sample benchmark consortium",
    venue: "Demonstration record · 2026",
    date: { en: "Indexed today" },
    studyType: { en: "Benchmark fixture" },
    evidence: { en: "Abstract only" },
    summary: {
      en: "This fixture demonstrates how Litehouse marks evidence that is available only at abstract level.",
    },
    reason: {
      en: "Matches your methodological interest in model reliability.",
    },
    status: "new",
    relevance: 87,
    claimId: "C-003",
  },
  {
    id: "social-replication",
    discipline: "social",
    disciplineLabel: { en: "Social science" },
    title: {
      en: "A multisite replication record receives a corrected appendix",
    },
    authors: "Demonstration collaboration",
    venue: "Demonstration record · 2026",
    date: { en: "Correction indexed today" },
    studyType: { en: "Replication fixture" },
    evidence: { en: "Status cross-checked" },
    summary: {
      en: "The interface retains the record while making the corrected supplementary material impossible to miss.",
    },
    reason: {
      en: "Matches your watch for replication studies and publication-status changes.",
    },
    status: "correction",
    relevance: 83,
    claimId: "C-002",
  },
  {
    id: "astronomy-survey",
    discipline: "astronomy",
    disciplineLabel: { en: "Astronomy" },
    title: {
      en: "Survey data release documents calibration and selection effects",
    },
    authors: "Sample survey team",
    venue: "Demonstration record · 2026",
    date: { en: "Indexed two days ago" },
    studyType: { en: "Data release fixture" },
    evidence: { en: "Metadata verified" },
    summary: {
      en: "A sample data-release record foregrounds calibration scope, known selection effects and reuse conditions.",
    },
    reason: {
      en: "Matches your interest in open survey catalogues and reproducible pipelines.",
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
    },
    scope: { en: "Publisher full text" },
    locator: { en: "Abstract, sentence 2" },
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
    },
    scope: { en: "Publisher full text" },
    locator: { en: "Methods, model architecture" },
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
    },
    scope: { en: "Abstract and metadata only" },
    locator: { en: "Abstract, final sentence" },
    span: "more accurate than many previous specialized tools on our benchmarks",
    sourceTitle: "Accurate structure prediction of biomolecular interactions with AlphaFold 3",
    citation: "Abramson et al. · Nature · 2024",
    doi: "10.1038/s41586-024-07487-w",
    sourceUrl: "https://doi.org/10.1038/s41586-024-07487-w",
    hash: "63ad…aa09",
    crosscheck: "Crossref + OpenAlex · matched",
  },
];

export function localize(text: LocalizedText, _locale?: Locale) {
  return text.en;
}
