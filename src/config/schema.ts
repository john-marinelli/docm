import { bundledThemes } from 'shiki';
import { z } from 'zod';
import { defaults } from './defaults.js';

/** All lengths are CSS lengths; numeric zero is allowed only for distances. */
export type Length = string | 0;

const units: Record<'px' | 'pt' | 'mm' | 'cm' | 'in', number> = { px: 1, pt: 96 / 72, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
const lengthPattern = /^(\d+(?:\.\d+)?|\.\d+)(px|pt|mm|cm|in)$/;

/** Convert a validated physical/CSS length to CSS pixels (96 px per inch). */
export function normalizeLength(value: Length): number {
  if (value === 0 || (typeof value === 'string' && value.trim() === '0')) return 0;
  if (typeof value !== 'string') throw new TypeError('Expected a length with a supported unit');
  const match = lengthPattern.exec(value.trim());
  if (!match) throw new TypeError(`Invalid length: ${value}`);
  const amount = Number(match[1]);
  const result = amount * units[match[2] as keyof typeof units];
  if (!Number.isFinite(result)) throw new TypeError(`Length must be finite: ${value}`);
  return result;
}

function lengthSchema(allowZero: boolean, allowPixels = true) {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (allowZero && trimmed === '0') return true;
    const match = lengthPattern.exec(trimmed);
    if (!match || (!allowPixels && match[2] === 'px')) return false;
    const pixels = Number(match[1]) * units[match[2] as keyof typeof units];
    return Number.isFinite(pixels) && (allowZero ? pixels >= 0 : pixels > 0);
  }, { message: `Expected a ${allowZero ? 'nonnegative' : 'positive'} length in ${allowPixels ? 'px, ' : ''}pt, mm, cm, or in` });
}

const positiveLength = lengthSchema(false);
const distance = z.union([lengthSchema(true), z.literal(0)]);
const pageLength = lengthSchema(false, false);
const marginLength = z.union([lengthSchema(true, false), z.literal(0)]);
const color = z.string().regex(/^(?:#[\da-fA-F]{3}|#[\da-fA-F]{6}|transparent)$/, 'Expected #RGB, #RRGGBB, or transparent');
const positiveNumber = z.number().finite().positive();
const weight = z.number().int().min(100).max(900);
const fontStyle = z.enum(['normal', 'italic']);
const alignment = z.enum(['left', 'center', 'right', 'justify']);
const slotPosition = z.enum(['left', 'center', 'right']);
const cleanName = z.string().min(1).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Expected a nonempty font alias without control characters');
const font = cleanName.refine((value) => value !== 'math', 'MathJax math uses its fixed New Computer Modern font and cannot be used as a prose/code font');
const fontAlias = cleanName.refine((value) => !['sans', 'mono', 'math'].includes(value), 'Font aliases cannot shadow sans, mono, or math');
const localPath = z.string().min(1).refine((value) => value.trim().length > 0 && !value.includes('\0') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value), 'Expected a local filesystem path, not a URL');
const fontPath = localPath.refine((value) => /\.(?:ttf|otf|woff2?)$/i.test(value), 'Expected a local .ttf, .otf, .woff, or .woff2 font');
const fonts = z.record(fontAlias, fontPath);
const formattingMacroName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Formatting macro names must start with an ASCII letter and contain only ASCII letters, digits, underscores, or hyphens');
const formattingMacro = z.strictObject({
  text_align: slotPosition.optional(),
  float: z.enum(['left', 'right', 'none']).optional(),
  width: positiveLength.optional(),
  height: positiveLength.optional(),
});
const formattingMacros = z.record(formattingMacroName, formattingMacro.refine(
  (value) => Object.values(value).some((setting) => setting !== undefined),
  'Formatting macros require at least one setting',
));

const styleFields = {
  font,
  font_size: positiveLength,
  font_weight: weight,
  font_style: fontStyle,
  text_align: alignment,
  line_height: positiveNumber,
  color,
  background: color,
  space_before: distance,
  space_after: distance,
  padding: distance,
  border_color: color,
  border_width: distance,
  border_radius: distance,
};

/** A strict inheritable element style. Missing values inherit typography or zero box settings. */
export const elementStyleSchema = z.strictObject(styleFields).partial();
const completedStyleSchema = z.strictObject(styleFields);
export type ElementStyle = z.infer<typeof completedStyleSchema>;

const pageFields = {
  size: z.enum(['A4', 'A3', 'A5', 'Letter', 'Legal', 'custom']),
  orientation: z.enum(['portrait', 'landscape']),
  width: pageLength.optional(),
  height: pageLength.optional(),
  margins: z.strictObject({ top: marginLength, bottom: marginLength, left: marginLength, right: marginLength }),
};
const pageSchema = z.strictObject(pageFields);
const pageLayerSchema = pageSchema.partial().extend({ margins: pageFields.margins.partial().optional() });
const documentSchema = z.strictObject({ toc: z.boolean(), number_headings: z.boolean() });
const headingNames = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const headingsSchema = z.strictObject({
  h1: elementStyleSchema, h2: elementStyleSchema, h3: elementStyleSchema,
  h4: elementStyleSchema, h5: elementStyleSchema, h6: elementStyleSchema,
});
const completedHeadingsSchema = z.strictObject({
  h1: completedStyleSchema, h2: completedStyleSchema, h3: completedStyleSchema,
  h4: completedStyleSchema, h5: completedStyleSchema, h6: completedStyleSchema,
});
const macro = z.strictObject({ args: z.number().int().min(0).max(9), body: z.string() });
const macroName = z.string().regex(/^[A-Za-z]+$/, 'Macro names must contain only ASCII letters, without a leading backslash');
const macros = z.record(macroName, macro);
const mathSchema = z.strictObject({ font_size: positiveLength, color, space_before: distance, space_after: distance, macros });
export type MathConfig = z.infer<typeof mathSchema>;
const codeTheme = z.custom<keyof typeof bundledThemes>((value) => typeof value === 'string' && Object.hasOwn(bundledThemes, value), 'Expected a bundled Shiki theme name');
const linkFields = { underline: z.boolean() };
const listFields = { indent: distance };
const tableFields = { header_background: color, stripe_background: color };
const codeFields = { theme: codeTheme, wrap: z.boolean(), line_numbers: z.boolean() };
const imageFields = { align: slotPosition };
const mermaidFields = {
  theme: z.enum(['default', 'neutral', 'dark', 'forest']),
  width: positiveLength.optional(),
  height: positiveLength.optional(),
};
const mermaidChartSchema = elementStyleSchema.extend(mermaidFields).partial();
const chartNumber = z.string().regex(/^[1-9]\d*$/, 'Expected a canonical positive chart number')
  .refine((value) => Number.isSafeInteger(Number(value)), 'Chart number must be a safe integer');
const mermaidChartsSchema = z.record(chartNumber, mermaidChartSchema);
const completedMermaidSchema = completedStyleSchema.extend(mermaidFields);
/** Fully resolved settings for one Mermaid chart, without nested chart overrides. */
export type MermaidConfig = z.infer<typeof completedMermaidSchema>;

const decorationTokens: Record<string, true> = { filename: true, title: true, page: true, pages: true };
function validDecorationText(value: string): boolean {
  for (let index = 0; index < value.length;) {
    if (value.startsWith('{{{{', index) || value.startsWith('}}}}', index)) {
      index += 4;
    } else if (value.startsWith('{{', index)) {
      const end = value.indexOf('}}', index + 2);
      if (end === -1 || !Object.hasOwn(decorationTokens, value.slice(index + 2, end))) return false;
      index = end + 2;
    } else if (value.startsWith('}}', index)) {
      return false;
    } else {
      index += 1;
    }
  }
  return true;
}
const decorationText = z.string().refine(validDecorationText, 'Unknown or unterminated decoration token; use filename, title, page, or pages, and escape literal braces as {{{{ / }}}}');
const logoFields = { path: localPath, position: slotPosition, width: positiveLength, height: positiveLength };
const logoLayerSchema = z.union([z.literal(false), z.strictObject(logoFields).partial()]);
const logoSchema = z.union([z.literal(false), z.strictObject({
  path: localPath,
  position: slotPosition.default('left'),
  width: positiveLength.default('18mm'),
  height: positiveLength.default('8mm'),
})]);
const decorationFields = {
  enabled: z.boolean(), left: decorationText, center: decorationText, right: decorationText,
  font, font_size: positiveLength, font_weight: weight, font_style: fontStyle,
  line_height: positiveNumber, color, logo: logoSchema,
};
const decorationSchema = z.strictObject(decorationFields);
const decorationLayerSchema = decorationSchema.partial().extend({ logo: logoLayerSchema.optional() });

/** Strict partial validation occurs before merging, including overridden values. */
export const layerSchema = z.strictObject({
  page: pageLayerSchema.optional(),
  document: documentSchema.partial().optional(),
  fonts: fonts.optional(),
  macro: z.record(formattingMacroName, formattingMacro).optional(),
  body: elementStyleSchema.optional(),
  headings: headingsSchema.partial().optional(),
  paragraph: elementStyleSchema.optional(),
  link: elementStyleSchema.extend(linkFields).partial().optional(),
  list: elementStyleSchema.extend(listFields).partial().optional(),
  table: elementStyleSchema.extend(tableFields).partial().optional(),
  blockquote: elementStyleSchema.optional(),
  inline_code: elementStyleSchema.optional(),
  code: elementStyleSchema.extend(codeFields).partial().optional(),
  math: mathSchema.partial().extend({ macros: z.record(macroName, macro.partial()).optional() }).optional(),
  mermaid: mermaidChartSchema.extend({ charts: mermaidChartsSchema.optional() }).optional(),
  image: elementStyleSchema.extend(imageFields).partial().optional(),
  footnotes: elementStyleSchema.optional(),
  rule: elementStyleSchema.optional(),
  header: decorationLayerSchema.optional(),
  footer: decorationLayerSchema.optional(),
});
export type ConfigLayer = z.infer<typeof layerSchema>;

const configInputSchema = z.strictObject({
  page: pageSchema,
  document: documentSchema,
  fonts,
  macro: formattingMacros,
  body: elementStyleSchema,
  headings: headingsSchema,
  paragraph: elementStyleSchema,
  link: elementStyleSchema.extend(linkFields),
  list: elementStyleSchema.extend(listFields),
  table: elementStyleSchema.extend(tableFields),
  blockquote: elementStyleSchema,
  inline_code: elementStyleSchema,
  code: elementStyleSchema.extend(codeFields),
  math: mathSchema,
  mermaid: elementStyleSchema.extend(mermaidFields).extend({ charts: mermaidChartsSchema.default({}) }),
  image: elementStyleSchema.extend(imageFields),
  footnotes: elementStyleSchema,
  rule: elementStyleSchema,
  header: decorationSchema,
  footer: decorationSchema,
});
export type ConfigInput = z.input<typeof configInputSchema>;

const namedPageMillimeters: Record<'A4' | 'A3' | 'A5' | 'Letter' | 'Legal', readonly [number, number]> = {
  A4: [210, 297], A3: [297, 420], A5: [148, 210],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6],
};

/** The completed configuration has explicit style values, with inheritance already applied. */
export const configSchema = configInputSchema.extend({
  body: completedStyleSchema,
  headings: completedHeadingsSchema,
  paragraph: completedStyleSchema,
  link: completedStyleSchema.extend(linkFields),
  list: completedStyleSchema.extend(listFields),
  table: completedStyleSchema.extend(tableFields),
  blockquote: completedStyleSchema,
  inline_code: completedStyleSchema,
  code: completedStyleSchema.extend(codeFields),
  mermaid: completedMermaidSchema.extend({ charts: z.record(chartNumber, completedMermaidSchema) }),
  image: completedStyleSchema.extend(imageFields),
  footnotes: completedStyleSchema,
  rule: completedStyleSchema,
}).superRefine((config, context) => {
  const page = config.page;
  let dimensions: readonly [number, number] | undefined;
  if (page.size === 'custom') {
    if (page.width === undefined) context.addIssue({ code: 'custom', path: ['page', 'width'], message: 'Custom page size requires width' });
    if (page.height === undefined) context.addIssue({ code: 'custom', path: ['page', 'height'], message: 'Custom page size requires height' });
    if (page.width !== undefined && page.height !== undefined) dimensions = [normalizeLength(page.width), normalizeLength(page.height)];
  } else {
    for (const key of ['width', 'height'] as const) {
      if (page[key] !== undefined) context.addIssue({ code: 'custom', path: ['page', key], message: 'Width and height are allowed only for custom page sizes' });
    }
    const [width, height] = namedPageMillimeters[page.size];
    dimensions = [width * units.mm, height * units.mm];
  }
  if (dimensions) {
    const [width, height] = page.orientation === 'landscape' ? [dimensions[1], dimensions[0]] : dimensions;
    if (normalizeLength(page.margins.left) + normalizeLength(page.margins.right) >= width) context.addIssue({ code: 'custom', path: ['page', 'margins'], message: 'Left and right margins leave no printable width' });
    if (normalizeLength(page.margins.top) + normalizeLength(page.margins.bottom) >= height) context.addIssue({ code: 'custom', path: ['page', 'margins'], message: 'Top and bottom margins leave no printable height' });
  }
  const checkFont = (value: string, path: (string | number)[]) => {
    if (value !== 'sans' && value !== 'mono' && !Object.hasOwn(config.fonts, value)) context.addIssue({ code: 'custom', path, message: `Undeclared font alias: ${value}` });
  };
  checkFont(config.body.font, ['body', 'font']);
  for (const name of headingNames) checkFont(config.headings[name].font, ['headings', name, 'font']);
  for (const name of ['paragraph', 'link', 'list', 'table', 'blockquote', 'inline_code', 'code', 'mermaid', 'image', 'footnotes', 'rule', 'header', 'footer'] as const) checkFont(config[name].font, [name, 'font']);
  for (const [number, chart] of Object.entries(config.mermaid.charts)) checkFont(chart.font, ['mermaid', 'charts', number, 'font']);
});
export type Config = z.infer<typeof configSchema>;

export function parseLayer(input: unknown): ConfigLayer {
  return layerSchema.parse(input);
}

const boxDefaults = { background: 'transparent', space_before: 0, space_after: 0, padding: 0, border_color: 'transparent', border_width: 0, border_radius: 0 } as const;

/** Validate a recursively merged defaults/layers object, then materialize style inheritance. */
export function finalizeConfig(input: unknown): Config {
  const parsed = configInputSchema.parse(input);
  const body = completedStyleSchema.parse({ ...boxDefaults, ...defaults.body, ...parsed.body });
  const inherited = {
    font: body.font, font_size: body.font_size, font_weight: body.font_weight,
    font_style: body.font_style, text_align: body.text_align, line_height: body.line_height, color: body.color,
    ...boxDefaults,
    border_color: body.color,
  };
  const complete = <T extends z.infer<typeof elementStyleSchema>>(style: T) => ({ ...inherited, ...style });
  const { charts, ...mermaidSettings } = parsed.mermaid;
  const mermaid = complete(mermaidSettings);
  return configSchema.parse({
    ...parsed,
    body,
    headings: {
      h1: complete(parsed.headings.h1), h2: complete(parsed.headings.h2), h3: complete(parsed.headings.h3),
      h4: complete(parsed.headings.h4), h5: complete(parsed.headings.h5), h6: complete(parsed.headings.h6),
    },
    paragraph: complete(parsed.paragraph), link: complete(parsed.link), list: complete(parsed.list),
    table: complete(parsed.table), blockquote: complete(parsed.blockquote), inline_code: complete(parsed.inline_code),
    code: complete(parsed.code),
    mermaid: {
      ...mermaid,
      charts: Object.fromEntries(Object.entries(charts).map(([number, chart]) => [number, { ...mermaid, ...chart }])),
    },
    image: complete(parsed.image),
    footnotes: complete(parsed.footnotes), rule: complete(parsed.rule),
  });
}
