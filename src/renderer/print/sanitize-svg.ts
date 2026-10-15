import DOMPurify from 'dompurify';

const svgNamespace = 'http://www.w3.org/2000/svg';

/** Decode CSS escapes before checking references, including escaped url/import names. */
function decodedCss(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi,
    (_, hex: string | undefined, character: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : character!);
}

function checkCss(value: string): void {
  const decoded = decodedCss(value);
  if (/@(?:import|font-face|namespace)\b|(?:expression|image-set|src)\s*\(/i.test(decoded)) throw new Error('SVG external or executable CSS is not allowed');
  const references = decoded.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi);
  for (const match of references) {
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!/^#[^\s"'<>]+$/.test(reference)) throw new Error('SVG references must be local fragments');
  }
  // An unclosed URL must not evade the reference check and later be repaired by CSS parsing.
  if ((decoded.match(/\burl\s*\(/gi)?.length ?? 0) !== [...decoded.matchAll(/url\s*\([^)]*\)/gi)].length) throw new Error('Malformed SVG CSS reference');
}

function checkTree(root: Element): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animatetransform', 'animatemotion', 'set'].includes(element.localName.toLowerCase())) throw new Error(`Unsafe SVG element: ${element.localName}`);
    for (const attribute of element.attributes) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith('on')) throw new Error('SVG event handlers are not allowed');
      if (name === 'href' || name === 'src') {
        if (!/^#[^\s"'<>]+$/.test(attribute.value.trim())) throw new Error('SVG references must be local fragments');
      }
      if (name === 'base') throw new Error('SVG base URLs are not allowed');
      checkCss(attribute.value);
    }
    if (element.localName.toLowerCase() === 'style') checkCss(element.textContent ?? '');
  }
}

/** One sanitizer for local assets, MathJax equations, and Mermaid, before live insertion. */
export function sanitizeSvg(source: string): SVGSVGElement {
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(source.replace(/^\s*<\?xml[^?]*\?>/i, ''))) throw new Error('SVG document declarations are not allowed');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== svgNamespace) throw new Error('Invalid SVG document');
  checkTree(parsed.documentElement);
  const clean = DOMPurify.sanitize(parsed.documentElement, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Every href is checked as a local fragment before and after purification.
    ADD_TAGS: ['use'],
    ADD_ATTR: ['href', 'xlink:href'],
    FORBID_TAGS: ['foreignObject', 'script', 'animate', 'animateTransform', 'animateMotion', 'set'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  });
  const root = clean instanceof Element ? (clean.localName === 'svg' ? clean : clean.querySelector('svg')) : clean instanceof DocumentFragment ? clean.querySelector('svg') : null;
  if (!root || root.namespaceURI !== svgNamespace) throw new Error('SVG sanitization removed its root');
  checkTree(root);
  return document.importNode(root, true) as unknown as SVGSVGElement;
}

export function svgDataUrl(svg: SVGSVGElement): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

export function svgGeometry(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2]! <= 0 || viewBox[3]! <= 0)) throw new Error('Invalid SVG viewBox');
  const dimension = (name: string): number | undefined => {
    const match = /^(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|mm|cm|in)?$/i.exec(svg.getAttribute(name) ?? '');
    if (!match) return undefined;
    const multiplier: Record<string, number> = { px: 1, pt: 96 / 72, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
    return Number(match[1]) * multiplier[match[2]?.toLowerCase() ?? 'px']!;
  };
  const width = dimension('width') ?? viewBox?.[2];
  const height = dimension('height') ?? viewBox?.[3];
  if (width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('SVG requires finite positive dimensions or a viewBox');
  if (!viewBox) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return { width, height };
}

/** SVG glyph IDs are document-global: isolate separately rendered math and diagrams. */
export function scopeSvgIds(svg: SVGSVGElement, prefix: string): void {
  const identifiers = new Map<string, string>();
  for (const element of [svg, ...svg.querySelectorAll('[id]')]) {
    if (element.id) identifiers.set(element.id, `${prefix}-${element.id}`);
  }
  const replaceReferences = (value: string) => value.replace(/#([^\s"'(){};,<>]+)/g,
    (match, id: string) => identifiers.has(id) ? `#${identifiers.get(id)}` : match);
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    if (element.id) element.id = identifiers.get(element.id)!;
    for (const attribute of [...element.attributes]) {
      if (attribute.localName === 'id') continue;
      const value = attribute.localName === 'href' ? replaceReferences(attribute.value) : attribute.value.replace(/url\(([\s"']*)#([^\s"'()]+)([\s"']*)\)/gi, (_match, before: string, id: string, after: string) => `url(${before}#${identifiers.get(id) ?? id}${after})`);
      element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    }
    if (element.localName === 'style') element.textContent = replaceReferences(element.textContent ?? '');
  }
}
