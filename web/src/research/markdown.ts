// A minimal inline-markdown tokenizer for the limited subset the report generator
// emits: **strong**, *emphasis*, `code`, and backslash escapes (\_ \< \* …). Report
// content is passed through escapeMarkdown() before structural markup is added, so a
// correct renderer MUST honour the backslash escapes — otherwise raw \_ \< and stray
// asterisks leak onto the page and into the LaTeX export.

export type InlineToken = { type: "text" | "strong" | "em" | "code"; value: string };

// Reverse escapeMarkdown() (report.ts): \X -> X for the escaped metacharacters.
export function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_[\]<>])/gu, "$1");
}

export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { tokens.push({ type: "text", value: buffer }); buffer = ""; } };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length) { buffer += input[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) { flush(); tokens.push({ type: "code", value: unescapeMarkdown(input.slice(i + 1, end)) }); i = end + 1; continue; }
      buffer += "`"; i += 1; continue;
    }
    if (input.startsWith("**", i)) {
      const end = input.indexOf("**", i + 2);
      if (end > i + 1) { flush(); tokens.push({ type: "strong", value: unescapeMarkdown(input.slice(i + 2, end)) }); i = end + 2; continue; }
      buffer += "**"; i += 2; continue;
    }
    if (ch === "*") {
      const end = input.indexOf("*", i + 1);
      if (end > i) { flush(); tokens.push({ type: "em", value: unescapeMarkdown(input.slice(i + 1, end)) }); i = end + 1; continue; }
      buffer += "*"; i += 1; continue;
    }
    buffer += ch; i += 1;
  }
  flush();
  return tokens;
}
