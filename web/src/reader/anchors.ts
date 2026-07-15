import type { ReaderAnnotation, TextQuoteAnchor } from "./types";

const CONTEXT_LENGTH = 36;

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normaliseSelectedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function createTextQuoteAnchor({
  page,
  pageText,
  selectedText,
  start,
  startTextItem,
  endTextItem,
}: {
  page: number;
  pageText: string;
  selectedText: string;
  start: number;
  startTextItem: number;
  endTextItem: number;
}): TextQuoteAnchor {
  const exact = normaliseSelectedText(selectedText);
  const safeStart = Math.max(0, Math.min(start, pageText.length));
  const end = Math.min(pageText.length, safeStart + exact.length);
  return {
    page,
    exact,
    prefix: pageText.slice(Math.max(0, safeStart - CONTEXT_LENGTH), safeStart),
    suffix: pageText.slice(end, end + CONTEXT_LENGTH),
    start: safeStart,
    end,
    startTextItem,
    endTextItem,
  };
}

export function createAnnotation({
  documentSha256,
  kind,
  anchor,
  body = "",
  timestamp = new Date().toISOString(),
}: {
  documentSha256: string;
  kind: ReaderAnnotation["kind"];
  anchor: TextQuoteAnchor;
  body?: string;
  timestamp?: string;
}): ReaderAnnotation {
  const fingerprint = [
    anchor.exact,
  ].join("\u241f");
  return {
    id: [
      "ann",
      documentSha256.slice(0, 12),
      kind === "highlight" ? "h" : "n",
      anchor.page,
      anchor.start,
      anchor.end,
      stableHash(fingerprint),
    ].join("-"),
    documentSha256,
    kind,
    anchor,
    body: body.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function locateAnchor(pageText: string, anchor: TextQuoteAnchor): number | null {
  if (pageText.slice(anchor.start, anchor.end) === anchor.exact) return anchor.start;
  const candidates: number[] = [];
  let from = 0;
  while (from <= pageText.length) {
    const candidate = pageText.indexOf(anchor.exact, from);
    if (candidate < 0) break;
    candidates.push(candidate);
    from = candidate + Math.max(1, anchor.exact.length);
  }
  if (!candidates.length) return null;
  const contextual = candidates.find((candidate) => {
    const prefix = pageText.slice(Math.max(0, candidate - anchor.prefix.length), candidate);
    const suffix = pageText.slice(
      candidate + anchor.exact.length,
      candidate + anchor.exact.length + anchor.suffix.length,
    );
    return prefix === anchor.prefix && suffix === anchor.suffix;
  });
  return contextual ?? candidates.reduce((best, candidate) =>
    Math.abs(candidate - anchor.start) < Math.abs(best - anchor.start) ? candidate : best,
  );
}

export function annotationsToMarkdown(
  title: string,
  citation: string,
  documentSha256: string,
  annotations: readonly ReaderAnnotation[],
): string {
  const lines = [
    `# Notes — ${title}`,
    "",
    citation,
    "",
    `Source SHA-256: \`${documentSha256}\``,
    "",
  ];
  const sorted = [...annotations].sort(
    (left, right) => left.anchor.page - right.anchor.page || left.anchor.start - right.anchor.start,
  );
  if (!sorted.length) lines.push("_No annotations._", "");
  sorted.forEach((annotation, index) => {
    lines.push(`## ${index + 1}. Page ${annotation.anchor.page} · ${annotation.kind}`, "");
    lines.push(`> ${annotation.anchor.exact}`, "");
    if (annotation.body) lines.push(annotation.body, "");
    lines.push(
      `Anchor: \`${annotation.id}\` · characters ${annotation.anchor.start}–${annotation.anchor.end}`,
      "",
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function annotationsToJson(
  title: string,
  citation: string,
  documentSha256: string,
  annotations: readonly ReaderAnnotation[],
): string {
  return `${JSON.stringify(
    {
      schema: "https://litehouse.local/schemas/reader-annotations/v1",
      document: { title, citation, sha256: documentSha256 },
      annotations: [...annotations].sort((left, right) => left.id.localeCompare(right.id)),
    },
    null,
    2,
  )}\n`;
}
