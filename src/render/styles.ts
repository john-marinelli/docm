import { normalizeLength, type Config, type ElementStyle, type Length } from '../config/schema.js';

export interface PageGeometry {
  widthPx: number;
  heightPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
  margins: { top: number; bottom: number; left: number; right: number };
}

const namedSizes = {
  A4: [210, 297], A3: [297, 420], A5: [148, 210],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6],
} as const;

/** Geometry uses the same 96px/in conversion as validated configuration lengths. */
export function pageGeometry(config: Config): PageGeometry {
  const page = config.page;
  let width: number;
  let height: number;
  if (page.size === 'custom') {
    // Materialized configuration validation guarantees both custom dimensions.
    width = normalizeLength(page.width!);
    height = normalizeLength(page.height!);
  } else {
    const dimensions = namedSizes[page.size];
    width = dimensions[0] * 96 / 25.4;
    height = dimensions[1] * 96 / 25.4;
  }
  if (page.orientation === 'landscape') [width, height] = [height, width];
  const margins = {
    top: normalizeLength(page.margins.top), bottom: normalizeLength(page.margins.bottom),
    left: normalizeLength(page.margins.left), right: normalizeLength(page.margins.right),
  };
  return {
    widthPx: width, heightPx: height,
    contentWidthPx: width - margins.left - margins.right,
    contentHeightPx: height - margins.top - margins.bottom,
    margins,
  };
}

/** CSS string escaping also handles aliases containing quotes, slashes, or markup. */
function cssString(value: string): string {
  return `"${value.replace(/["\\\u0000-\u001f\u007f<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}"`;
}

function fontFamily(alias: string): string {
  return cssString(alias === 'sans' ? 'Source Sans 3' : alias === 'mono' ? 'Source Code Pro' : `docm-font-${alias}`);
}

function px(length: Length): string {
  return `${normalizeLength(length)}px`;
}

function typography(style: ElementStyle): string {
  return `font-family:${fontFamily(style.font)};font-size:${px(style.font_size)};font-weight:${style.font_weight};font-style:${style.font_style};text-align:${style.text_align};line-height:${style.line_height};color:${style.color};`;
}

function box(style: ElementStyle, edge: 'all' | 'left' | 'top' = 'all'): string {
  const border = edge === 'all' ? 'border' : `border-${edge}`;
  return `background:${style.background};margin-top:${px(style.space_before)};margin-bottom:${px(style.space_after)};padding:${px(style.padding)};border:0 solid transparent;${border}:${px(style.border_width)} solid ${style.border_color};border-radius:${px(style.border_radius)};`;
}

function styled(selector: string, style: ElementStyle, edge: 'all' | 'left' | 'top' = 'all'): string {
  return `${selector}{${typography(style)}${box(style, edge)}}`;
}

/** Content styles only: the print renderer owns @page, decorations, fonts, and assets. */
export function documentCss(config: Config): string {
  const geometry = pageGeometry(config);
  const imageInset = 2 * (normalizeLength(config.image.padding) + normalizeLength(config.image.border_width));
  const imageMargin = config.image.align === 'center' ? 'auto auto' : config.image.align === 'right' ? 'auto 0' : '0 auto';
  const [imageLeft, imageRight] = imageMargin.split(' ');
  return [
    `html{background:#fff;print-color-adjust:exact;-webkit-print-color-adjust:exact;}`,
    `*,*::before,*::after{box-sizing:border-box;}`,
    `body{${typography(config.body)}background:${config.body.background};margin:0;}`,
    styled('.docm-document', config.body),
    `.docm-document{min-width:0;overflow-wrap:anywhere;widows:3;orphans:3;}`,
    styled('p', config.paragraph),
    ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((heading) => styled(heading, config.headings[heading])),
    `h1,h2,h3,h4,h5,h6{break-after:avoid-page;}`,
    styled('a', config.link),
    `a{text-decoration:${config.link.underline ? 'underline' : 'none'};box-decoration-break:clone;-webkit-box-decoration-break:clone;}`,
    styled('ul,ol', config.list),
    `ul,ol{padding-left:calc(${px(config.list.padding)} + ${px(config.list.indent)});}`,
    `li>p:last-child{margin-bottom:0;}input[type=checkbox]{vertical-align:middle;}`,
    `table{${typography(config.table)}background:${config.table.background};margin-top:${px(config.table.space_before)};margin-bottom:${px(config.table.space_after)};border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed;}`,
    `th,td{padding:${px(config.table.padding)};border:${px(config.table.border_width)} solid ${config.table.border_color};border-radius:${px(config.table.border_radius)};overflow-wrap:anywhere;vertical-align:top;}`,
    `thead{display:table-header-group;}tfoot{display:table-footer-group;}th{background:${config.table.header_background};}tbody tr:nth-child(even)>td{background:${config.table.stripe_background};}`,
    styled('blockquote', config.blockquote, 'left'),
    `blockquote{margin-left:0;margin-right:0;}blockquote>:last-child{margin-bottom:0;}`,
    styled(':not(pre)>code', config.inline_code),
    `:not(pre)>code{box-decoration-break:clone;-webkit-box-decoration-break:clone;overflow-wrap:anywhere;}`,
    styled('pre.docm-code', config.code),
    `pre.docm-code{max-width:100%;white-space:${config.code.wrap ? 'pre-wrap' : 'pre'};overflow-wrap:${config.code.wrap ? 'anywhere' : 'normal'};tab-size:4;}`,
    `pre.docm-code>code{font:inherit;color:inherit;background:none;padding:0;border:0;white-space:inherit;}`,
    `pre.docm-code .line{${config.code.wrap ? 'white-space:pre-wrap;overflow-wrap:anywhere;' : 'white-space:pre;'}${config.code.line_numbers ? 'display:inline-block;width:100%;position:relative;padding-left:calc(var(--docm-line-number-width,3ch) + 1ch);' : ''}}`,
    config.code.line_numbers ? `pre.docm-code .line::before{content:"";position:absolute;left:0;top:0;width:var(--docm-line-number-width,3ch);height:1lh;background-image:var(--docm-line-number-image,none);background-size:100% 100%;background-repeat:no-repeat;opacity:.5;user-select:none;-webkit-user-select:none;pointer-events:none;}` : '',
    styled('section[data-footnotes]', config.footnotes),
    `section[data-footnotes] p,section[data-footnotes] ol,section[data-footnotes] a{font-family:inherit;font-size:inherit;font-weight:inherit;font-style:inherit;line-height:inherit;}`,
    styled('hr', config.rule, 'top'),
    `hr{height:0;}`,
    styled('img.docm-image', config.image),
    `img.docm-image{display:block;width:auto;height:auto;max-width:100%;max-height:${geometry.contentHeightPx}px;object-fit:contain;margin-left:${imageLeft};margin-right:${imageRight};}`,
    styled('.docm-mermaid', config.mermaid),
    ...Object.entries(config.mermaid.charts).map(([number, chart]) => styled(`.docm-mermaid[data-docm-diagram="diagram-${number}"]`, chart)),
    `.docm-mermaid{max-width:100%;}.docm-mermaid>svg{display:block;width:auto;height:auto;max-width:100%;max-height:${geometry.contentHeightPx}px;margin-inline:auto;}`,
    `.docm-image-content{max-width:100%;max-height:${Math.max(0, geometry.contentHeightPx - imageInset)}px;object-fit:contain;}`,
    `.docm-math-inline,.docm-math-display{font-size:${px(config.math.font_size)};color:${config.math.color};}`,
    `.docm-math-inline{display:inline-block;line-height:0;white-space:nowrap;max-width:100%;}.docm-math-inline>svg{display:block;}`,
    `.docm-math-display{display:block;text-align:center;margin-top:${px(config.math.space_before)};margin-bottom:${px(config.math.space_after)};max-width:100%;}.docm-math-display>svg{display:block;margin-inline:auto;}`,
    // Renderer-reported depth belongs on the inline wrapper, not the block SVG.
    `.docm-math-own-line{display:block;text-align:center;margin-top:${px(config.math.space_before)};margin-bottom:${px(config.math.space_after)};}.docm-math-own-line>svg{margin-inline:auto;}`,
    `.docm-pagebreak{break-before:page;}.docm-keep-together{break-inside:avoid-page;}`,
    `.docm-toc{margin-bottom:${px(config.headings.h1.space_after)};}.docm-toc ul{list-style:none;}.docm-toc a{overflow-wrap:anywhere;}`,
    `p,li,blockquote,pre,td,th{widows:3;orphans:3;}`,
    // Inherited variables select the nearest macro, even through explicit element styles.
    `.docm-macro,.docm-macro *{text-align:var(--docm-macro-align)!important;}`,
    `.docm-macro-inline{display:block;}`,
    `.docm-macro img.docm-image,.docm-macro :is(.docm-mermaid,.docm-math-display,.docm-math-own-line)>svg{margin-left:var(--docm-macro-left)!important;margin-right:var(--docm-macro-right)!important;}`,
  ].join('\n');
}
