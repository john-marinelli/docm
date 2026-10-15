import { normalizeLength, type Config } from '../../config/schema.js';
import { pageGeometry } from '../../render/styles.js';
import type { ImageAsset, PrintModel } from '../../render/model.js';
import { sanitizeSvg, svgDataUrl, svgGeometry } from './sanitize-svg.js';

const positions = ['left', 'center', 'right'] as const;
const clearancePx = 2 * 96 / 25.4;
type TextPart = { text: string } | { counter: 'page' | 'pages' };

export function cssString(value: string): string {
  return `"${value.replace(/["\\\u0000-\u001f\u007f<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}"`;
}

/** Escaped braces are literal; substituted title/filename bytes never become tokens. */
export function decorationParts(value: string, filename: string, title: string): TextPart[] {
  const parts: TextPart[] = [];
  let text = '';
  const flush = () => { if (text) { parts.push({ text }); text = ''; } };
  for (let index = 0; index < value.length;) {
    if (value.startsWith('{{{{', index)) { text += '{{'; index += 4; }
    else if (value.startsWith('}}}}', index)) { text += '}}'; index += 4; }
    else if (value.startsWith('{{', index)) {
      const end = value.indexOf('}}', index + 2);
      const token = value.slice(index + 2, end);
      if (end < 0 || !['filename', 'title', 'page', 'pages'].includes(token)) throw new Error('Unknown decoration token');
      if (token === 'filename' || token === 'title') text += token === 'filename' ? filename : title;
      else { flush(); parts.push({ counter: token === 'page' ? 'page' : 'pages' }); }
      index = end + 2;
    } else if (value.startsWith('}}', index)) throw new Error('Unescaped decoration closing braces');
    else { text += value[index]!; index += 1; }
  }
  flush();
  return parts;
}

export function decorationContent(parts: TextPart[]): string {
  return parts.map((part) => 'text' in part ? cssString(part.text) : `counter(${part.counter})`).join(' ');
}

export async function decodedAsset(asset: ImageAsset): Promise<{ url: string; width: number; height: number }> {
  let url = asset.dataUrl;
  if (asset.svg !== undefined) {
    const svg = sanitizeSvg(asset.svg);
    const geometry = svgGeometry(svg);
    svg.setAttribute('width', String(geometry.width));
    svg.setAttribute('height', String(geometry.height));
    url = svgDataUrl(svg);
  } else if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(url)) {
    throw new Error(`Unsupported or unsafe image bytes: ${asset.path}`);
  }
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch (cause) { throw new Error(`Cannot decode image: ${asset.path}`, { cause }); }
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error(`Image has no valid dimensions: ${asset.path}`);
  return { url, width: image.naturalWidth, height: image.naturalHeight };
}

/** Only approved decoded bytes or sanitized vector nodes enter this app-created wrapper. */
export async function logoWrapper(asset: ImageAsset, width: number, height: number, position: typeof positions[number]): Promise<string> {
  const approved = await decodedAsset(asset);
  const alignment = position === 'left' ? 'xMinYMid meet' : position === 'right' ? 'xMaxYMid meet' : 'xMidYMid meet';
  const ns = 'http://www.w3.org/2000/svg';
  const wrapper = document.createElementNS(ns, 'svg');
  wrapper.setAttribute('width', String(width));
  wrapper.setAttribute('height', String(height));
  wrapper.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (asset.svg !== undefined) {
    const vector = sanitizeSvg(asset.svg);
    svgGeometry(vector);
    vector.setAttribute('x', '0'); vector.setAttribute('y', '0');
    vector.setAttribute('width', String(width)); vector.setAttribute('height', String(height));
    vector.setAttribute('preserveAspectRatio', alignment);
    wrapper.append(vector);
  } else {
    const image = document.createElementNS(ns, 'image');
    image.setAttribute('href', approved.url);
    image.setAttribute('width', String(width)); image.setAttribute('height', String(height));
    image.setAttribute('preserveAspectRatio', alignment);
    wrapper.append(image);
  }
  return svgDataUrl(wrapper);
}

function family(alias: string): string {
  return cssString(alias === 'sans' ? 'Source Sans 3' : alias === 'mono' ? 'Source Code Pro' : `docm-font-${alias}`);
}

function typography(decoration: Config['header']): string {
  return `font-family:${family(decoration.font)};font-size:${normalizeLength(decoration.font_size)}px;font-weight:${decoration.font_weight};font-style:${decoration.font_style};line-height:${decoration.line_height};color:${decoration.color};white-space:pre-wrap;overflow-wrap:anywhere;`;
}

export type PageDecorations = { css: string; validate(pageCount?: number): void; dispose(): void };

export async function preparePageDecorations(model: PrintModel): Promise<PageDecorations> {
  const geometry = pageGeometry(model.config);
  const slotWidth = geometry.contentWidthPx / 3;
  const measurementRoot = document.createElement('div');
  measurementRoot.className = 'docm-decoration-measure';
  measurementRoot.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
  document.body.append(measurementRoot);
  const slots: { row: 'header' | 'footer'; element: HTMLDivElement; parts: TextPart[]; logo?: HTMLImageElement }[] = [];
  const rules: string[] = [];
  try {
    for (const row of ['header', 'footer'] as const) {
      const decoration = model.config[row];
      let logoUrl: string | undefined;
      if (decoration.enabled && decoration.logo !== false) {
        const asset = model.logos[row];
        if (!asset) throw new Error(`Missing ${row}.logo image`);
        if (normalizeLength(decoration.logo.width) > slotWidth) throw new Error(`${row}.logo is wider than its page-decoration slot; reduce its width`);
        logoUrl = await logoWrapper(asset, normalizeLength(decoration.logo.width), normalizeLength(decoration.logo.height), decoration.logo.position);
      }
      for (const position of positions) {
        const parts = decoration.enabled ? decorationParts(decoration[position], model.filename, model.markdown.title) : [];
        const withLogo = logoUrl !== undefined && decoration.logo !== false && decoration.logo.position === position;
        const content = [withLogo ? `url(${cssString(logoUrl!)})` : '', decorationContent(parts)].filter(Boolean).join(' ');
        const box = `@${row === 'header' ? 'top' : 'bottom'}-${position}`;
        rules.push(`${box}{content:${content || 'none'};width:${slotWidth}px;max-width:${slotWidth}px;margin:0;padding:${clearancePx}px 0;vertical-align:middle;text-align:${position};${typography(decoration)}}`);
        if (!content) continue;
        const element = document.createElement('div');
        element.style.cssText = `width:${slotWidth}px;text-align:${position};${typography(decoration)}`;
        let logo: HTMLImageElement | undefined;
        if (withLogo && decoration.logo !== false) {
          logo = new Image(); logo.src = logoUrl!;
          logo.width = Math.round(normalizeLength(decoration.logo.width));
          logo.height = Math.round(normalizeLength(decoration.logo.height));
          logo.style.width = `${normalizeLength(decoration.logo.width)}px`;
          logo.style.height = `${normalizeLength(decoration.logo.height)}px`;
          logo.style.verticalAlign = 'baseline';
          await logo.decode();
        }
        measurementRoot.append(element);
        slots.push({ row, element, parts, ...(logo ? { logo } : {}) });
      }
    }
    const margins = geometry.margins;
    const css = `@page{size:${geometry.widthPx}px ${geometry.heightPx}px;margin:${margins.top}px ${margins.right}px ${margins.bottom}px ${margins.left}px;${rules.join('')}}`;
    // Parse support is necessary, but actual native counter support is qualified by the PDF consumer smoke.
    const probe = new CSSStyleSheet(); probe.replaceSync(css);
    if (!probe.cssRules[0]?.cssText.includes('@top-left')) throw new Error('Chromium page margin boxes (131 or later) are required');
    const validate = (pageCount?: number) => {
      if (pageCount !== undefined && (!Number.isSafeInteger(pageCount) || pageCount < 1)) throw new Error('PDF has an invalid page count');
      const pageCandidates = pageCount === undefined ? ['1'] : widestPageCandidates(pageCount);
      for (const slot of slots) {
        let maximumHeight = 0;
        for (const page of pageCandidates) {
          slot.element.replaceChildren();
          if (slot.logo) slot.element.append(slot.logo);
          slot.element.append(document.createTextNode(slot.parts.map((part) => 'text' in part ? part.text : part.counter === 'pages' ? String(pageCount ?? 1) : page).join('')));
          maximumHeight = Math.max(maximumHeight, slot.element.getBoundingClientRect().height);
        }
        const margin = slot.row === 'header' ? margins.top : margins.bottom;
        if (maximumHeight + 2 * clearancePx > margin + 0.01) {
          const required = (maximumHeight + 2 * clearancePx) * 25.4 / 96;
          throw new Error(`${slot.row} content overflows the ${slot.row === 'header' ? 'top' : 'bottom'} page margin; increase that margin to at least ${required.toFixed(2)}mm or reduce ${slot.row} font/logo size or text`);
        }
      }
    };
    return { css, validate, dispose: () => measurementRoot.remove() };
  } catch (error) { measurementRoot.remove(); throw error; }
}

/** Cover proportional digits as well as counters' digit count, without assuming 8 is widest. */
export function widestPageCandidates(pageCount: number): string[] {
  const digits = String(pageCount).length;
  const candidates = new Set([String(pageCount)]);
  for (let length = 1; length <= digits; length += 1) {
    for (let digit = 0; digit <= 9; digit += 1) candidates.add(String(digit).repeat(length));
  }
  return [...candidates];
}
