import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { renderMath, clearMathCache } from '../src/render/math.js';
import type { MathConfig } from '../src/config/schema.js';
import type { MathExpression, MathSvg } from '../src/shared/types.js';

const config: MathConfig = { font_size: '11pt', color: '#202124', space_before: '8pt', space_after: '8pt', macros: {} };
const source = { path: path.resolve('math-fixture.md'), line: 17, column: 4 };
function expression(tex: string, display = false, id = 'math'): MathExpression {
  return { id, tex, display, source };
}
function render(expressions: MathExpression[], settings = config): Promise<MathSvg[]> {
  return renderMath(expressions, settings, { signal: new AbortController().signal });
}
function viewBox(result: MathSvg): number[] {
  const match = /\bviewBox="([^"]+)"/.exec(result.svg);
  expect(match).not.toBeNull();
  return match![1]!.split(/\s+/).map(Number);
}
function expectVectorGeometry(result: MathSvg): void {
  expect(result.svg).toContain('<path');
  expect(result.svg).not.toMatch(/<text\b|<foreignObject\b|<mjx-container\b|<script\b/);
  expect(result.svg).not.toMatch(/(?:href|src)="(?:https?:|file:)/);
  expect(result.widthPx).toBeGreaterThan(0);
  expect(result.heightPx).toBeGreaterThan(0);
  expect(Number.isFinite(result.depthPx)).toBe(true);
  const [left, top, width, height] = viewBox(result);
  expect([left, top, width, height].every(Number.isFinite)).toBe(true);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  // SVG's y=0 is the baseline. Its lower edge must agree with the
  // separately returned placement depth, including serialization rounding.
  expect(result.depthPx).toBeCloseTo((top! + height!) * result.heightPx / height!, 2);
}

afterEach(clearMathCache);

describe('vector math geometry and typography', () => {
  it('retains descenders and tall fraction crops with a measured baseline', async () => {
    const [descender, fraction] = await render([
      expression('x_g', false, 'descender'),
      expression('\\frac{1}{\\frac{x_g}{y}}', false, 'fraction'),
    ]);
    expect(descender!.depthPx).toBeGreaterThan(0);
    expect(fraction!.heightPx).toBeGreaterThan(descender!.heightPx);
    for (const result of [descender!, fraction!]) {
      expectVectorGeometry(result);
      const box = viewBox(result);
      expect(box[1]).toBeLessThan(0);
      expect(box[1]! + box[3]!).toBeGreaterThan(0);
      expect(result.depthPx).toBeLessThan(result.heightPx);
    }
  });

  it('keeps display operator limits and scales all baseline metrics with font size', async () => {
    const [inline, display] = await render([
      expression('\\int_0^\\infty x_g\\,dx', false, 'inline'),
      expression('\\int_0^\\infty x_g\\,dx', true, 'display'),
    ]);
    expect(display!.heightPx).toBeGreaterThan(inline!.heightPx);
    const [large] = await render([expression('\\int_0^\\infty x_g\\,dx')], { ...config, font_size: '22pt' });
    expect(large!.widthPx).toBeCloseTo(inline!.widthPx * 2, 5);
    expect(large!.heightPx).toBeCloseTo(inline!.heightPx * 2, 5);
    expect(large!.depthPx).toBeCloseTo(inline!.depthPx * 2, 5);
    for (const result of [inline!, display!, large!]) expectVectorGeometry(result);
  });


  it('renders AMS, mathtools, text, color and bold symbols together', async () => {
    const [result] = await render([expression(String.raw`\DeclarePairedDelimiter{\norm}{\lVert}{\rVert}
\begin{aligned}
\norm*{\dfrac{x_g}{y}} &\coloneqq \prescript{14}{6}{\mathrm{C}} \\
\boldsymbol{\alpha} & = \text{finite \textbf{value} \textit{units}} + \textcolor{red}{\mathbb{R}}
\end{aligned}`, true)]);
    expectVectorGeometry(result!);
    expect(result!.heightPx).toBeGreaterThan(20);
  });

  it('loads extended NewCM ranges as vector glyphs without host fonts', async () => {
    const results = await render([
      expression('\\text{é Ж ש}', false, 'extended-text'),
      expression('\\mathsf{αβΩ} + \\mathtt{αβΩ}', false, 'greek-variants'),
      expression('\\mathscr{ABC} + \\mathfrak{xyz} + \\mathbb{123}', false, 'alphabets'),
    ]);
    for (const result of results) expectVectorGeometry(result);
  });
});

describe('source-positioned strict math errors', () => {
  it.each([
    ['empty', ' \n\t '],
    ['unknown command', '\\DefinitelyNotADocmMacro'],
    ['missing argument', '\\frac{1}'],
    ['unclosed group', 'x + {y'],
    ['unknown environment', '\\begin{docmUnknown}x\\end{docmUnknown}'],
    ['recursive expansion', '\\def\\Loop{\\Loop}\\Loop'],
    ['native file access', '\\input{/etc/passwd}'],
    ['dynamic package loading', '\\require{html}'],
    ['HTML callback', '\\href{https://example.com}{x}'],
    ['oversized parser input', 'x'.repeat(64 * 1024 + 1)],
  ])('rejects %s at its original document location', async (_name, tex) => {
    await expect(render([expression(tex)])).rejects.toMatchObject({
      name: 'RenderError', source, dependencies: [source.path],
    });
  });

  it('rejects built-in TOML macro redefinitions even when unused', async () => {
    await expect(render([expression('x')], {
      ...config, macros: { frac: { args: 2, body: '#1+#2' } },
    })).rejects.toMatchObject({ name: 'RenderError', source });
  });

  it('rejects recursive configured macros instead of silently producing an error SVG', async () => {
    await expect(render([expression('\\Loop')], {
      ...config, macros: { Loop: { args: 0, body: '\\Loop' } },
    })).rejects.toMatchObject({ name: 'RenderError', source });
  });
});

describe('math configuration and expression isolation', () => {
  it('supports configured zero-, one- and nine-argument macros', async () => {
    const settings: MathConfig = { ...config, macros: {
      R: { args: 0, body: '\\mathbb{R}' },
      Abs: { args: 1, body: '\\left|#1\\right|' },
      Nine: { args: 9, body: '#1+#2+#3+#4+#5+#6+#7+#8+#9' },
    } };
    const [macro] = await render([expression('\\R + \\Abs{x_g} + \\Nine{1}{2}{3}{4}{5}{6}{7}{8}{9}')], settings);
    const [expanded] = await render([expression('\\mathbb{R} + \\left|x_g\\right| + 1+2+3+4+5+6+7+8+9')]);
    expect(macro!.widthPx).toBeCloseTo(expanded!.widthPx, 8);
    expect(macro!.heightPx).toBeCloseTo(expanded!.heightPx, 8);
    expect(macro!.depthPx).toBeCloseTo(expanded!.depthPx, 8);
    expectVectorGeometry(macro!);
  });

  it('does not leak expression definitions into the next expression', async () => {
    const nextSource = { ...source, line: 39, column: 2 };
    await expect(render([
      expression('\\def\\Local{x_g}\\Local', false, 'definition'),
      { ...expression('\\Local', false, 'next'), source: nextSource },
    ])).rejects.toMatchObject({ source: nextSource });
    await expect(render([expression('\\Local')])).rejects.toMatchObject({ source });
  });

  it('does not mix configured definitions or cached results between documents', async () => {
    const small = { ...config, macros: { Value: { args: 0, body: 'x_g' } } };
    const tall = { ...config, macros: { Value: { args: 0, body: '\\dfrac{1}{x_g}' } } };
    const [[first], [second]] = await Promise.all([
      render([expression('\\Value')], small), render([expression('\\Value')], tall),
    ]);
    expect(second!.heightPx).toBeGreaterThan(first!.heightPx);
    const [again] = await render([expression('\\Value', false, 'other-id')], small);
    expect(again).toEqual({ ...first, id: 'other-id' });
    await expect(render([expression('\\Value')])).rejects.toMatchObject({ source });
  });


  it('refuses an aborted conversion, including a cached expression', async () => {
    await render([expression('x_g')]);
    const controller = new AbortController();
    controller.abort();
    await expect(renderMath([expression('x_g')], config, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
