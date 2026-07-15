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

export const libraryFixtures: readonly LibraryItemFixture[] = [
  {
    id: "abramson-2024",
    title: "Accurate structure prediction of biomolecular interactions with AlphaFold 3",
    authors: "Abramson et al.",
    venue: "Nature",
    year: 2024,
    discipline: "life-sciences",
    kind: "article",
    readingState: "reading",
    integrity: "verified",
    access: "open-full-text",
    tags: ["structure", "methods", "protein-design"],
    collection: "Molecular systems",
    identifier: "doi:10.1038/s41586-024-07487-w",
    sha256: "63ad1c4f…aa09",
  },
  {
    id: "forster-2024",
    title: "Indicators of Global Climate Change 2023: annual update of key indicators",
    authors: "Forster et al.",
    venue: "Earth System Science Data",
    year: 2024,
    discipline: "natural-sciences",
    kind: "article",
    readingState: "unread",
    integrity: "verified",
    access: "open-full-text",
    tags: ["climate", "indicators", "synthesis"],
    collection: "Annual indicators",
    identifier: "doi:10.5194/essd-16-2625-2024",
    sha256: "bf4172aa…8e13",
  },
  {
    id: "bishop-2021",
    title: "Artificial intelligence enabled drug discovery: first wave of clinical progress",
    authors: "Paul et al.",
    venue: "Nature Reviews Drug Discovery",
    year: 2021,
    discipline: "life-sciences",
    kind: "article",
    readingState: "read",
    integrity: "metadata-only",
    access: "abstract-only",
    tags: ["drug-discovery", "review", "machine-learning"],
    collection: "Methods watch",
    identifier: "doi:10.1038/s41573-021-00337-8",
  },
  {
    id: "stanford-ai-2024",
    title: "Artificial Intelligence Index Report 2024",
    authors: "Stanford Institute for Human-Centered AI",
    venue: "Stanford University",
    year: 2024,
    discipline: "technology",
    kind: "report",
    readingState: "reading",
    integrity: "changed",
    access: "local-copy",
    tags: ["AI", "policy", "indicators"],
    collection: "Technology policy",
    identifier: "local:hai-ai-index-2024",
    sha256: "previous 46b1…9c72 · current 8af0…6e22",
  },
  {
    id: "tsing-2015",
    title: "The Mushroom at the End of the World",
    authors: "Anna Lowenhaupt Tsing",
    venue: "Princeton University Press",
    year: 2015,
    discipline: "humanities",
    kind: "book",
    readingState: "read",
    integrity: "metadata-only",
    access: "abstract-only",
    tags: ["anthropology", "ecology", "capitalism"],
    collection: "Environmental humanities",
    identifier: "isbn:9780691162751",
  },
  {
    id: "benjamin-1936",
    title: "The Work of Art in the Age of Mechanical Reproduction",
    authors: "Walter Benjamin",
    venue: "Zeitschrift für Sozialforschung",
    year: 1936,
    discipline: "arts",
    kind: "article",
    readingState: "reading",
    integrity: "verified",
    access: "local-copy",
    tags: ["aesthetics", "media", "modernity"],
    collection: "Visual culture",
    identifier: "local:benjamin-werk-1936",
    sha256: "81e2b0ca…2d5f",
  },
  {
    id: "ostrom-1990",
    title: "Governing the Commons: The Evolution of Institutions for Collective Action",
    authors: "Elinor Ostrom",
    venue: "Cambridge University Press",
    year: 1990,
    discipline: "social-sciences",
    kind: "book",
    readingState: "unread",
    integrity: "metadata-only",
    access: "abstract-only",
    tags: ["institutions", "commons", "governance"],
    collection: "Collective action",
    identifier: "isbn:9780521405997",
  },
  {
    id: "jwst-2023",
    title: "A census of early galaxies observed by JWST",
    authors: "Finkelstein et al.",
    venue: "The Astrophysical Journal Letters",
    year: 2023,
    discipline: "natural-sciences",
    kind: "article",
    readingState: "unread",
    integrity: "verified",
    access: "open-full-text",
    tags: ["astronomy", "galaxies", "JWST"],
    collection: "Early universe",
    identifier: "doi:10.3847/2041-8213/acade4",
    sha256: "9b3d7110…d91c",
  },
] as const;
