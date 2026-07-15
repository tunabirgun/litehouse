import { useEffect, useRef, useState } from "react";
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

import { createTextQuoteAnchor, normaliseSelectedText } from "./anchors";
import type { ReaderAnnotation, TextQuoteAnchor } from "./types";

interface PageTextModel {
  fullText: string;
  itemStarts: number[];
  items: string[];
}

function textModel(items: readonly unknown[]): PageTextModel {
  const strings = items.flatMap((item) => {
    if (!item || typeof item !== "object" || !("str" in item)) return [];
    return typeof item.str === "string" ? [item.str] : [];
  });
  const itemStarts: number[] = [];
  let fullText = "";
  strings.forEach((value, index) => {
    if (index) fullText += " ";
    itemStarts.push(fullText.length);
    fullText += value;
  });
  return { fullText, itemStarts, items: strings };
}

function selectedItemIndex(container: HTMLElement, node: Node | null): number | null {
  if (!node) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const textRun = element?.closest<HTMLElement>("[data-text-item]");
  if (!textRun || !container.contains(textRun)) return null;
  const candidate = Number(textRun.dataset.textItem);
  return Number.isInteger(candidate) ? candidate : null;
}

function markTextRuns(
  textDivs: readonly HTMLElement[],
  page: number,
  annotations: readonly ReaderAnnotation[],
  activeSearchItemIndexes: readonly number[],
): void {
  textDivs.forEach((element, index) => {
    element.dataset.textItem = String(index);
    element.classList.toggle("reader-anchored-text", annotations.some((annotation) =>
      annotation.anchor.page === page &&
      index >= annotation.anchor.startTextItem &&
      index <= annotation.anchor.endTextItem,
    ));
    element.classList.toggle("reader-search-text", activeSearchItemIndexes.includes(index));
  });
}

function selectionOffset(model: PageTextModel, itemIndex: number, selectionText: string): number {
  const approximate = model.itemStarts[itemIndex] ?? 0;
  const exact = normaliseSelectedText(selectionText);
  const nearby = model.fullText.indexOf(exact, Math.max(0, approximate - 2));
  return nearby >= 0 ? nearby : approximate;
}

export function PdfSurface({
  document,
  pageNumber,
  zoom,
  rotation,
  annotations,
  activeSearchText,
  onSelection,
  onRendered,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  annotations: readonly ReaderAnnotation[];
  activeSearchText: string;
  onSelection: (anchor: TextQuoteAnchor) => void;
  onRendered?: (page: PDFPageProxy) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<PageTextModel | null>(null);
  const [renderState, setRenderState] = useState<"rendering" | "ready" | "error">("rendering");

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!canvas || !textContainer) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let textLayer: TextLayer | null = null;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;

    setRenderState("rendering");
    textContainer.replaceChildren();
    const render = async () => {
      page = await document.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: zoom, rotation });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      textContainer.style.width = `${Math.floor(viewport.width)}px`;
      textContainer.style.height = `${Math.floor(viewport.height)}px`;
      textContainer.style.setProperty("--total-scale-factor", String(viewport.scale));

      renderTask = page.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        background: "rgb(255, 255, 255)",
      });
      const content = await page.getTextContent();
      const model = textModel(content.items);
      modelRef.current = model;
      textLayer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (cancelled) return;

      const needle = activeSearchText.trim().toLocaleLowerCase();
      const matchingItems = needle
        ? model.items.flatMap((item, index) =>
            item.toLocaleLowerCase().includes(needle) ? [index] : [],
          )
        : [];
      markTextRuns(textLayer.textDivs, pageNumber, annotations, matchingItems);
      setRenderState("ready");
      onRendered?.(page);
    };

    void render().catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === "RenderingCancelledException")) return;
      setRenderState("error");
    });

    return () => {
      cancelled = true;
      textLayer?.cancel();
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [activeSearchText, annotations, document, onRendered, pageNumber, rotation, zoom]);

  function captureSelection() {
    const selection = window.getSelection();
    const container = textLayerRef.current;
    const model = modelRef.current;
    if (!selection || selection.isCollapsed || !container || !model || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const exact = normaliseSelectedText(selection.toString());
    if (exact.length < 2) return;
    const startTextItem = selectedItemIndex(container, range.startContainer);
    const endTextItem = selectedItemIndex(container, range.endContainer);
    if (startTextItem === null || endTextItem === null) return;
    const firstItem = Math.min(startTextItem, endTextItem);
    const lastItem = Math.max(startTextItem, endTextItem);
    onSelection(createTextQuoteAnchor({
      page: pageNumber,
      pageText: model.fullText,
      selectedText: exact,
      start: selectionOffset(model, firstItem, exact),
      startTextItem: firstItem,
      endTextItem: lastItem,
    }));
  }

  return (
    <div
      className="reader-pdf-page"
      aria-label={`PDF page ${pageNumber}`}
      aria-busy={renderState === "rendering"}
      onMouseUp={captureSelection}
      onTouchEnd={captureSelection}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div ref={textLayerRef} className="reader-text-layer" aria-label={`Selectable text for page ${pageNumber}`} />
      {renderState === "rendering" && <p className="reader-page-status">Rendering page {pageNumber}…</p>}
      {renderState === "error" && (
        <p className="reader-page-status reader-page-error" role="alert">
          This page could not be rendered. The source PDF has not been changed.
        </p>
      )}
    </div>
  );
}
export function PdfThumbnail({
  document,
  pageNumber,
  active,
  onSelect,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let page: PDFPageProxy | null = null;
    void document.getPage(pageNumber).then((loadedPage) => {
      page = loadedPage;
      if (cancelled) return;
      const viewport = loadedPage.getViewport({ scale: 0.18 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      renderTask = loadedPage.render({ canvas, viewport, background: "rgb(255, 255, 255)" });
      return renderTask.promise;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [document, pageNumber]);

  return (
    <button
      className={`reader-thumbnail${active ? " is-active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={`Go to page ${pageNumber}`}
      onClick={onSelect}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span>{pageNumber}</span>
    </button>
  );
}
