export type BrowserSourceId =
  | "openalex"
  | "crossref"
  | "datacite"
  | "europe-pmc"
  | "semantic-scholar"
  | "library-of-congress";

export interface LiteratureRecord {
  id: string;
  source: BrowserSourceId;
  sourceRecordId: string;
  title: string;
  kind: string;
  doi?: string;
  contributors: string[];
  publicationDate?: string;
  language?: string;
  fieldsOfStudy?: string[];
  venue?: string;
  abstract?: string;
  landingUrl?: string;
  openFullTextUrl?: string;
  licenseUrl?: string;
  citationCount?: number;
  isRetracted?: boolean;
  retrievedAt: string;
  responseSha256: string;
  corroboratedBy: BrowserSourceId[];
}

export type RetrievalBoundary =
  | "publication-date"
  | "open-access"
  | "language"
  | "discipline"
  | "work-type"
  | "exclusion";

export interface SourceFilterApplication {
  boundary: RetrievalBoundary;
  mode: "source-and-post" | "post-only";
  detail: string;
}

export interface RetrievalBoundaryAudit {
  requested: {
    fromDate?: string;
    toDate?: string;
    openAccessOnly: boolean;
    languages: string[];
    disciplines: string[];
    workTypes: string[];
    exclusions: string[];
  };
  sourceApplications: Array<{
    source: BrowserSourceId;
    filters: SourceFilterApplication[];
  }>;
  postFilter: {
    parsedRecords: number;
    deduplicatedRecords: number;
    acceptedRecords: number;
    /** Counts are assigned to the first failed boundary in deterministic evaluation order. */
    removedByBoundary: Partial<Record<RetrievalBoundary, number>>;
    retainedWithoutMetadata: {
      language: number;
      discipline: number;
      workType: number;
    };
  };
}

export interface SourceReceipt {
  source: BrowserSourceId;
  endpointOrigin: string;
  requestedAt: string;
  completedAt: string;
  responseSha256: string;
  responseBytes: number;
  recordCount: number;
  filterApplications?: SourceFilterApplication[];
  status: "accepted" | "rejected";
  errorCode?:
    | "aborted"
    | "cors_or_network"
    | "http_status"
    | "invalid_content_type"
    | "invalid_json"
    | "response_too_large"
    | "schema_mismatch"
    | "timeout";
}

export interface LiteratureSearchRequest {
  query: string;
  sources: BrowserSourceId[];
  fromDate?: string;
  toDate?: string;
  openAccessOnly: boolean;
  /** ISO 639-1 tags selected by the user; `other` means a known language outside the named choices. */
  languages?: string[];
  /** Litehouse's broad, user-facing discipline identifiers. */
  disciplines?: string[];
  /** Litehouse's user-facing work-type identifiers. */
  workTypes?: string[];
  /** Literal terms or phrases rejected against available bibliographic metadata. */
  exclusions?: string[];
  perSourceLimit?: number;
  signal?: AbortSignal;
}

export interface LiteratureSearchResult {
  records: LiteratureRecord[];
  receipts: SourceReceipt[];
  requestSha256: string;
  resultSha256: string;
  completedAt: string;
  boundaryAudit?: RetrievalBoundaryAudit;
}
