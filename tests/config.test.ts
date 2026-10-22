import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { RenderError } from '../src/shared/errors.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docm-config-'));
  roots.push(root);
  const cwd = path.join(root, 'invocation');
  const sourceDirectory = path.join(root, 'documents');
  const themeDirectory = path.join(root, 'global');
  await Promise.all([cwd, sourceDirectory, themeDirectory].map((directory) => mkdir(directory)));
  return {
    root, cwd, sourceDirectory, themeDirectory,
    source: path.join(sourceDirectory, 'notes.md'),
    globalThemePath: path.join(themeDirectory, 'theme.toml'),
  };
}

describe('configuration layering and path origins', () => {
  it('merges all five layers while retaining undeclared shared slots and logos', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, `
[body]
color = "#111111"
[header]
left = "Engineering"
center = "{{title}}"
[header.logo]
path = "assets/logo.png"
width = "18mm"
`);
    await writeFile(path.join(f.cwd, 'theme.toml'), '[body]\ncolor = "#222222"\n[header]\nright = "{{filename}}"\n');
    const configPath = path.join(f.root, 'explicit.toml');
    await writeFile(configPath, '[body]\ncolor = "#333333"\n[footer]\nleft = "Internal"\n');
    await writeFile(f.source, '+++\n[body]\ncolor = "#444444"\n[header]\ncenter = ""\n[header.logo]\nwidth = "12mm"\n+++\n# Notes\n');
    const result = await loadConfig(f.source, { ...f, configPath });
    expect(result.config.body.color).toBe('#444444');
    expect(result.config.header).toMatchObject({ left: 'Engineering', center: '', right: '{{filename}}' });
    expect(result.config.header.logo).toMatchObject({ path: path.join(f.themeDirectory, 'assets/logo.png'), width: '12mm' });
    expect(result.config.footer).toMatchObject({ left: 'Internal', center: '{{page}} / {{pages}}' });
    expect(result.markdown).toBe('# Notes\n');
    expect(result.lineOffset).toBe(8);
  });

  it('discovers only invocation cwd, and reapplies an explicit automatic file', async () => {
    const f = await fixture();
    await writeFile(f.source, '# Notes');
    await writeFile(f.globalThemePath, '[body]\ncolor = "#111111"\n');
    await writeFile(path.join(f.cwd, 'theme.toml'), '[body]\ncolor = "#222222"\n');
    await writeFile(path.join(f.sourceDirectory, 'theme.toml'), '[unknown]\ninvalid = true\n');
    const result = await loadConfig(f.source, { ...f, configPath: f.globalThemePath });
    expect(result.config.body.color).toBe('#111111');
    expect(result.dependencies.filter((file) => file === f.globalThemePath)).toHaveLength(1);
    expect(result.snapshot.filter((entry) => entry.path === f.globalThemePath)).toHaveLength(2);
    expect(result.dependencies).not.toContain(path.join(f.sourceDirectory, 'theme.toml'));
  });

  it('resolves each path from its declaring file, even across partial overrides', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, '[fonts]\nreport = "fonts/report.woff2"\n[body]\nfont = "report"\n[header.logo]\npath = "images/shared.png"\n');
    await writeFile(path.join(f.cwd, 'theme.toml'), '[header.logo]\nheight = "10mm"\n');
    await writeFile(f.source, '+++\n[footer.logo]\npath = "pictures/local.svg"\n+++\nText');
    const result = await loadConfig(path.relative(f.cwd, f.source), f);
    expect(result.config.fonts.report).toBe(path.join(f.themeDirectory, 'fonts/report.woff2'));
    expect(result.config.header.logo).toMatchObject({ path: path.join(f.themeDirectory, 'images/shared.png'), height: '10mm' });
    expect(result.config.footer.logo).toMatchObject({ path: path.join(f.sourceDirectory, 'pictures/local.svg') });
    expect(result.dependencies).toEqual(expect.arrayContaining([
      path.join(f.themeDirectory, 'fonts/report.woff2'),
      path.join(f.themeDirectory, 'images/shared.png'),
      path.join(f.sourceDirectory, 'pictures/local.svg'),
    ]));
  });

  it('rejects invalid lower-layer keys and types even when frontmatter overrides them', async () => {
    const f = await fixture();
    await writeFile(f.source, '+++\n[body]\ncolor = "#444444"\n+++\nText');
    for (const invalid of ['[body]\ncolor = 12\n', '[body]\ncolour = "#111111"\n']) {
      await writeFile(f.globalThemePath, invalid);
      await expect(loadConfig(f.source, f)).rejects.toMatchObject({
        name: 'RenderError', source: { path: f.globalThemePath },
      });
    }
  });

  it('allows explicit suppression and rejects incomplete un-inherited logos', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, '[header.logo]\npath = "logo.png"\n');
    await writeFile(f.source, '+++\n[header]\nenabled = false\nlogo = false\n[footer]\ncenter = ""\n+++\nText');
    const result = await loadConfig(f.source, f);
    expect(result.config.header.enabled).toBe(false);
    expect(result.config.header.logo).toBe(false);
    expect(result.config.footer.center).toBe('');
    await writeFile(f.source, '+++\n[footer.logo]\nwidth = "12mm"\n+++\nText');
    await expect(loadConfig(f.source, f)).rejects.toBeInstanceOf(RenderError);
  });
});

describe('formatting macro configuration', () => {
  it('merges names across every configuration source with higher-layer alignment taking precedence', async () => {
    const f = await fixture();
    await writeFile(f.source, 'Text');
    await writeFile(f.globalThemePath, `
[macro.Shared]
text_align = "left"
[macro.global_only]
text_align = "center"
[macro.shared]
text_align = "right"
`);
    expect((await loadConfig(f.source, f)).config.macro.Shared).toEqual({ text_align: 'left' });

    await writeFile(path.join(f.cwd, 'theme.toml'), `
[macro.Shared]
text_align = "center"
[macro.cwd-only]
text_align = "left"
`);
    expect((await loadConfig(f.source, f)).config.macro.Shared).toEqual({ text_align: 'center' });

    const configPath = path.join(f.root, 'explicit.toml');
    await writeFile(configPath, `
[macro.Shared]
text_align = "right"
[macro.explicit1]
text_align = "center"
`);
    expect((await loadConfig(f.source, { ...f, configPath })).config.macro.Shared).toEqual({ text_align: 'right' });

    await writeFile(f.source, `+++
[macro.Shared]
text_align = "left"
[macro.frontmatter]
text_align = "right"
[macro.div]
text_align = "center"
+++
Text`);
    const { config } = await loadConfig(f.source, { ...f, configPath });
    expect(config.macro).toMatchObject({
      Shared: { text_align: 'left' },
      shared: { text_align: 'right' },
      global_only: { text_align: 'center' },
      'cwd-only': { text_align: 'left' },
      explicit1: { text_align: 'center' },
      frontmatter: { text_align: 'right' },
      div: { text_align: 'center' },
    });
  });

  it('merges partial layout settings across every layer and permits clearing a float', async () => {
    const f = await fixture();
    const configPath = path.join(f.root, 'explicit.toml');
    await writeFile(f.globalThemePath, '[macro.shared]\nfloat = "left"\nwidth = "120px"\n');
    await writeFile(path.join(f.cwd, 'theme.toml'), '[macro.shared]\nheight = "2cm"\n');
    await writeFile(configPath, '[macro.shared]\nwidth = "36pt"\ntext_align = "right"\n');
    await writeFile(f.source, '+++\n[macro.shared]\nfloat = "none"\n+++\nText');
    expect((await loadConfig(f.source, { ...f, configPath })).config.macro.shared).toEqual({
      float: 'none', width: '36pt', height: '2cm', text_align: 'right',
    });
  });

  it.each([
    { setting: 'float = "left"', expected: { float: 'left' } },
    { setting: 'float = "right"', expected: { float: 'right' } },
    { setting: 'float = "none"', expected: { float: 'none' } },
    ...['px', 'pt', 'mm', 'cm', 'in'].flatMap((unit) => [
      { setting: `width = "1.5${unit}"`, expected: { width: `1.5${unit}` } },
      { setting: `height = ".5${unit}"`, expected: { height: `.5${unit}` } },
    ]),
  ])('accepts a standalone layout setting: $setting', async ({ setting, expected }) => {
    const f = await fixture();
    await writeFile(f.source, `+++\n[macro.layout]\n${setting}\n+++\nText`);
    expect((await loadConfig(f.source, f)).config.macro.layout).toEqual(expected);
  });

  it('permits empty layer definitions only when merging supplies a meaningful setting', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, '[macro.shared]\n');
    await writeFile(f.source, '+++\n[macro.shared]\nwidth = "20mm"\n+++\nText');
    expect((await loadConfig(f.source, f)).config.macro.shared).toEqual({ width: '20mm' });

    await writeFile(f.globalThemePath, '[macro.shared]\nfloat = "right"\n');
    await writeFile(f.source, '+++\n[macro.shared]\n+++\nText');
    expect((await loadConfig(f.source, f)).config.macro.shared).toEqual({ float: 'right' });

    await writeFile(f.globalThemePath, '[macro.shared]\n');
    await expect(loadConfig(f.source, f)).rejects.toBeInstanceOf(RenderError);
  });

  it.each(['global', 'cwd', 'explicit', 'frontmatter'] as const)('strictly validates macro definitions in the %s layer before merging', async (layer) => {
    const f = await fixture();
    const configPath = path.join(f.root, 'explicit.toml');
    const layerPath = {
      global: f.globalThemePath,
      cwd: path.join(f.cwd, 'theme.toml'),
      explicit: configPath,
      frontmatter: f.source,
    }[layer];
    const invalid = [
      ...['', '1name', '_name', '-name', 'two words', 'a.b', 'é', 'a/b', 'a\n'].map((name) =>
        `[macro.${JSON.stringify(name)}]\ntext_align = "left"`),
      '[macro.shared]\ntext_align = "justify"',
      '[macro.shared]\ntext_align = 1',
      '[macro.shared]\ntext_align = "LEFT"',
      ...['"center"', '"LEFT"', '1', 'false'].map((value) => `[macro.shared]\nfloat = ${value}`),
      ...['width', 'height'].flatMap((dimension) =>
        ['"0px"', '"-1pt"', '"0"', '"1"', '"1em"', '"10%"', '0', '-1', '1'].map((value) =>
          `[macro.shared]\n${dimension} = ${value}`)),
      '[macro.shared]\ntext_align = "left"\ncolor = "#123456"',
      '[macro.shared]\nalign = "left"',
      '[macro]\nshared = false',
      'macro = []',
    ];
    for (const input of invalid) {
      await writeFile(f.source, layer === 'frontmatter'
        ? `+++\n${input}\n+++\nText`
        : '+++\n[macro.shared]\ntext_align = "center"\nfloat = "none"\nwidth = "10px"\nheight = "10px"\n+++\nText');
      if (layer !== 'frontmatter') await writeFile(layerPath, input);
      await expect(loadConfig(f.source, { ...f, ...(layer === 'explicit' ? { configPath } : {}) })).rejects.toMatchObject({
        name: 'RenderError', source: { path: layerPath },
      });
    }
    await writeFile(f.source, layer === 'frontmatter' ? '+++\n[macro.shared]\n+++\nText' : 'Text');
    if (layer !== 'frontmatter') await writeFile(layerPath, '[macro.shared]\n');
    await expect(loadConfig(f.source, { ...f, ...(layer === 'explicit' ? { configPath } : {}) })).rejects.toBeInstanceOf(RenderError);
  });
});

describe('Mermaid chart configuration', () => {
  it('merges partial chart overrides across layers before inheriting final global settings', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, `
[mermaid]
theme = "forest"
width = "120mm"
height = "8cm"
color = "#111111"
[mermaid.charts.2]
theme = "dark"
font_size = "15pt"
padding = "2mm"
[mermaid.charts.9]
width = "2in"
`);
    await writeFile(path.join(f.cwd, 'theme.toml'), `
[mermaid]
font_weight = 600
[mermaid.charts.2]
height = "90px"
border_width = "1pt"
`);
    const configPath = path.join(f.root, 'explicit.toml');
    await writeFile(configPath, `
[mermaid]
theme = "neutral"
width = "130mm"
[mermaid.charts.2]
padding = "3mm"
`);
    await writeFile(f.source, `+++
[body]
line_height = 1.7
[mermaid]
color = "#334455"
height = "10cm"
[mermaid.charts.2]
font_size = "18pt"
[mermaid.charts.4]
width = "40pt"
+++
Text`);
    const { config } = await loadConfig(f.source, { ...f, configPath });
    const { charts, ...global } = config.mermaid;
    expect(global).toMatchObject({
      theme: 'neutral', width: '130mm', height: '10cm', color: '#334455',
      font_weight: 600, line_height: 1.7,
    });
    expect(Object.keys(charts)).toEqual(['2', '4', '9']);
    expect(charts['2']).toEqual({
      ...global, theme: 'dark', font_size: '18pt', padding: '3mm', height: '90px', border_width: '1pt',
    });
    expect(charts['4']).toEqual({ ...global, width: '40pt' });
    expect(charts['9']).toEqual({ ...global, width: '2in' });
    expect(charts['1']).toBeUndefined();
  });

  it('resolves chart fonts against final aliases and rejects undeclared or forbidden fonts', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, '[mermaid.charts.3]\nfont = "diagram"\n');
    await writeFile(f.source, '+++\n[fonts]\ndiagram = "fonts/diagram.woff2"\n+++\nText');
    const { config } = await loadConfig(f.source, f);
    expect(config.mermaid.charts['3']?.font).toBe('diagram');
    expect(config.fonts.diagram).toBe(path.join(f.sourceDirectory, 'fonts/diagram.woff2'));
    for (const font of ['missing', 'math']) {
      await writeFile(f.source, `+++\n[mermaid.charts.3]\nfont = "${font}"\n+++\nText`);
      await expect(loadConfig(f.source, f)).rejects.toBeInstanceOf(RenderError);
    }
  });

  it('accepts positive dimensions independently and permits sparse safe-integer chart numbers', async () => {
    const f = await fixture();
    for (const [dimension, value] of [['width', '12px'], ['height', '12pt'], ['width', '12mm'], ['height', '12cm'], ['width', '2in']]) {
      await writeFile(f.source, `+++\n[mermaid]\n${dimension} = "${value}"\n[mermaid.charts.9007199254740991]\n${dimension} = "3in"\n+++\nText`);
      const { config } = await loadConfig(f.source, f);
      expect(config.mermaid).toMatchObject({ [dimension!]: value });
      expect(config.mermaid.charts['9007199254740991']).toMatchObject({ [dimension!]: '3in' });
    }
  });

  it('rejects malformed chart keys, dimensions, unknown settings, and nested charts in every layer', async () => {
    const f = await fixture();
    await writeFile(f.source, '+++\n[mermaid]\nwidth = "10cm"\n[mermaid.charts.1]\nwidth = "20mm"\n+++\nText');
    const invalid = [
      ...['0', '-1', '01', '+1', '1.5', '1e2', '9007199254740992', 'word', ''].map((key) => `[mermaid.charts."${key}"]\ntheme = "dark"`),
      ...['0', '0px', '-1mm', '1em', 'NaNpx', 'Infinitypt', '12'].flatMap((value) => [
        `[mermaid]\nwidth = "${value}"`,
        `[mermaid.charts.1]\nheight = "${value}"`,
      ]),
      '[mermaid]\nheight = 12',
      '[mermaid.charts.1]\nwidth = 12',
      '[mermaid.charts.1]\ncolour = "#123456"',
      '[mermaid.charts.1.charts.2]\ntheme = "dark"',
      '[mermaid]\ncharts = []',
      '[mermaid.charts]\n"1" = false',
    ];
    for (const input of invalid) {
      await writeFile(f.globalThemePath, input);
      await expect(loadConfig(f.source, f)).rejects.toMatchObject({
        name: 'RenderError', source: { path: f.globalThemePath },
      });
    }
  });
});

describe('source frontmatter and snapshots', () => {
  it('strips a leading BOM and CRLF frontmatter while retaining original line offsets and byte hashes', async () => {
    const f = await fixture();
    const source = '\uFEFF+++\r\n[document]\r\ntoc = true\r\n+++\r\n# Heading\r\n';
    await writeFile(f.source, source);
    const result = await loadConfig(f.source, f);
    expect(result.markdown).toBe('# Heading\r\n');
    expect(result.lineOffset).toBe(4);
    expect(result.config.document.toc).toBe(true);
    expect(result.snapshot).toEqual([
      { path: f.source, sha256: createHash('sha256').update(source).digest('hex') },
      { path: f.globalThemePath, sha256: null },
      { path: path.join(f.cwd, 'theme.toml'), sha256: null },
    ]);
    expect(result.dependencies).toEqual([f.source, f.globalThemePath, path.join(f.cwd, 'theme.toml')]);
  });

  it('treats noninitial and fenced delimiters as Markdown, not configuration', async () => {
    const f = await fixture();
    for (const markdown of ['\n+++\nnot TOML\n+++\n', '```toml\n+++\ninvalid\n+++\n```', ' +++\ninvalid\n+++']) {
      await writeFile(f.source, `\uFEFF${markdown}`);
      const result = await loadConfig(f.source, f);
      expect(result.markdown).toBe(markdown);
      expect(result.lineOffset).toBe(0);
    }
  });

  it('reports unterminated and malformed frontmatter in original source coordinates', async () => {
    const f = await fixture();
    await writeFile(f.source, '+++\n[body]\ncolor = "#111111"');
    await expect(loadConfig(f.source, f)).rejects.toMatchObject({
      name: 'RenderError', source: { path: f.source, line: 1, column: 1 },
      dependencies: expect.arrayContaining([f.source, f.globalThemePath, path.join(f.cwd, 'theme.toml')]),
    });
    await writeFile(f.source, '+++\n[body]\ncolor = [\n+++\nText');
    const error = await loadConfig(f.source, f).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).source?.path).toBe(f.source);
    expect((error as RenderError).source?.line).toBeGreaterThanOrEqual(2);
  });

  it('supports empty sources and frontmatter-only sources', async () => {
    const f = await fixture();
    await writeFile(f.source, '');
    expect((await loadConfig(f.source, f)).markdown).toBe('');
    await writeFile(f.source, '+++\n[document]\ntoc = false\n+++');
    const result = await loadConfig(f.source, f);
    expect(result.markdown).toBe('');
    expect(result.lineOffset).toBe(4);
  });

  it('distinguishes missing automatic files from missing required or invalid present themes', async () => {
    const f = await fixture();
    await writeFile(f.source, 'Text');
    const missing = path.join(f.root, 'required.toml');
    await expect(loadConfig(f.source, { ...f, configPath: missing })).rejects.toMatchObject({
      name: 'RenderError', source: { path: missing }, dependencies: expect.arrayContaining([missing]),
    });
    await writeFile(f.globalThemePath, '[broken');
    await expect(loadConfig(f.source, f)).rejects.toMatchObject({ name: 'RenderError', source: { path: f.globalThemePath } });
    await rm(f.globalThemePath);
    await mkdir(f.globalThemePath);
    await expect(loadConfig(f.source, f)).rejects.toMatchObject({ name: 'RenderError', source: { path: f.globalThemePath } });
  });
});

describe('completed page geometry validation', () => {
  it('accepts a custom page assembled across layers with mixed supported units', async () => {
    const f = await fixture();
    await writeFile(f.globalThemePath, '[page]\nsize = "custom"\nwidth = "8in"\nheight = "24cm"\n[page.margins]\nleft = "0pt"\nright = "10mm"\n');
    await writeFile(f.source, '+++\n[page.margins]\ntop = "1cm"\nbottom = "12pt"\n+++\nText');
    const result = await loadConfig(f.source, f);
    expect(result.config.page).toMatchObject({ size: 'custom', width: '8in', height: '24cm' });
    expect(result.config.page.margins).toEqual({ top: '1cm', bottom: '12pt', left: '0pt', right: '10mm' });
  });

  it('rejects named-size dimensions, missing custom dimensions, and margins leaving no area', async () => {
    const f = await fixture();
    for (const page of [
      '[page]\nwidth = "100mm"',
      '[page]\nsize = "custom"\nwidth = "100mm"',
      '[page.margins]\nleft = "105mm"\nright = "105mm"',
      '[page.margins]\ntop = "-1mm"',
    ]) {
      await writeFile(f.source, `+++\n${page}\n+++\nText`);
      await expect(loadConfig(f.source, f)).rejects.toBeInstanceOf(RenderError);
    }
  });
});
