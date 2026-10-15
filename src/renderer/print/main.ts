import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/400-italic.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/600-italic.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/source-sans-3/700-italic.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/600.css';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PrintBridge } from '../../preload/print.js';
import type { PrintModel } from '../../render/model.js';
import { normalizeLength } from '../../config/schema.js';
import { pageGeometry } from '../../render/styles.js';
import { renderMermaid } from '../../render/mermaid.js';
import { RenderError } from '../../shared/errors.js';
import { decodedAsset, preparePageDecorations, type PageDecorations } from './page-decoration.js';
import { sanitizeSvg, scopeSvgIds, svgGeometry } from './sanitize-svg.js';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const bridge: PrintBridge = window.docmPrint;
let decorations: PageDecorations | undefined;

async function loadFonts(model: PrintModel): Promise<void> {
  for (const font of model.fonts) {
    if (!/^data:(?:font\/[a-z\d.+-]+|application\/[a-z\d.+-]+);base64,[a-z\d+/=\s]+$/i.test(font.dataUrl)) throw new Error(`Unsafe custom font bytes: ${font.family}`);
    try {
      const face = new FontFace(font.family, `url("${font.dataUrl}")`, { weight: String(font.weight), style: font.style });
      await face.load();
      document.fonts.add(face);
    } catch (cause) {
      const alias = font.family.replace(/^docm-font-/, '');
      const path = model.config.fonts[alias];
      throw new RenderError(`Cannot load custom font: ${path ?? font.family}`, path ? [path] : [], path ? { path, line: 1, column: 1 } : undefined, { cause });
    }
  }
  // Load every bundled weight/style, not merely whichever glyphs the first paragraph happened to use.
  await Promise.all([...document.fonts].map(async (face) => {
    try { await face.load(); } catch (cause) { throw new Error(`Cannot load bundled font ${face.family} (${face.weight}, ${face.style})`, { cause }); }
  }));
  await document.fonts.ready;
}

function availableWidth(element: HTMLElement): number {
  let parent = element.parentElement;
  while (parent && parent.clientWidth === 0) parent = parent.parentElement;
  if (!parent) throw new Error('Cannot measure a printable containing block');
  const style = getComputedStyle(parent);
  return parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

/** Scale every baseline metric together; SVG height alone is not a baseline. */
export function fittedMath(width: number, height: number, depth: number, maximumWidth: number, maximumHeight: number): { width: number; height: number; depth: number } {
  if (![width, height, maximumWidth, maximumHeight].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(depth)) throw new Error('Invalid math layout metrics');
  const scale = Math.min(1, maximumWidth / width, maximumHeight / height);
  return { width: width * scale, height: height * scale, depth: depth * scale };
}

async function prepareDocument(model: PrintModel): Promise<void> {
  const root = document.querySelector<HTMLElement>('.docm-document');
  if (!root) throw new Error('Print document wrapper is missing');
  const geometry = pageGeometry(model.config);
  const contentStyle = document.createElement('style');
  contentStyle.textContent = `${model.css}\nbody{width:${geometry.contentWidthPx}px;}@media print{.docm-decoration-measure{display:none!important;}}`;
  document.head.append(contentStyle);
  // HTML comes only from the trusted AST converter: raw Markdown HTML is escaped there.
  root.innerHTML = model.markdown.html;
  const placeholders = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-docm-image],[data-docm-diagram],[data-docm-math]')) {
    placeholders.set((element.dataset.docmImage ?? element.dataset.docmDiagram ?? element.dataset.docmMath)!, element);
  }
  const mathResults = new Map(model.math.map((result) => [result.id, result]));
  await loadFonts(model);
  const numberedLines = root.querySelectorAll<HTMLElement>('pre.docm-code-line-numbers .line');
  if (numberedLines.length) {
    // PDF text selection ignores CSS user-select. Rasterize only the decoration;
    // code itself remains selectable text in this and independent PDF viewers.
    const style = getComputedStyle(numberedLines[0]!, '::before');
    let width = parseFloat(style.width);
    const height = parseFloat(style.height);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context || !Number.isFinite(width + height) || width <= 0 || height <= 0) throw new Error('Cannot rasterize code line numbers with the configured font size');
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.font = font;
    const images = new Map<string, string>();
    for (const line of numberedLines) images.set(line.dataset.line!, '');
    for (const number of images.keys()) width = Math.max(width, context.measureText(number).width);
    root.style.setProperty('--docm-line-number-width', `${width}px`);
    canvas.width = Math.ceil(width * 4); canvas.height = Math.ceil(height * 4);
    context.scale(4, 4); context.font = font;
    context.fillStyle = style.color; context.textAlign = 'right';
    const metrics = context.measureText('0123456789');
    const baseline = (height - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
    for (const line of numberedLines) {
      const number = line.dataset.line!;
      let url = images.get(number);
      if (!url) {
        context.clearRect(0, 0, width, height);
        context.fillText(number, width, baseline);
        url = canvas.toDataURL('image/png');
        images.set(number, url);
      }
      line.style.setProperty('--docm-line-number-image', `url("${url}")`);
    }
    for (const url of images.values()) {
      const image = new Image(); image.src = url; await image.decode();
    }
  }
  const rootStyle = getComputedStyle(root);
  const documentInset = parseFloat(rootStyle.paddingTop) + parseFloat(rootStyle.paddingBottom) + parseFloat(rootStyle.borderTopWidth) + parseFloat(rootStyle.borderBottomWidth);
  const maximumBlockHeight = geometry.contentHeightPx - documentInset;
  if (maximumBlockHeight <= 0) throw new Error('Body padding and borders leave no printable height');

  for (const image of model.markdown.images) {
    const element = placeholders.get(image.id) as HTMLImageElement | undefined;
    const asset = model.images[image.id];
    if (!element || !asset) throw new RenderError('Prepared image is missing', [], image.source);
    try {
      const decoded = await decodedAsset(asset);
      element.src = decoded.url;
      await element.decode();
      const style = getComputedStyle(element);
      const horizontalInset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const verticalInset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const width = availableWidth(element) - horizontalInset;
      const height = maximumBlockHeight - verticalInset - parseFloat(style.marginTop) - parseFloat(style.marginBottom);
      if (width <= 0 || height <= 0) throw new Error('Image padding and spacing leave no printable area');
      const scale = Math.min(1, width / decoded.width, height / decoded.height);
      element.style.width = `${decoded.width * scale + horizontalInset}px`;
      element.style.height = `${decoded.height * scale + verticalInset}px`;
      element.classList.add('docm-keep-together');
    } catch (cause) { throw new RenderError(`Image: ${cause instanceof Error ? cause.message : String(cause)}`, [asset.path], image.source, { cause }); }
  }

  for (const [index, diagram] of model.markdown.diagrams.entries()) {
    const element = placeholders.get(diagram.id);
    if (!element) throw new RenderError('Prepared Mermaid diagram is missing', [], diagram.source);
    const config = model.config.mermaid.charts[String(index + 1)] ?? model.config.mermaid;
    const svg = await renderMermaid(diagram, config, normalizeLength(config.font_size));
    scopeSvgIds(svg, `docm-${diagram.id}`);
    const intrinsic = svgGeometry(svg);
    const style = getComputedStyle(element);
    const maximumHeight = maximumBlockHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) - parseFloat(style.marginTop) - parseFloat(style.marginBottom);
    const maximumWidth = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (maximumWidth <= 0 || maximumHeight <= 0) throw new RenderError('Mermaid padding and spacing leave no printable area', [], diagram.source);
    const requestedScale = config.width === undefined && config.height === undefined ? 1 : Math.min(
      config.width === undefined ? Infinity : normalizeLength(config.width) / intrinsic.width,
      config.height === undefined ? Infinity : normalizeLength(config.height) / intrinsic.height,
    );
    const scale = Math.min(requestedScale, maximumWidth / intrinsic.width, maximumHeight / intrinsic.height);
    svg.setAttribute('width', String(intrinsic.width * scale));
    svg.setAttribute('height', String(intrinsic.height * scale));
    // Override upstream responsive max-width/height after applying a single uniform scale.
    svg.style.removeProperty('max-width');
    svg.style.removeProperty('max-height');
    svg.style.width = `${intrinsic.width * scale}px`;
    svg.style.height = `${intrinsic.height * scale}px`;
    element.replaceChildren(svg);
    element.classList.add('docm-keep-together');
  }

  for (const expression of model.markdown.math) {
    const element = placeholders.get(expression.id);
    const result = mathResults.get(expression.id);
    if (!element || !result) throw new RenderError('Prepared math expression is missing', [], expression.source);
    try {
      const svg = sanitizeSvg(result.svg);
      svgGeometry(svg);
      scopeSvgIds(svg, `docm-${expression.id}`);
      const maximumWidth = availableWidth(element);
      if (!expression.display && result.widthPx > maximumWidth) element.classList.add('docm-math-own-line');
      const onOwnLine = expression.display || element.classList.contains('docm-math-own-line');
      const style = getComputedStyle(element);
      const maximumHeight = maximumBlockHeight - (onOwnLine ? parseFloat(style.marginTop) + parseFloat(style.marginBottom) : 0);
      const fit = fittedMath(result.widthPx, result.heightPx, result.depthPx, maximumWidth, maximumHeight);
      svg.setAttribute('width', String(fit.width)); svg.setAttribute('height', String(fit.height));
      svg.style.width = `${fit.width}px`; svg.style.height = `${fit.height}px`;
      element.style.verticalAlign = onOwnLine ? 'baseline' : `${-fit.depth}px`;
      element.replaceChildren(svg);
      if (onOwnLine) element.classList.add('docm-keep-together');
    } catch (cause) { throw new RenderError(`Math SVG: ${cause instanceof Error ? cause.message : String(cause)}`, [], expression.source, { cause }); }
  }

  decorations = await preparePageDecorations(model);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = decorations.css;
  document.head.append(pageStyle);
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode()));
  // Two animation frames make all DOM insertion/font/image measurements observable to printToPDF.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  decorations.validate();
  // Long code/tables/quotes remain splittable. Only measured single-page blocks get keep-together.
  for (const block of root.querySelectorAll<HTMLElement>('pre,table,blockquote,figure')) {
    const style = getComputedStyle(block);
    const height = block.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    block.classList.toggle('docm-keep-together', height <= maximumBlockHeight);
  }
}

bridge.onValidate(async ({ id, pdf }) => {
  let loading: PDFDocumentLoadingTask | undefined;
  let failure: string | undefined;
  try {
    loading = getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: false });
    const document = await loading.promise;
    if (!decorations) throw new Error('Print layout has not completed');
    decorations.validate(document.numPages);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  if (loading) {
    try { await loading.destroy(); }
    catch (cause) { failure ??= cause instanceof Error ? cause.message : String(cause); }
  }
  bridge.validated(failure === undefined ? { id, ok: true } : { id, ok: false, message: failure });
});

window.addEventListener('pagehide', () => decorations?.dispose(), { once: true });

void (async () => {
  try {
    await prepareDocument(await bridge.getModel());
    bridge.complete({ ok: true });
  } catch (cause) {
    bridge.complete({ ok: false, message: cause instanceof Error ? cause.message : String(cause), ...(cause instanceof RenderError && cause.source ? { source: cause.source } : {}) });
  }
})();
