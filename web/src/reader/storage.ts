import type { ReaderAnnotation, ReaderProgress } from "./types";

const STORAGE_PREFIX = "litehouse.reader.v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadAnnotations(sha256: string): ReaderAnnotation[] {
  const value = readJson<unknown>(`${STORAGE_PREFIX}.annotations.${sha256}`, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ReaderAnnotation => {
    if (!item || typeof item !== "object") return false;
    const annotation = item as Partial<ReaderAnnotation>;
    return (
      typeof annotation.id === "string" &&
      annotation.documentSha256 === sha256 &&
      (annotation.kind === "highlight" || annotation.kind === "note") &&
      typeof annotation.anchor?.exact === "string" &&
      typeof annotation.anchor.page === "number"
    );
  });
}

export function saveAnnotations(sha256: string, annotations: readonly ReaderAnnotation[]): void {
  window.localStorage.setItem(
    `${STORAGE_PREFIX}.annotations.${sha256}`,
    JSON.stringify(annotations),
  );
}

export function loadProgress(sha256: string): ReaderProgress | null {
  const value = readJson<Partial<ReaderProgress> | null>(
    `${STORAGE_PREFIX}.progress.${sha256}`,
    null,
  );
  if (!value || typeof value.page !== "number" || typeof value.zoom !== "number") return null;
  if (value.fitMode !== "width" && value.fitMode !== "page" && value.fitMode !== "custom") {
    return null;
  }
  if (value.rotation !== 0 && value.rotation !== 90 && value.rotation !== 180 && value.rotation !== 270) {
    return null;
  }
  return value as ReaderProgress;
}

export function saveProgress(sha256: string, progress: ReaderProgress): void {
  window.localStorage.setItem(`${STORAGE_PREFIX}.progress.${sha256}`, JSON.stringify(progress));
}
