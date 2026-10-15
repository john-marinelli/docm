import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/js/svg.js';
import type { DynamicFile } from '@mathjax/src/js/output/common/FontData.js';
import type { LiteDocument } from '@mathjax/src/js/adaptors/lite/Document.js';
import type { LiteElement } from '@mathjax/src/js/adaptors/lite/Element.js';
import type { LiteText } from '@mathjax/src/js/adaptors/lite/Text.js';
import { HandlerType } from '@mathjax/src/js/input/tex/HandlerTypes.js';
import { CommandMap } from '@mathjax/src/js/input/tex/TokenMap.js';
import { Macro } from '@mathjax/src/js/input/tex/Token.js';
import NewcommandMethods from '@mathjax/src/js/input/tex/newcommand/NewcommandMethods.js';
import { NewcommandTables } from '@mathjax/src/js/input/tex/newcommand/NewcommandUtil.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';
import { normalizeLength, type MathConfig } from '../config/schema.js';
import { RenderError } from '../shared/errors.js';
import type { MathExpression, MathSvg } from '../shared/types.js';

// Vite eagerly bundles every NewCM SVG range. The font modules register setup
// functions, but do not install them on a font instance until loadDynamicFiles().
// No MathJax component loader, dynamic import, file lookup, or network is used.
const bundledFontRanges = import.meta.glob('../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js', { eager: true });
const rangeNames: Record<string, true> = Object.fromEntries(Object.keys(bundledFontRanges).map((name) => [name.slice(name.lastIndexOf('/') + 1, -3), true]));
class OfflineNewcmFont extends MathJaxNewcmFont {
  override async loadDynamicFile(dynamic: DynamicFile): Promise<void> {
    if (dynamic.extension || !Object.hasOwn(rangeNames, dynamic.file)) {
      throw new Error(`NewCM vector font range is not bundled: ${dynamic.file}`);
    }
    dynamic.setup(this);
    if (dynamic.failed) throw new Error(`NewCM vector font range failed to initialize: ${dynamic.file}`);
  }
}

// Unsupported glyphs must not silently use unbundled operating-system fonts.
class VectorSVG extends SVG<LiteElement, LiteText, LiteDocument> {
  override unknownText(text: string, _variant: string): LiteElement {
    throw new Error(`NewCM has no vector glyph for ${JSON.stringify(text)}`);
  }
}

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const font = new OfflineNewcmFont();
let fontReady: Promise<void[]> | undefined;
const packages = ['base', 'ams', 'mathtools', 'newcommand', 'textmacros', 'boldsymbol', 'color'];
const inputLimit = 64 * 1024;
const cacheEntryLimit = 512;
const cacheByteLimit = 32 * 1024 * 1024;
type CachedMath = Omit<MathSvg, 'id'>;
type CacheEntry = { value: CachedMath; bytes: number };
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
let cacheGeneration = 0;

/** Session closure also prevents in-flight conversions repopulating the LRU. */
export function clearMathCache(): void {
  cache.clear();
  cacheBytes = 0;
  cacheGeneration++;
}

function cached(key: string): CachedMath | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function remember(key: string, value: CachedMath, generation: number): void {
  if (generation !== cacheGeneration) return;
  const bytes = Buffer.byteLength(value.svg, 'utf8') + Buffer.byteLength(key, 'utf8') + 24;
  if (bytes > cacheByteLimit) return;
  const old = cache.get(key);
  if (old) { cacheBytes -= old.bytes; cache.delete(key); }
  while (cache.size >= cacheEntryLimit || cacheBytes + bytes > cacheByteLimit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
  cache.set(key, { value, bytes });
  cacheBytes += bytes;
}


function inputJax(config: MathConfig): TeX<LiteElement, LiteText, LiteDocument> {
  const input = new TeX<LiteElement, LiteText, LiteDocument>({
    packages,
    maxBuffer: inputLimit,
    maxMacros: 1000,
    maxTemplateSubtitutions: 1000,
    tags: 'none',
    formatError: (_jax: unknown, error: Error) => { throw error; },
  });
  const handlers = input.parseOptions.handlers;
  const macros = handlers.retrieve(NewcommandTables.NEW_COMMAND) as CommandMap;
  for (const [name, macro] of Object.entries(config.macros)) {
    if (handlers.get(HandlerType.MACRO).contains(name)) {
      throw new Error(`Configured macro \\${name} redefines a built-in command`);
    }
    macros.add(name, new Macro(name, NewcommandMethods.Macro, [macro.body, macro.args]));
  }
  return input;
}

function svgLength(value: string, emPx: number, exPx: number): number {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(ex|em|px)?$/.exec(value);
  if (!match) throw new Error(`Invalid MathJax SVG length: ${value}`);
  const amount = Number(match[1]);
  return amount * (match[2] === 'ex' ? exPx : match[2] === 'em' ? emPx : 1);
}

function measuredSvg(container: LiteElement, emPx: number, exPx: number): CachedMath {
  const roots = adaptor.tags(container, 'svg');
  if (roots.length !== 1) throw new Error('MathJax did not produce one complete SVG expression');
  const root = roots[0]!;
  const widthPx = svgLength(String(adaptor.getAttribute(root, 'width')), emPx, exPx);
  const heightPx = svgLength(String(adaptor.getAttribute(root, 'height')), emPx, exPx);
  // SVG.createSVG() authors vertical-align as -depth / font.params.x_height ex.
  // convertPromise receives that same explicit font-derived ex size in pixels.
  const depthPx = -svgLength(adaptor.getStyle(root, 'vertical-align'), emPx, exPx);
  const viewBox = String(adaptor.getAttribute(root, 'viewBox')).trim().split(/\s+/).map(Number);
  if (![widthPx, heightPx, depthPx, ...viewBox].every(Number.isFinite) || widthPx <= 0 || heightPx <= 0 || viewBox.length !== 4 || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
    throw new Error('MathJax produced invalid SVG geometry');
  }
  // Account only for MathJax's documented serialization rounding (0.001 ex,
  // 0.1 viewBox unit), not guessed padding or a guessed baseline from height.
  const cropDepth = (viewBox[1]! + viewBox[3]!) * emPx / 1000;
  if (Math.abs(cropDepth - depthPx) > exPx * 0.001 + emPx * 0.0002) {
    throw new Error('MathJax SVG crop disagrees with its baseline alignment');
  }
  adaptor.setAttribute(root, 'width', `${widthPx}px`);
  adaptor.setAttribute(root, 'height', `${heightPx}px`);
  // The print renderer owns baseline placement and fit scaling. Keep only the
  // vector root, never MathJax's HTML container or its inherited styles.
  adaptor.removeAttribute(root, 'style');
  // MathJax's SVG stylesheet permits ink overhangs (e.g. italic glyphs and
  // explicit smash/lap constructs). Preserve that property without its HTML.
  adaptor.setAttribute(root, 'overflow', 'visible');
  // Source annotations are not part of the printed vector image. Remove them
  // before SVG reference validation; literal text can contain CSS-like words.
  const elements=[root];
  while(elements.length){
    const element=elements.pop()!;
    for(const attribute of adaptor.allAttributes(element))if(attribute.name.startsWith('data-'))adaptor.removeAttribute(element,attribute.name);
    for(const child of adaptor.childNodes(element))if(!adaptor.kind(child).startsWith('#'))elements.push(child as LiteElement);
  }
  return { svg: adaptor.outerHTML(root), widthPx, heightPx, depthPx };
}

export async function renderMath(expressions: MathExpression[], config: MathConfig, options: { signal: AbortSignal }): Promise<MathSvg[]> {
  options.signal.throwIfAborted();
  if (!expressions.length) return [];
  const generation = cacheGeneration;
  const dependencies = [...new Set(expressions.map((expression) => expression.source.path))];
  const settings = JSON.stringify([mathjax.version, 'NewCM-4.1.3', config.font_size, Object.entries(config.macros).sort(([a], [b]) => a.localeCompare(b)).map(([name, macro]) => [name, macro.args, macro.body])]);
  const emPx = normalizeLength(config.font_size);
  const exPx = emPx * font.params.x_height;
  const values = new Map<string, CachedMath>();
  const results: MathSvg[] = [];
  for (const expression of expressions) {
    options.signal.throwIfAborted();
    if (!expression.tex.trim()) throw new RenderError('Math expression is empty', dependencies, expression.source);
    if (expression.tex.length > inputLimit) throw new RenderError('Math expression exceeds the 64 KiB parser limit', dependencies, expression.source);
    const key = createHash('sha256').update(settings).update(JSON.stringify([expression.tex, expression.display])).digest('hex');
    let value = values.get(key) ?? cached(key);
    if (!value) {
      try {
        await (fontReady ??= font.loadDynamicFiles());
        options.signal.throwIfAborted();
        // A fresh TeX parser and document for each expression isolates all macro,
        // environment, label, color and mathtools state, including user \def.
        const input = inputJax(config);
        const output = new VectorSVG({ fontData: font, fontCache: 'none', linebreaks: { inline: false } });
        const document = mathjax.document('', {
          InputJax: input,
          OutputJax: output,
          compileError: (_document: unknown, _math: unknown, error: Error) => { throw error; },
          typesetError: (_document: unknown, _math: unknown, error: Error) => { throw error; },
        });
        const node = await document.convertPromise(expression.tex, { display: expression.display, em: emPx, ex: exPx, containerWidth: 1000000, scale: 1 });
        options.signal.throwIfAborted();
        value = measuredSvg(node as LiteElement, emPx, exPx);
        remember(key, value, generation);
      } catch (error) {
        options.signal.throwIfAborted();
        throw new RenderError(`Math: ${error instanceof Error ? error.message : String(error)}`, dependencies, expression.source, { cause: error });
      }
      // Yield between bounded conversions so source changes/session closure can
      // abort a long document without waiting for every expression to finish.
      await setImmediate(undefined, { signal: options.signal });
    }
    values.set(key, value);
    results.push({ id: expression.id, ...value });
  }
  options.signal.throwIfAborted();
  return results;
}
