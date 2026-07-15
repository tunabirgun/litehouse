function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function pageStream(title: string, kicker: string, paragraphs: readonly string[]): string {
  const lines = [
    "BT",
    "/F1 10 Tf",
    "72 738 Td",
    `(${escapePdfText("LITEHOUSE / READER FIXTURE")}) Tj`,
    "0 -48 Td",
    "/F1 22 Tf",
    `(${escapePdfText(title)}) Tj`,
    "0 -26 Td",
    "/F1 11 Tf",
    `(${escapePdfText(kicker)}) Tj`,
    "0 -42 Td",
    "/F1 12 Tf",
  ];
  paragraphs.forEach((paragraph) => {
    lines.push(`(${escapePdfText(paragraph)}) Tj`, "0 -24 Td");
  });
  lines.push("0 -300 Td", "/F1 9 Tf", "(Open demonstration record / CC BY 4.0 / Page fixture) Tj", "ET");
  return `${lines.join("\n")}\n`;
}

function streamObject(stream: string): string {
  return `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}endstream`;
}

/** A deterministic, redistributable three-page PDF used by the local reader demo. */
export function createDemoPdf(): Uint8Array {
  const streams = [
    pageStream("Reading evidence, not summaries", "1 / Premise", [
      "Litehouse keeps each interpretation beside its inspectable source record.",
      "A readable report remains bounded by the evidence that was actually retrieved.",
      "Select this sentence to create a deterministic highlight or an anchored note.",
      "Search for evidence, provenance, or reproducibility across this document.",
    ]),
    pageStream("A traceable research object", "2 / Provenance", [
      "The source receipt records acquisition time, license, URL, byte length, and SHA-256.",
      "The reader does not contact remote hosts: parsing and rendering stay on this device.",
      "Annotations preserve a page, exact quotation, surrounding context, and text offsets.",
      "These anchors make notes useful without silently changing the underlying article.",
    ]),
    pageStream("Review, annotate, verify", "3 / Practice", [
      "Search results lead back to the page on which the matching evidence appears.",
      "Markdown export stays legible; JSON export preserves the complete anchor model.",
      "A stored reading position can be restored without altering the source PDF bytes.",
      "Reproducibility begins with clear limits and ends with a verifiable source hash.",
    ]),
  ];

  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R /Outlines 11 0 R /PageMode /UseOutlines >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>"],
    [4, streamObject(streams[0])],
    [5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>"],
    [6, streamObject(streams[1])],
    [7, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>"],
    [8, streamObject(streams[2])],
    [9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
    [10, "<< /Title (Litehouse Reader Demonstration) /Author (Litehouse contributors) /Creator (Litehouse deterministic fixture v1) >>"],
    [11, "<< /Type /Outlines /First 12 0 R /Last 14 0 R /Count 3 >>"],
    [12, "<< /Title (Premise) /Parent 11 0 R /Dest [3 0 R /Fit] /Next 13 0 R >>"],
    [13, "<< /Title (Provenance) /Parent 11 0 R /Dest [5 0 R /Fit] /Prev 12 0 R /Next 14 0 R >>"],
    [14, "<< /Title (Practice) /Parent 11 0 R /Dest [7 0 R /Fit] /Prev 13 0 R >>"],
  ]);
  const encoder = new TextEncoder();
  let document = "%PDF-1.7\n%Litehouse\n";
  const offsets = [0];
  for (let objectNumber = 1; objectNumber <= objects.size; objectNumber += 1) {
    offsets[objectNumber] = encoder.encode(document).length;
    document += `${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(document).length;
  document += `xref\n0 ${objects.size + 1}\n`;
  document += "0000000000 65535 f \n";
  for (let objectNumber = 1; objectNumber <= objects.size; objectNumber += 1) {
    document += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R /Info 10 0 R >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(document);
}
