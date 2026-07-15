export type ReaderFitMode = "width" | "page" | "custom";

export interface TextQuoteAnchor {
  page: number;
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  startTextItem: number;
  endTextItem: number;
}

export interface ReaderAnnotation {
  id: string;
  documentSha256: string;
  kind: "highlight" | "note";
  anchor: TextQuoteAnchor;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReaderProgress {
  page: number;
  zoom: number;
  fitMode: ReaderFitMode;
  rotation: 0 | 90 | 180 | 270;
  savedAt: string;
}

export interface ReaderDocumentRecord {
  id: string;
  title: string;
  authors: string;
  citation: string;
  sourceUrl: string;
  sourceLabel: string;
  license: string;
  licenseUrl: string;
  sha256: string;
  byteLength: number;
  acquiredAt: string;
  acquisition: string;
}

export interface ReaderOutlineEntry {
  title: string;
  page: number | null;
}

export interface ReaderSearchResult {
  id: string;
  page: number;
  start: number;
  end: number;
  snippet: string;
}

export type ReaderLoadState = "ready" | "missing" | "corrupt" | "unsupported";
