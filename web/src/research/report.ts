import { digestCanonical, sha256Hex } from "./integrity";
import type {
  LiteratureRecord,
  LiteratureSearchResult,
  RetrievalBoundaryAudit,
  SourceReceipt,
} from "./types";

export interface GroundedReport {
  schema: "https://litehouse.pub/schemas/browser-report/v1";
  id: string;
  title: string;
  query: string;
  createdAt: string;
  markdown: string;
  records: LiteratureRecord[];
  requestSha256: string;
  retrievalSha256: string;
  reportSha256: string;
  synthesis: "deterministic" | "llm-validated";
  synthesisFailure?: string;
  sourceFailures: Array<{ source: string; errorCode: string }>;
  /** Present on browser reports generated after retrieval-boundary receipts were introduced. */
  boundaryAudit?: RetrievalBoundaryAudit;
  /** Immutable source response receipts included in the retrieval SHA-256. */
  retrievalReceipts?: SourceReceipt[];
}

export interface SynthesisValidation {
  valid: boolean;
  unknownCitations: string[];
  uncitedParagraphs: number[];
  unrecognizedDois: string[];
}

function sourceId(index: number): string {
  return `S${index + 1}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

// Reasoning models (Qwen3) emit a <think>…</think> block before the answer. Remove it so
// only the synthesis is validated and shown, and drop a stray unmatched tag if the opening
// or closing was cut off by the token limit.
function stripThinking(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/^[\s\S]*?<\/think>/iu, "")
    .replace(/<\/?think>/giu, "")
    .trim();
}

// Best-effort APA name formatting from heterogeneous scholarly metadata.
// Detects the input shape rather than blindly inverting:
//   "Congting Guo"        -> "Guo, C."      (given surname)
//   "Singh S" / "Singh HK"-> "Singh, S." / "Singh, H. K."  (already surname-first)
//   "Brewer, Mark Anthony"-> "Brewer, M. A." (surname, given)
//   "A, B, C" (>=2 commas) -> kept as-is (a multi-author string captured in one field)
function invertName(name: string): string {
  const clean = name.trim().replace(/\s+/gu, " ").replace(/\*+/gu, "");
  if (!clean) return "";
  const commas = (clean.match(/,/gu) ?? []).length;
  if (commas >= 2) return clean;
  if (commas === 1) {
    const [surname, given] = clean.split(",").map((part) => part.trim());
    if (!given) return surname;
    const initials = given.split(/\s+/u).map((g) => (g[0] ? `${g[0].toUpperCase()}.` : "")).filter(Boolean).join(" ");
    return initials ? `${surname}, ${initials}` : surname;
  }
  const parts = clean.split(" ");
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  if (/^[A-Z]{1,3}$/u.test(last)) {
    return `${parts.slice(0, -1).join(" ")}, ${last.split("").map((c) => `${c}.`).join(" ")}`;
  }
  const initials = parts.slice(0, -1).map((part) => (part[0] ? `${part[0].toUpperCase()}.` : "")).filter(Boolean).join(" ");
  return initials ? `${last}, ${initials}` : last;
}

// APA-7 author list: comma-separated, ampersand before the last, up to 20 names.
function apaAuthors(contributors: readonly string[]): string {
  const names = contributors.map(invertName).filter(Boolean);
  if (!names.length) return "Unknown author";
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
}

// One APA-7 reference, keyed by [S#] so synthesis citations resolve; no separate ordinal.
function recordCitation(record: LiteratureRecord, index: number): string {
  const authors = apaAuthors(record.contributors);
  const year = record.publicationDate?.slice(0, 4) ?? "n.d.";
  const title = record.title.replace(/\s*\.\s*$/u, "");
  const venue = record.venue ? ` *${escapeMarkdown(record.venue)}*.` : "";
  const doi = record.doi ? `https://doi.org/${record.doi}` : record.landingUrl;
  const url = doi ? ` ${doi}` : "";
  return `**[${sourceId(index)}]** ${escapeMarkdown(authors)} (${year}). ${escapeMarkdown(title)}.${venue}${url}`;
}

function accessTag(record: LiteratureRecord): string {
  if (record.openFullTextUrl) return "open access";
  if (record.abstract) return "abstract available";
  return "metadata only";
}

// Trim a source abstract to a clean excerpt: keep as many whole sentences as fit so the
// text ends on a full stop, not a mid-sentence ellipsis. Falls back to a word boundary
// (never mid-word) only when the first sentence alone is longer than the budget.
function excerpt(text: string, max = 320): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+(?=\s|$)/gu);
  if (sentences && sentences[0].trim().length <= max) {
    let out = "";
    for (const sentence of sentences) {
      const next = `${out} ${sentence}`.trim();
      if (out && next.length > max) break;
      out = next;
    }
    if (out.length >= 60) return out;
  }
  const wordEnd = clean.slice(0, max).lastIndexOf(" ");
  return `${clean.slice(0, wordEnd > 0 ? wordEnd : max).trim()}…`;
}

function deterministicSynthesis(records: LiteratureRecord[], query: string): string {
  if (!records.length) {
    return "No works passed the selected sources and retrieval boundaries, so no synthesis was produced. Widen the publication window, add sources, or allow paywalled metadata and abstracts, then run the search again.";
  }
  const shown = records.slice(0, 12);
  const lead = `Without a connected model, Litehouse lists the retrieved evidence rather than writing a synthesis. It accepted ${records.length} work${records.length === 1 ? "" : "s"} for “${query.trim()}”, ordered by topical relevance, cross-source corroboration, and citation signal; each is described only from its own bibliographic metadata and abstract. Connect a local model or API provider in Settings for an AI-written synthesis of these sources.`;
  const entries = shown.map((record, index) => {
    const authors = record.contributors.length ? apaAuthors(record.contributors) : "Unknown author";
    const year = record.publicationDate?.slice(0, 4) ?? "n.d.";
    const venue = record.venue ? `, *${escapeMarkdown(record.venue)}*` : "";
    const abstract = record.abstract
      ? ` ${escapeMarkdown(excerpt(record.abstract))}`
      : " No abstract was available from the source metadata.";
    return `- **${escapeMarkdown(record.title.replace(/\s*\.\s*$/u, ""))}** — ${escapeMarkdown(authors)} (${year})${venue}; ${accessTag(record)}.${abstract} [${sourceId(index)}]`;
  }).join("\n");
  const remaining = records.length - shown.length;
  const more = remaining > 0 ? `\n\n${remaining} further work${remaining === 1 ? " is" : "s are"} listed in the references below.` : "";
  return `${lead}\n\n${entries}${more}`;
}

function requestedValue(values: string[]): string {
  return values.length ? values.map(escapeMarkdown).join(", ") : "not requested";
}

function boundaryReceiptMarkdown(audit: RetrievalBoundaryAudit | undefined): string {
  if (!audit) return "Boundary audit metadata was not available for this legacy retrieval.";
  const { requested, postFilter } = audit;
  const date = requested.fromDate || requested.toDate
    ? `${requested.fromDate ?? "open start"} through ${requested.toDate ?? "open end"} (inclusive)`
    : "not requested";
  const removed = Object.entries(postFilter.removedByBoundary)
    .map(([boundary, count]) => `${boundary}: ${count}`)
    .join(", ") || "none";
  const sourceRows = audit.sourceApplications.map(({ source, filters }) => {
    const applications = filters.length
      ? filters.map(({ boundary, mode }) => `${boundary}=${mode}`).join("; ")
      : "no optional boundary requested";
    return `- ${source}: ${applications}`;
  });
  return [
    `- Publication interval: ${date}`,
    `- Open-access-only: ${requested.openAccessOnly ? "yes; a source-provided open-full-text URL was required" : "no"}`,
    `- Languages: ${requestedValue(requested.languages)}`,
    `- Disciplines: ${requestedValue(requested.disciplines)}`,
    `- Work types: ${requestedValue(requested.workTypes)}`,
    `- Literal exclusions: ${requestedValue(requested.exclusions)}`,
    `- Parsed / deduplicated / accepted: ${postFilter.parsedRecords} / ${postFilter.deduplicatedRecords} / ${postFilter.acceptedRecords}`,
    `- Removed at first failing boundary: ${removed}`,
    `- Retained without metadata — language: ${postFilter.retainedWithoutMetadata.language}; discipline: ${postFilter.retainedWithoutMetadata.discipline}; work type: ${postFilter.retainedWithoutMetadata.workType}`,
    "",
    "### Source filter application",
    "",
    ...sourceRows,
  ].join("\n");
}

// Cap the evidence sent to the model so the prompt fits a browser model's context window.
// The top-ranked sources keep [S1..] aligned with the reference list, which still lists all.
const SYNTHESIS_EVIDENCE_LIMIT = 15;
const SYNTHESIS_ABSTRACT_CHARS = 600;

export function synthesisPrompt(query: string, records: LiteratureRecord[]): string {
  const evidence = records.slice(0, SYNTHESIS_EVIDENCE_LIMIT).map((record, index) => ({
    id: sourceId(index),
    title: record.title,
    authors: record.contributors.slice(0, 8),
    date: record.publicationDate ?? null,
    venue: record.venue ?? null,
    abstract: record.abstract ? record.abstract.slice(0, SYNTHESIS_ABSTRACT_CHARS) : null,
    evidence_level: record.openFullTextUrl ? "open_full_text_link_identified" : record.abstract ? "abstract" : "metadata_only",
    doi: record.doi ?? null,
  }));
  return [
    "Write a literature-review synthesis in flowing prose paragraphs, using only the evidence JSON below.",
    "Do not restate source titles or list source ids on their own line; weave the findings into sentences.",
    "Every factual sentence ends with one or more citations like [S1] or [S1, S2].",
    "Never infer a result from a title or metadata alone. If an abstract is absent, note only bibliographic relevance.",
    "Do not introduce URLs, DOIs, authors, dates, or statistics absent from the JSON.",
    "Cover convergent findings, disagreements, and limitations across the sources. Do not add a heading, a title, or a reference list.",
    `Research query: ${query}`,
    `Evidence JSON: ${JSON.stringify(evidence)}`,
  ].join("\n\n");
}

export function validateGroundedSynthesis(text: string, records: LiteratureRecord[]): SynthesisValidation {
  const citationPattern = /\[(S\d+(?:\s*,\s*S\d+)*)\]/gu;
  const cited = [...text.matchAll(citationPattern)].flatMap((match) => match[1].split(",").map((value) => value.trim()));
  const allowed = new Set(records.map((_, index) => sourceId(index)));
  const unknownCitations = [...new Set(cited.filter((citation) => !allowed.has(citation)))];

  const uncitedParagraphs: number[] = [];
  let contentParagraphs = 0;
  text.split(/\n\s*\n/gu).forEach((paragraph, index) => {
    const normalized = paragraph.trim();
    if (!normalized || /^#{1,6}\s/u.test(normalized)) return;
    contentParagraphs += 1;
    if (!citationPattern.test(normalized)) uncitedParagraphs.push(index + 1);
    citationPattern.lastIndex = 0;
  });
  // A concluding or framing paragraph may summarize already-cited claims without its own
  // citation; allow a small minority rather than rejecting an otherwise-grounded synthesis.
  const uncitedAllowed = Math.max(1, Math.floor(contentParagraphs / 4));

  const allowedDois = new Set(records.map(({ doi }) => doi?.toLowerCase()).filter(Boolean));
  const foundDois = [...text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu)].map((match) => match[0].replace(/[.,;)]$/u, "").toLowerCase());
  const unrecognizedDois = [...new Set(foundDois.filter((candidate) => !allowedDois.has(candidate)))];

  return {
    valid: cited.length > 0 && unknownCitations.length === 0 && uncitedParagraphs.length <= uncitedAllowed && unrecognizedDois.length === 0,
    unknownCitations,
    uncitedParagraphs,
    unrecognizedDois,
  };
}

export async function createGroundedReport(input: {
  query: string;
  retrieval: LiteratureSearchResult;
  llmSynthesis?: string;
  synthesisFailure?: string;
}): Promise<GroundedReport> {
  const createdAt = new Date().toISOString();
  const cleanedSynthesis = input.llmSynthesis ? stripThinking(input.llmSynthesis) : undefined;
  const validated = cleanedSynthesis
    ? validateGroundedSynthesis(cleanedSynthesis, input.retrieval.records)
    : null;
  const synthesis = validated?.valid ? escapeMarkdown(cleanedSynthesis!.trim()) : deterministicSynthesis(input.retrieval.records, input.query);
  const sourceFailures = input.retrieval.receipts
    .filter(({ status }) => status === "rejected")
    .map(({ source, errorCode }) => ({ source, errorCode: errorCode ?? "unknown" }));
  const references = input.retrieval.records.map(recordCitation).join("\n\n");
  const limitations = [
    "- This report distinguishes metadata, abstract, and identified open-full-text availability; it does not treat a title as evidence of a result.",
    "- Citation counts are source metadata captured at retrieval time, not a universal measure of scientific quality.",
    input.retrieval.boundaryAudit && (input.retrieval.boundaryAudit.requested.fromDate || input.retrieval.boundaryAudit.requested.toDate)
      ? "- Publication dates were enforced after parsing for every source. Records with missing dates, or partial dates not wholly contained in the exact interval, were excluded."
      : "",
    input.retrieval.boundaryAudit?.requested.languages.length
      ? "- Language selection is metadata-bounded: known mismatches were removed, while records with no language metadata were retained and counted in the boundary receipt."
      : "",
    input.retrieval.boundaryAudit?.requested.disciplines.length || input.retrieval.boundaryAudit?.requested.workTypes.length
      ? "- Discipline and work-type selections use source filters where safely representable and normalized metadata afterward; unclassifiable records were retained and counted rather than silently guessed."
      : "",
    input.retrieval.boundaryAudit?.requested.exclusions.length
      ? "- Exclusions were applied literally to available bibliographic metadata, not to unavailable paywalled or unindexed full text."
      : "",
    sourceFailures.length
      ? `- ${sourceFailures.length} selected source request(s) failed or were blocked by browser CORS; their absence is recorded below.`
      : "- All selected source requests returned accepted JSON responses in this run.",
    validated && !validated.valid
      ? "- The requested LLM synthesis failed citation validation, so Litehouse replaced it with a deterministic evidence listing."
      : input.synthesisFailure
        ? `- The selected synthesis endpoint failed safely (${input.synthesisFailure}); Litehouse used a deterministic evidence listing.`
      : !input.llmSynthesis
        ? "- This is a deterministic evidence listing: no local model or API provider was connected, so no AI synthesis was performed. Connect a model or provider in Settings for an AI-written synthesis."
      : "",
  ].filter(Boolean).join("\n");
  const failureRows = sourceFailures.length
    ? sourceFailures.map(({ source, errorCode }) => `- ${source}: ${errorCode}`).join("\n")
    : "- None";
  const markdown = [
    `# ${escapeMarkdown(input.query)}`,
    "",
    "*An evidence-locked literature overview, generated locally in your browser. Sources are retrieved directly from open scholarly APIs; nothing is sent to a Litehouse server.*",
    "",
    `## ${validated?.valid ? "Synthesis" : "Evidence overview"}`,
    "",
    synthesis,
    "",
    "## References",
    "",
    references || "No references were accepted.",
    "",
    "## Limitations",
    "",
    limitations,
    "",
    "---",
    "",
    "## Provenance & integrity",
    "",
    `Generated locally in the browser: ${createdAt}`,
    "",
    `Retrieval SHA-256: \`${input.retrieval.resultSha256}\``,
    "",
    "### Retrieval boundaries",
    "",
    boundaryReceiptMarkdown(input.retrieval.boundaryAudit),
    "",
    "### Source failures",
    "",
    failureRows,
  ].join("\n");
  const reportSha256 = await sha256Hex(markdown);
  const id = (await digestCanonical({ createdAt, query: input.query, reportSha256 })).slice(0, 24);
  return {
    schema: "https://litehouse.pub/schemas/browser-report/v1",
    id,
    title: input.query,
    query: input.query,
    createdAt,
    markdown,
    records: input.retrieval.records,
    requestSha256: input.retrieval.requestSha256,
    retrievalSha256: input.retrieval.resultSha256,
    reportSha256,
    synthesis: validated?.valid ? "llm-validated" : "deterministic",
    ...(input.synthesisFailure ? { synthesisFailure: input.synthesisFailure } : {}),
    sourceFailures,
    ...(input.retrieval.boundaryAudit ? { boundaryAudit: input.retrieval.boundaryAudit } : {}),
    retrievalReceipts: input.retrieval.receipts,
  };
}
