export type LibraryDiscipline =
  | "arts"
  | "humanities"
  | "life-sciences"
  | "natural-sciences"
  | "social-sciences"
  | "technology"
  | "interdisciplinary";

export type LibraryReadingState = "unread" | "reading" | "read";
export type IntegrityState = "verified" | "changed" | "metadata-only";

export interface LibraryExportArtifact {
  id: string;
  kind: string;
  mediaType: string;
  sha256: string;
}

export interface LibraryItemFixture {
  id: string;
  title: string;
  authors: string;
  venue: string;
  year: number;
  discipline: LibraryDiscipline;
  kind: "article" | "book" | "dataset" | "preprint" | "report";
  readingState: LibraryReadingState;
  integrity: IntegrityState;
  access: "open-full-text" | "abstract-only" | "local-copy";
  tags: readonly string[];
  collection: string;
  identifier: string;
  sha256?: string;
  live?: boolean;
  artifactId?: string;
  verificationArtifactId?: string;
  exportArtifacts?: readonly LibraryExportArtifact[];
  browserReportId?: string;
}
