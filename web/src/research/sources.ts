import { digestCanonical, sha256Hex } from "./integrity";
import type {
  BrowserSourceId,
  LiteratureRecord,
  LiteratureSearchRequest,
  LiteratureSearchResult,
  RetrievalBoundary,
  RetrievalBoundaryAudit,
  SourceFilterApplication,
  SourceReceipt,
} from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_QUERY_LENGTH = 500;

type JsonObject = Record<string, unknown>;

interface SourceDefinition {
  id: BrowserSourceId;
  origin: string;
  buildUrl: (request: NormalizedRequest) => URL;
  parse: (payload: JsonObject, context: ParseContext) => LiteratureRecord[];
}

interface NormalizedRequest {
  query: string;
  fromDate?: string;
  toDate?: string;
  openAccessOnly: boolean;
  languages: string[];
  disciplines: string[];
  workTypes: string[];
  exclusions: string[];
  perSourceLimit: number;
}

interface ParseContext {
  source: BrowserSourceId;
  responseSha256: string;
  retrievedAt: string;
}

class SourceFailure extends Error {
  constructor(
    readonly code: NonNullable<SourceReceipt["errorCode"]>,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, maximum = 4_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const decoded = typeof DOMParser === "undefined"
    ? value
    : new DOMParser().parseFromString(value, "text/html").body.textContent ?? value;
  const normalized = decoded.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function firstText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return text(value);
  return value.map((item) => text(item)).find(Boolean);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const candidate = text(value, 4_096);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function doi(value: unknown): string | undefined {
  const candidate = text(value, 512)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .toLowerCase();
  return candidate?.startsWith("10.") ? candidate : undefined;
}

function isoDate(value: unknown): string | undefined {
  const candidate = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : text(value, 32);
  if (!candidate || !/^\d{4}(?:-\d{2})?(?:-\d{2})?$/u.test(candidate)) return undefined;
  const padded = candidate.length === 4 ? `${candidate}-01-01` : candidate.length === 7 ? `${candidate}-01` : candidate;
  return Number.isNaN(Date.parse(`${padded}T00:00:00Z`)) ? undefined : candidate;
}

function crossrefDate(value: unknown): string | undefined {
  const parts = array(object(value)["date-parts"])[0];
  if (!Array.isArray(parts) || typeof parts[0] !== "number") return undefined;
  const year = String(parts[0]).padStart(4, "0");
  const month = typeof parts[1] === "number" ? `-${String(parts[1]).padStart(2, "0")}` : "";
  const day = typeof parts[2] === "number" ? `-${String(parts[2]).padStart(2, "0")}` : "";
  return isoDate(`${year}${month}${day}`);
}

function contributorNames(values: unknown[], mapper: (value: JsonObject) => unknown): string[] {
  const names = values
    .map((value) => text(mapper(object(value)), 512))
    .filter((value): value is string => Boolean(value));
  return [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()].slice(0, 100);
}

function createRecord(
  context: ParseContext,
  input: Omit<LiteratureRecord, "id" | "source" | "retrievedAt" | "responseSha256" | "corroboratedBy">,
): LiteratureRecord | undefined {
  const title = text(input.title);
  const sourceRecordId = text(input.sourceRecordId, 1_000);
  if (!title || !sourceRecordId) return undefined;
  return {
    ...input,
    id: `${context.source}:${sourceRecordId}`,
    source: context.source,
    title,
    sourceRecordId,
    retrievedAt: context.retrievedAt,
    responseSha256: context.responseSha256,
    corroboratedBy: [context.source],
  };
}

function openAlexAbstract(value: unknown): string | undefined {
  const positions: Array<[number, string]> = [];
  for (const [word, rawPositions] of Object.entries(object(value))) {
    for (const position of array(rawPositions)) {
      if (typeof position === "number" && Number.isSafeInteger(position) && position >= 0 && position < 30_000) {
        positions.push([position, word]);
      }
    }
  }
  positions.sort(([left], [right]) => left - right);
  return text(positions.slice(0, 30_000).map(([, word]) => word).join(" "), 100_000);
}

function parseOpenAlex(payload: JsonObject, context: ParseContext): LiteratureRecord[] {
  return array(payload.results).slice(0, 100).flatMap((raw) => {
    const item = object(raw);
    const primary = object(item.primary_location);
    const source = object(primary.source);
    const access = object(item.open_access);
    const primaryTopic = object(item.primary_topic);
    const topicField = object(primaryTopic.field);
    const topicDomain = object(primaryTopic.domain);
    const record = createRecord(context, {
      sourceRecordId: text(item.id) ?? "",
      title: text(item.title) ?? text(item.display_name) ?? "",
      kind: text(item.type, 100) ?? "other",
      doi: doi(item.doi),
      contributors: contributorNames(array(item.authorships), (authorship) => object(authorship.author).display_name),
      publicationDate: isoDate(item.publication_date),
      language: text(item.language, 64),
      fieldsOfStudy: [text(topicField.display_name, 256), text(topicDomain.display_name, 256)]
        .filter((value): value is string => Boolean(value)),
      venue: text(source.display_name, 1_000),
      abstract: openAlexAbstract(item.abstract_inverted_index),
      landingUrl: safeUrl(primary.landing_page_url) ?? safeUrl(item.id),
      openFullTextUrl: access.is_oa === true ? safeUrl(access.oa_url) : undefined,
      licenseUrl: safeUrl(primary.license),
      citationCount: integer(item.cited_by_count),
    });
    return record ? [record] : [];
  });
}

function parseCrossref(payload: JsonObject, context: ParseContext): LiteratureRecord[] {
  return array(object(payload.message).items).slice(0, 100).flatMap((raw) => {
    const item = object(raw);
    const contributors = contributorNames(array(item.author), (author) => {
      const fullName = [text(author.given, 256), text(author.family, 256)].filter(Boolean).join(" ");
      return fullName || author.name;
    });
    const record = createRecord(context, {
      sourceRecordId: text(item.DOI) ?? text(item.URL) ?? "",
      title: firstText(item.title) ?? "",
      kind: text(item.type, 100) ?? "other",
      doi: doi(item.DOI),
      contributors,
      publicationDate: crossrefDate(item.published ?? item["published-print"] ?? item.issued),
      language: text(item.language, 64),
      venue: firstText(item["container-title"]),
      abstract: text(item.abstract, 100_000),
      landingUrl: safeUrl(item.URL),
      citationCount: integer(item["is-referenced-by-count"]),
    });
    return record ? [record] : [];
  });
}

function parseEuropePmc(payload: JsonObject, context: ParseContext): LiteratureRecord[] {
  return array(object(payload.resultList).result).slice(0, 100).flatMap((raw) => {
    const item = object(raw);
    const urls = array(object(item.fullTextUrlList).fullTextUrl).map(object);
    const pdf = urls.find((value) => value.documentStyle === "pdf");
    const pmid = text(item.pmid, 256);
    const record = createRecord(context, {
      sourceRecordId: text(item.id) ?? pmid ?? text(item.pmcid) ?? "",
      title: text(item.title) ?? "",
      kind: text(item.pubType, 100) ?? "article",
      doi: doi(item.doi),
      contributors: contributorNames(array(object(item.authorList).author), (author) => author.fullName),
      publicationDate: isoDate(item.firstPublicationDate ?? item.firstIndexDate),
      language: text(item.language, 64),
      venue: text(item.journalTitle, 1_000),
      abstract: text(item.abstractText, 100_000),
      landingUrl: pmid ? `https://europepmc.org/article/MED/${encodeURIComponent(pmid)}` : undefined,
      openFullTextUrl: item.isOpenAccess === "Y" || item.isOpenAccess === true ? safeUrl(pdf?.url) : undefined,
      licenseUrl: safeUrl(item.license),
      citationCount: integer(item.citedByCount),
    });
    return record ? [record] : [];
  });
}

// Best-effort: shared unauthenticated pool returns 429 under load; no API key is sent.
function parseSemanticScholar(payload: JsonObject, context: ParseContext): LiteratureRecord[] {
  return array(payload.data).slice(0, 100).flatMap((raw) => {
    const item = object(raw);
    const external = object(item.externalIds);
    const publicationTypes = array(item.publicationTypes);
    const record = createRecord(context, {
      sourceRecordId: text(item.paperId) ?? "",
      title: text(item.title) ?? "",
      kind: firstText(publicationTypes) ?? "article",
      doi: doi(external.DOI),
      contributors: contributorNames(array(item.authors), (author) => author.name),
      publicationDate: isoDate(item.publicationDate) ?? isoDate(item.year),
      fieldsOfStudy: array(item.fieldsOfStudy)
        .map((value) => text(value, 256))
        .filter((value): value is string => Boolean(value))
        .slice(0, 30),
      venue: text(item.venue, 1_000),
      abstract: text(item.abstract, 100_000),
      landingUrl: safeUrl(item.url),
      openFullTextUrl: safeUrl(object(item.openAccessPdf).url),
      licenseUrl: safeUrl(object(item.openAccessPdf).license),
      citationCount: integer(item.citationCount),
    });
    return record ? [record] : [];
  });
}

function dataCiteDate(attributes: JsonObject): string | undefined {
  const dates = array(attributes.dates).map(object);
  const issued = dates.find((entry) => entry.dateType === "Issued")
    ?? dates.find((entry) => entry.dateType === "Available");
  return isoDate(issued?.date)
    ?? isoDate(attributes.published)
    ?? isoDate(attributes.publicationYear);
}

function parseDataCite(payload: JsonObject, context: ParseContext): LiteratureRecord[] {
  return array(payload.data).slice(0, 100).flatMap((raw) => {
    const item = object(raw);
    const attributes = object(item.attributes);
    const title = object(array(attributes.titles)[0]).title;
    const descriptions = array(attributes.descriptions).map(object);
    const abstract = descriptions.find((value) => value.descriptionType === "Abstract")?.description;
    const types = object(attributes.types);
    const record = createRecord(context, {
      sourceRecordId: text(item.id) ?? text(attributes.doi) ?? "",
      title: text(title) ?? "",
      kind: text(types.resourceTypeGeneral, 100) ?? text(types.resourceType, 100) ?? "other",
      doi: doi(attributes.doi ?? item.id),
      contributors: contributorNames(array(attributes.creators), (creator) => creator.name),
      publicationDate: dataCiteDate(attributes),
      language: text(attributes.language, 64),
      venue: text(attributes.publisher, 1_000),
      abstract: text(abstract, 100_000),
      landingUrl: safeUrl(attributes.url),
      licenseUrl: safeUrl(object(array(attributes.rightsList)[0]).rightsUri),
      citationCount: integer(attributes.citationCount),
    });
    return record ? [record] : [];
  });
}

const EUROPE_PMC_LANGUAGES: Record<string, string> = {
  en: "eng",
  tr: "tur",
  de: "ger",
  fr: "fre",
  es: "spa",
};

const OPENALEX_WORK_TYPES: Record<string, string[]> = {
  "journal-article": ["article", "review"],
  "book-chapter": ["book", "book-chapter"],
  preprint: ["preprint"],
  dataset: ["dataset"],
  thesis: ["dissertation"],
  report: ["report", "standard"],
};

const CROSSREF_WORK_TYPES: Record<string, string[]> = {
  "journal-article": ["journal-article"],
  conference: ["proceedings-article"],
  preprint: ["posted-content"],
  dataset: ["dataset"],
  thesis: ["dissertation"],
};

const SEMANTIC_SCHOLAR_WORK_TYPES: Record<string, string[]> = {
  "journal-article": ["JournalArticle", "Review", "MetaAnalysis", "CaseReport", "ClinicalTrial", "Study", "Editorial", "LettersAndComments"],
  "book-chapter": ["Book", "BookSection"],
  conference: ["Conference"],
  dataset: ["Dataset"],
};

const SEMANTIC_SCHOLAR_FIELDS: Record<string, string[]> = {
  humanities: ["History", "Philosophy", "Linguistics"],
  arts: ["Art"],
  "social-sciences": ["Sociology", "Psychology", "Economics", "Business", "Political Science", "Education", "Geography"],
  "natural-sciences": ["Physics", "Chemistry", "Mathematics", "Geology", "Environmental Science"],
  "life-sciences": ["Biology", "Medicine", "Agricultural and Food Sciences"],
  technology: ["Engineering", "Computer Science", "Materials Science"],
  "law-policy": ["Law", "Political Science"],
};

function fullyMapped(values: string[], mapping: Record<string, string[]>): string[] | undefined {
  if (!values.length || values.some((value) => !mapping[value]?.length)) return undefined;
  return [...new Set(values.flatMap((value) => mapping[value]))];
}

function sourceLanguages(source: BrowserSourceId, request: NormalizedRequest): string[] | undefined {
  if (!request.languages.length || request.languages.includes("other")) return undefined;
  if (source === "openalex" && request.languages.every((language) => /^[a-z]{2}$/u.test(language))) {
    return request.languages;
  }
  if (source === "europe-pmc" && request.languages.every((language) => EUROPE_PMC_LANGUAGES[language])) {
    return request.languages.map((language) => EUROPE_PMC_LANGUAGES[language]);
  }
  return undefined;
}

function sourceWorkTypes(source: BrowserSourceId, request: NormalizedRequest): string[] | undefined {
  if (source === "openalex") return fullyMapped(request.workTypes, OPENALEX_WORK_TYPES);
  if (source === "crossref") {
    const mapped = fullyMapped(request.workTypes, CROSSREF_WORK_TYPES);
    return mapped?.length === 1 ? mapped : undefined;
  }
  if (source === "semantic-scholar") return fullyMapped(request.workTypes, SEMANTIC_SCHOLAR_WORK_TYPES);
  if (source === "datacite" && request.workTypes.length === 1 && request.workTypes[0] === "dataset") return ["dataset"];
  return undefined;
}

function sourceDisciplines(source: BrowserSourceId, request: NormalizedRequest): string[] | undefined {
  return source === "semantic-scholar"
    ? fullyMapped(request.disciplines, SEMANTIC_SCHOLAR_FIELDS)
    : undefined;
}

function dataCitePublishedYears(request: NormalizedRequest): string[] | undefined {
  if (!request.fromDate || !request.toDate) return undefined;
  const first = Number(request.fromDate.slice(0, 4));
  const last = Number(request.toDate.slice(0, 4));
  if (!Number.isInteger(first) || !Number.isInteger(last) || last < first || last - first >= 10) return undefined;
  return Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
}

function sourceHasDateFilter(source: BrowserSourceId, request: NormalizedRequest): boolean {
  if (!request.fromDate && !request.toDate) return false;
  if (source === "datacite") return Boolean(dataCitePublishedYears(request));
  if (source === "europe-pmc") return Boolean(request.fromDate && request.toDate);
  return true;
}

function sourceFilterApplications(source: BrowserSourceId, request: NormalizedRequest): SourceFilterApplication[] {
  const filters: SourceFilterApplication[] = [];
  if (request.fromDate || request.toDate) {
    const upstream = sourceHasDateFilter(source, request);
    filters.push({
      boundary: "publication-date",
      mode: upstream ? "source-and-post" : "post-only",
      detail: upstream
        ? "The source receives its supported date constraint; Litehouse then enforces exact inclusive bounds and rejects missing or insufficiently precise dates."
        : "This source cannot express the requested date interval safely; Litehouse enforces it after parsing and rejects missing or insufficiently precise dates.",
    });
  }
  if (request.openAccessOnly) {
    const upstream = source === "openalex" || source === "europe-pmc" || source === "semantic-scholar";
    filters.push({
      boundary: "open-access",
      mode: upstream ? "source-and-post" : "post-only",
      detail: upstream
        ? "The source is asked for open-access records; Litehouse also requires a source-provided open-full-text URL."
        : "Litehouse requires a source-provided open-full-text URL after parsing; this source has no compatible request filter.",
    });
  }
  if (request.languages.length) {
    const upstream = Boolean(sourceLanguages(source, request));
    filters.push({
      boundary: "language",
      mode: upstream ? "source-and-post" : "post-only",
      detail: upstream
        ? "The source receives a compatible language filter; Litehouse removes known metadata mismatches and retains records whose language is absent."
        : "Known language metadata is checked after parsing; records without language metadata are retained and counted as unknown.",
    });
  }
  if (request.disciplines.length) {
    const upstream = Boolean(sourceDisciplines(source, request));
    filters.push({
      boundary: "discipline",
      mode: upstream ? "source-and-post" : "post-only",
      detail: upstream
        ? "The source receives mapped fields of study; Litehouse checks available field metadata and retains records where the field is absent."
        : "Available field metadata is checked after parsing; this source cannot safely represent the broad requested discipline set.",
    });
  }
  if (request.workTypes.length) {
    const upstream = Boolean(sourceWorkTypes(source, request));
    filters.push({
      boundary: "work-type",
      mode: upstream ? "source-and-post" : "post-only",
      detail: upstream
        ? "The source receives mapped work types; Litehouse also checks normalized type metadata and retains unclassifiable records."
        : "Normalized type metadata is checked after parsing; this source cannot safely represent every requested work type upstream.",
    });
  }
  if (request.exclusions.length) {
    filters.push({
      boundary: "exclusion",
      mode: "post-only",
      detail: "Literal exclusions are matched case-insensitively against available title, abstract, venue, type, and field metadata; unavailable full text is not searched.",
    });
  }
  return filters;
}

// Generic project contact for OpenAlex/Crossref polite pools; not a personal address.
const POLITE_POOL_MAILTO = "litehouse@users.noreply.github.com";

function addOpenAlexFilters(url: URL, request: NormalizedRequest): void {
  const filters = [
    request.fromDate && `from_publication_date:${request.fromDate}`,
    request.toDate && `to_publication_date:${request.toDate}`,
    request.openAccessOnly && "is_oa:true",
  ].filter((value): value is string => Boolean(value));
  const languages = sourceLanguages("openalex", request);
  if (languages) filters.push(`language:${languages.join("|")}`);
  const workTypes = sourceWorkTypes("openalex", request);
  if (workTypes) filters.push(`type:${workTypes.join("|")}`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
}

function addCrossrefFilters(url: URL, request: NormalizedRequest): void {
  const filters = [
    request.fromDate && `from-pub-date:${request.fromDate}`,
    request.toDate && `until-pub-date:${request.toDate}`,
  ].filter((value): value is string => Boolean(value));
  const workTypes = sourceWorkTypes("crossref", request);
  if (workTypes) filters.push(`type:${workTypes[0]}`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
}

const SOURCES: Partial<Record<BrowserSourceId, SourceDefinition>> = {
  openalex: {
    id: "openalex",
    origin: "https://api.openalex.org",
    buildUrl: (request) => {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", request.query);
      url.searchParams.set("per-page", String(request.perSourceLimit));
      url.searchParams.set("mailto", POLITE_POOL_MAILTO);
      addOpenAlexFilters(url, request);
      return url;
    },
    parse: parseOpenAlex,
  },
  crossref: {
    id: "crossref",
    origin: "https://api.crossref.org",
    buildUrl: (request) => {
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query.bibliographic", request.query);
      url.searchParams.set("rows", String(request.perSourceLimit));
      url.searchParams.set("mailto", POLITE_POOL_MAILTO);
      addCrossrefFilters(url, request);
      return url;
    },
    parse: parseCrossref,
  },
  datacite: {
    id: "datacite",
    origin: "https://api.datacite.org",
    buildUrl: (request) => {
      const url = new URL("https://api.datacite.org/dois");
      url.searchParams.set("query", request.query);
      url.searchParams.set("page[size]", String(request.perSourceLimit));
      url.searchParams.set("disable-facets", "true");
      const publishedYears = dataCitePublishedYears(request);
      if (publishedYears) url.searchParams.set("published", publishedYears.join(","));
      const workTypes = sourceWorkTypes("datacite", request);
      if (workTypes) url.searchParams.set("resource-type-id", workTypes.join(","));
      return url;
    },
    parse: parseDataCite,
  },
  "europe-pmc": {
    id: "europe-pmc",
    origin: "https://www.ebi.ac.uk",
    buildUrl: (request) => {
      const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
      const dates = request.fromDate && request.toDate
        ? ` AND FIRST_PDATE:[${request.fromDate} TO ${request.toDate}]`
        : "";
      const open = request.openAccessOnly ? " AND OPEN_ACCESS:Y" : "";
      const languages = sourceLanguages("europe-pmc", request);
      const language = languages
        ? ` AND (${languages.map((value) => `LANG:${value}`).join(" OR ")})`
        : "";
      url.searchParams.set("query", `${request.query}${dates}${open}${language}`);
      url.searchParams.set("format", "json");
      url.searchParams.set("resultType", "core");
      url.searchParams.set("pageSize", String(request.perSourceLimit));
      return url;
    },
    parse: parseEuropePmc,
  },
  "semantic-scholar": {
    id: "semantic-scholar",
    origin: "https://api.semanticscholar.org",
    buildUrl: (request) => {
      const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", request.query);
      url.searchParams.set("limit", String(Math.min(request.perSourceLimit, 100)));
      url.searchParams.set("fields", "paperId,externalIds,title,authors,abstract,year,publicationDate,venue,publicationTypes,fieldsOfStudy,citationCount,openAccessPdf,url");
      if (request.fromDate || request.toDate) {
        url.searchParams.set("publicationDateOrYear", `${request.fromDate ?? ""}:${request.toDate ?? ""}`);
      }
      if (request.openAccessOnly) url.searchParams.set("openAccessPdf", "");
      const workTypes = sourceWorkTypes("semantic-scholar", request);
      if (workTypes) url.searchParams.set("publicationTypes", workTypes.join(","));
      const fields = sourceDisciplines("semantic-scholar", request);
      if (fields) url.searchParams.set("fieldsOfStudy", fields.join(","));
      return url;
    },
    parse: parseSemanticScholar,
  },
};

function normalizeRequest(request: LiteratureSearchRequest): NormalizedRequest {
  const query = request.query.replace(/\s+/gu, " ").trim();
  if (query.length < 3 || query.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`Search query must contain 3–${MAX_QUERY_LENGTH} characters.`);
  }
  const perSourceLimit = request.perSourceLimit ?? 15;
  if (!Number.isInteger(perSourceLimit) || perSourceLimit < 1 || perSourceLimit > 50) {
    throw new RangeError("Per-source result limit must be between 1 and 50.");
  }
  for (const [label, value] of [["start", request.fromDate], ["end", request.toDate]] as const) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || isoDate(value) !== value)) {
      throw new RangeError(`The publication ${label} date must use a valid YYYY-MM-DD value.`);
    }
  }
  if (request.fromDate && request.toDate && request.fromDate > request.toDate) {
    throw new RangeError("The start date must not be after the end date.");
  }
  const normalizedValues = (values: string[] | undefined, maximum: number, valueLength: number): string[] => [
    ...new Set((values ?? [])
      .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase())
      .filter(Boolean)
      .map((value) => value.slice(0, valueLength))),
  ].slice(0, maximum);
  return {
    query,
    fromDate: request.fromDate,
    toDate: request.toDate,
    openAccessOnly: request.openAccessOnly,
    languages: normalizedValues(request.languages, 12, 32),
    disciplines: normalizedValues(request.disciplines, 16, 64),
    workTypes: normalizedValues(request.workTypes, 16, 64),
    exclusions: normalizedValues(request.exclusions, 30, 240),
    perSourceLimit,
  };
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new SourceFailure("response_too_large", "The source response exceeded the byte limit.");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new SourceFailure("response_too_large", "The source response exceeded the byte limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SourceFailure("response_too_large", "The source response exceeded the byte limit.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function fetchSource(
  definition: SourceDefinition,
  request: NormalizedRequest,
  externalSignal?: AbortSignal,
): Promise<{ records: LiteratureRecord[]; receipt: SourceReceipt }> {
  const requestedAt = new Date().toISOString();
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const url = definition.buildUrl(request);
    if (url.origin !== definition.origin) throw new SourceFailure("schema_mismatch", "Source origin validation failed.");
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json, application/vnd.api+json;q=0.9" },
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new SourceFailure("http_status", `Source returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType && contentType !== "application/json" && contentType !== "application/vnd.api+json") {
      throw new SourceFailure("invalid_content_type", "Source did not return JSON.");
    }
    const bytes = await readLimited(response);
    const responseSha256 = await sha256Hex(bytes);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new SourceFailure("invalid_json", "Source returned invalid JSON.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SourceFailure("schema_mismatch", "Source returned an unexpected JSON root.");
    }
    const completedAt = new Date().toISOString();
    const records = definition.parse(payload as JsonObject, {
      source: definition.id,
      responseSha256,
      retrievedAt: completedAt,
    });
    return {
      records,
      receipt: {
        source: definition.id,
        endpointOrigin: definition.origin,
        requestedAt,
        completedAt,
        responseSha256,
        responseBytes: bytes.byteLength,
        recordCount: records.length,
        filterApplications: sourceFilterApplications(definition.id, request),
        status: "accepted",
      },
    };
  } catch (error) {
    const code = error instanceof SourceFailure
      ? error.code
      : timedOut
        ? "timeout"
        : externalSignal?.aborted
          ? "aborted"
          : "cors_or_network";
    return {
      records: [],
      receipt: {
        source: definition.id,
        endpointOrigin: definition.origin,
        requestedAt,
        completedAt: new Date().toISOString(),
        responseSha256: "",
        responseBytes: 0,
        recordCount: 0,
        filterApplications: sourceFilterApplications(definition.id, request),
        status: "rejected",
        errorCode: code,
      },
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

function titleKey(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Second dedup pass: collapse records sharing a substantive normalized title + year
// even when their DOIs differ (e.g. per-version Zenodo DOIs of the same work). Short
// titles get a unique key so distinct generic titles are never over-merged.
function mergeByTitle(records: LiteratureRecord[]): LiteratureRecord[] {
  const byTitle = new Map<string, LiteratureRecord>();
  for (const record of records) {
    const tk = titleKey(record.title);
    const year = record.publicationDate?.slice(0, 4) ?? "";
    const key = tk.length >= 8 ? `t:${tk}:${year}` : `u:${record.id}`;
    const current = byTitle.get(key);
    if (!current) {
      byTitle.set(key, record);
      continue;
    }
    byTitle.set(key, {
      ...current,
      contributors: [...new Set([...current.contributors, ...record.contributors])].slice(0, 100),
      abstract: (record.abstract?.length ?? 0) > (current.abstract?.length ?? 0) ? record.abstract : current.abstract,
      venue: current.venue ?? record.venue,
      openFullTextUrl: current.openFullTextUrl ?? record.openFullTextUrl,
      landingUrl: current.landingUrl ?? record.landingUrl,
      citationCount: Math.max(current.citationCount ?? 0, record.citationCount ?? 0) || undefined,
      corroboratedBy: [...new Set([...current.corroboratedBy, ...record.corroboratedBy])],
    });
  }
  return [...byTitle.values()];
}

function mergeRecords(records: LiteratureRecord[]): LiteratureRecord[] {
  const merged = new Map<string, LiteratureRecord>();
  for (const record of records) {
    const key = record.doi ? `doi:${record.doi}` : `title:${titleKey(record.title)}:${record.publicationDate?.slice(0, 4) ?? ""}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, record);
      continue;
    }
    const richer = (record.abstract?.length ?? 0) > (current.abstract?.length ?? 0) ? record : current;
    merged.set(key, {
      ...current,
      title: record.title.length > current.title.length ? record.title : current.title,
      contributors: [...new Set([...current.contributors, ...record.contributors])].slice(0, 100),
      publicationDate: current.publicationDate ?? record.publicationDate,
      language: current.language ?? record.language,
      fieldsOfStudy: [...new Set([...(current.fieldsOfStudy ?? []), ...(record.fieldsOfStudy ?? [])])].slice(0, 30),
      venue: current.venue ?? record.venue,
      abstract: richer.abstract,
      landingUrl: current.landingUrl ?? record.landingUrl,
      openFullTextUrl: current.openFullTextUrl ?? record.openFullTextUrl,
      licenseUrl: current.licenseUrl ?? record.licenseUrl,
      citationCount: Math.max(current.citationCount ?? 0, record.citationCount ?? 0) || undefined,
      corroboratedBy: [...new Set([...current.corroboratedBy, ...record.corroboratedBy])],
    });
  }
  return mergeByTitle([...merged.values()]).sort((left, right) => {
    const corroboration = right.corroboratedBy.length - left.corroboratedBy.length;
    if (corroboration) return corroboration;
    const citations = (right.citationCount ?? -1) - (left.citationCount ?? -1);
    if (citations) return citations;
    return (right.publicationDate ?? "").localeCompare(left.publicationDate ?? "");
  });
}

function normalizedLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.normalize("NFKC").trim().toLocaleLowerCase().split(/[-_]/u, 1)[0];
  const aliases: Record<string, string> = {
    eng: "en",
    english: "en",
    tur: "tr",
    turkish: "tr",
    deu: "de",
    ger: "de",
    german: "de",
    fra: "fr",
    fre: "fr",
    french: "fr",
    spa: "es",
    spanish: "es",
  };
  return aliases[candidate] ?? candidate;
}

function languageMatches(value: string, requested: string[]): boolean {
  if (requested.includes(value)) return true;
  const namedChoices = new Set(["en", "tr", "de", "fr", "es"]);
  return requested.includes("other") && !namedChoices.has(value);
}

function dateExtent(value: string | undefined): { start: string; end: string } | undefined {
  if (!value) return undefined;
  if (/^\d{4}$/u.test(value)) return { start: `${value}-01-01`, end: `${value}-12-31` };
  if (/^\d{4}-\d{2}$/u.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const finalDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${value}-01`, end: `${value}-${String(finalDay).padStart(2, "0")}` };
  }
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? { start: value, end: value } : undefined;
}

function dateMatches(record: LiteratureRecord, request: NormalizedRequest): boolean {
  if (!request.fromDate && !request.toDate) return true;
  const extent = dateExtent(record.publicationDate);
  if (!extent) return false;
  if (request.fromDate && extent.start < request.fromDate) return false;
  if (request.toDate && extent.end > request.toDate) return false;
  return true;
}

function normalizedWorkType(kind: string): string | undefined {
  const value = kind
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  if (!value || value === "other") return undefined;
  if (/\b(preprint|posted content)\b/u.test(value)) return "preprint";
  if (/\b(dataset|data set)\b/u.test(value)) return "dataset";
  if (/\b(thesis|dissertation)\b/u.test(value)) return "thesis";
  if (/\b(conference|proceedings)\b/u.test(value)) return "conference";
  if (/\b(book|book chapter|book section|monograph)\b/u.test(value)) return "book-chapter";
  if (/\b(report|standard|technical report)\b/u.test(value)) return "report";
  if (/\b(art|catalog|creative|film|video|audio|image|map|music|photograph|manuscript)\b/u.test(value)) return "creative-work";
  if (/\b(article|review|study|clinical trial|case report|editorial|letter|journal)\b/u.test(value)) return "journal-article";
  return undefined;
}

function normalizedDisciplineFields(fields: string[]): Set<string> {
  const result = new Set<string>();
  for (const rawField of fields) {
    const field = rawField.normalize("NFKD").toLocaleLowerCase();
    if (/history|philosoph|linguistic|literature|religion|humanit/u.test(field)) result.add("humanities");
    if (/\bart\b|design|visual|music|theat|perform/u.test(field)) result.add("arts");
    if (/sociolog|psycholog|econom|business|political|education|geograph|social/u.test(field)) result.add("social-sciences");
    if (/physics|chemistry|mathemat|geology|environmental|earth science|natural science/u.test(field)) result.add("natural-sciences");
    if (/biology|medicine|medical|health|agricultur|life science/u.test(field)) result.add("life-sciences");
    if (/engineering|computer science|materials science|technology/u.test(field)) result.add("technology");
    if (/\blaw\b|legal|public policy/u.test(field)) result.add("law-policy");
  }
  return result;
}

function exclusionCorpus(record: LiteratureRecord): string {
  return [
    record.title,
    record.abstract,
    record.venue,
    record.kind,
    ...(record.fieldsOfStudy ?? []),
  ].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase();
}

function incrementRemoval(
  removed: Partial<Record<RetrievalBoundary, number>>,
  boundary: RetrievalBoundary,
): void {
  removed[boundary] = (removed[boundary] ?? 0) + 1;
}

function enforceBoundaries(
  records: LiteratureRecord[],
  request: NormalizedRequest,
  receipts: SourceReceipt[],
  parsedRecords: number,
): { records: LiteratureRecord[]; audit: RetrievalBoundaryAudit } {
  const removedByBoundary: Partial<Record<RetrievalBoundary, number>> = {};
  const retainedWithoutMetadata = { language: 0, discipline: 0, workType: 0 };
  const accepted = records.filter((record) => {
    let languageUnknown = false;
    let workTypeUnknown = false;
    let disciplineUnknown = false;
    if (!dateMatches(record, request)) {
      incrementRemoval(removedByBoundary, "publication-date");
      return false;
    }
    if (request.openAccessOnly && !record.openFullTextUrl) {
      incrementRemoval(removedByBoundary, "open-access");
      return false;
    }
    if (request.exclusions.length) {
      const corpus = exclusionCorpus(record);
      if (request.exclusions.some((term) => corpus.includes(term))) {
        incrementRemoval(removedByBoundary, "exclusion");
        return false;
      }
    }
    if (request.languages.length) {
      const language = normalizedLanguage(record.language);
      if (!language) languageUnknown = true;
      else if (!languageMatches(language, request.languages)) {
        incrementRemoval(removedByBoundary, "language");
        return false;
      }
    }
    if (request.workTypes.length) {
      const workType = normalizedWorkType(record.kind);
      if (!workType) workTypeUnknown = true;
      else if (!request.workTypes.includes(workType)) {
        incrementRemoval(removedByBoundary, "work-type");
        return false;
      }
    }
    if (request.disciplines.length) {
      const fields = normalizedDisciplineFields(record.fieldsOfStudy ?? []);
      if (!fields.size) disciplineUnknown = true;
      else if (!request.disciplines.includes("interdisciplinary") && !request.disciplines.some((field) => fields.has(field))) {
        incrementRemoval(removedByBoundary, "discipline");
        return false;
      }
    }
    if (languageUnknown) retainedWithoutMetadata.language += 1;
    if (workTypeUnknown) retainedWithoutMetadata.workType += 1;
    if (disciplineUnknown) retainedWithoutMetadata.discipline += 1;
    return true;
  });
  return {
    records: accepted,
    audit: {
      requested: {
        fromDate: request.fromDate,
        toDate: request.toDate,
        openAccessOnly: request.openAccessOnly,
        languages: request.languages,
        disciplines: request.disciplines,
        workTypes: request.workTypes,
        exclusions: request.exclusions,
      },
      sourceApplications: receipts.map(({ source, filterApplications }) => ({
        source,
        filters: filterApplications ?? [],
      })),
      postFilter: {
        parsedRecords,
        deduplicatedRecords: records.length,
        acceptedRecords: accepted.length,
        removedByBoundary,
        retainedWithoutMetadata,
      },
    },
  };
}

// Titles that signal a non-article container (proceedings, abstract compilations) rather
// than a topical research work; heavily demoted so real papers rank above them.
const JUNK_TITLE = /\b(abstract books?|abstracts?|conference|congress|proceedings?|festival|late[ -]breaking|symposium|posters?|supplement|meeting|programme|program book)\b/iu;
const RELEVANCE_STOP = new Set([
  "what", "are", "the", "and", "for", "with", "best", "practices", "practice", "how", "does", "using", "use",
  "from", "into", "about", "this", "that", "study", "studies", "research", "investigation", "investigations",
  "approach", "approaches", "review", "reviews", "based", "toward", "towards", "role", "between", "within",
  "via", "new", "recent", "current", "analysis",
]);

function relevanceScore(record: LiteratureRecord, terms: string[]): number {
  const title = record.title.toLocaleLowerCase();
  const hay = `${title} ${(record.abstract ?? "").toLocaleLowerCase()}`;
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    else if (hay.includes(term)) score += 1;
  }
  score += record.corroboratedBy.length * 2;
  score += Math.min(3, Math.log10((record.citationCount ?? 0) + 1));
  if (JUNK_TITLE.test(record.title)) score -= 12;
  if (!record.abstract && !record.openFullTextUrl) score -= 2;
  return score;
}

// Re-rank retained records by topical relevance to the query (title/abstract term overlap),
// corroboration, and citation signal, demoting non-article junk. Stable on ties.
function rankByRelevance(records: LiteratureRecord[], query: string): LiteratureRecord[] {
  const terms = [...new Set(
    query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3 && !RELEVANCE_STOP.has(term)),
  )];
  if (!terms.length) return records;
  return records
    .map((record, index) => ({ record, index, score: relevanceScore(record, terms) }))
    .sort((left, right) => (right.score - left.score) || (left.index - right.index))
    .map(({ record }) => record);
}

export async function searchLiterature(request: LiteratureSearchRequest): Promise<LiteratureSearchResult> {
  const normalized = normalizeRequest(request);
  const selectedSources = [...new Set(request.sources)].filter((source) => SOURCES[source]);
  if (!selectedSources.length) throw new RangeError("Select at least one literature source.");
  const requestSha256 = await digestCanonical({
    ...normalized,
    sources: [...selectedSources].sort(),
  });
  const responses = await Promise.all(
    selectedSources.map((source) => fetchSource(SOURCES[source]!, normalized, request.signal)),
  );
  const receipts = responses.map((response) => response.receipt);
  const parsedRecords = responses.reduce((total, response) => total + response.records.length, 0);
  const reconciled = mergeRecords(responses.flatMap((response) => response.records));
  const { records: boundedRecords, audit: boundaryAudit } = enforceBoundaries(reconciled, normalized, receipts, parsedRecords);
  const records = rankByRelevance(boundedRecords, request.query);
  const completedAt = new Date().toISOString();
  const resultSha256 = await digestCanonical({ completedAt, records, receipts, requestSha256, boundaryAudit });
  return { records, receipts, requestSha256, resultSha256, completedAt, boundaryAudit };
}

export const browserSourceOrigins = Object.values(SOURCES).map(({ origin }) => origin);
