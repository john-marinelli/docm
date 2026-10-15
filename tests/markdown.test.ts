import { describe, expect, it } from 'vitest';
import { defaults } from '../src/config/defaults.js';
import { finalizeConfig } from '../src/config/schema.js';
import { prepareMarkdown } from '../src/render/markdown.js';

const config = finalizeConfig(defaults);
const options = { sourcePath: '/documents/Technical notes.md', lineOffset: 0, config };

// These assert authored behavior, not parser implementation details.
describe('standalone pagebreak authoring', () => {
  it.each([0, 1, 2, 3])('interrupts a paragraph with %i leading spaces and no blank lines', async (indent) => {
    const result = await prepareMarkdown(`Before\n${' '.repeat(indent)}:::pagebreak   \nAfter`, options);
    expect(result.html).toBe('<p>Before</p>\n<p class="docm-pagebreak">After</p>');
  });

  it('handles CRLF while ignoring leading, trailing, and repeated markers', async () => {
    const result = await prepareMarkdown([
      ':::pagebreak', ':::pagebreak', '# First', ':::pagebreak',
      ':::pagebreak', '[unused]: local.png', '', 'After', ':::pagebreak', ':::pagebreak',
    ].join('\r\n'), options);
    expect(result.html).toBe('<h1 id="first">First</h1>\n<p class="docm-pagebreak">After</p>');
    expect((await prepareMarkdown(':::pagebreak\n:::pagebreak', options)).html).toBe('');
  });

  it('keeps fenced, indented, inline-code, and math markers literal', async () => {
    const input = [
      '```not-a-language', ':::pagebreak', '```', '',
      '    :::pagebreak', '',
      'Inline `:::pagebreak` and $:::pagebreak$.', '',
      'Inline `start', ':::pagebreak', 'end` remains code.', '',
      'Inline $start', ':::pagebreak', 'end$ remains math.', '',
      '$$', ':::pagebreak', '$$', '', 'After',
    ].join('\n');
    const result = await prepareMarkdown(input, options);
    expect(result.html).not.toContain('docm-pagebreak');
    expect(result.html).toContain('<code>:::pagebreak</code>');
    expect(result.html).toContain('start :::pagebreak end');
    expect(result.math.map((math) => math.tex)).toEqual([
      ':::pagebreak', 'start\n:::pagebreak\nend', ':::pagebreak',
    ]);
    expect(result.math.map((math) => math.display)).toEqual([false, false, true]);
    expect(result.html).not.toContain('language-math');
  });

  it.each(['::::pagebreak', ':::pagebreak extra', ':::pagebreak\t', 'prefix :::pagebreak', '\\:::pagebreak'])
    ('does not consume the near-match %s', async (literal) => {
      const result = await prepareMarkdown(`Before\n${literal}\nAfter`, options);
      expect(result.html).not.toContain('docm-pagebreak');
      expect(result.html).toContain(':::pagebreak');
    });

  it('keeps custom block classes when a break precedes code, math, or Mermaid', async () => {
    const result = await prepareMarkdown([
      'Before', ':::pagebreak', '```unknown', '<code>', '```',
      ':::pagebreak', '$$', 'x_g', '$$',
      ':::pagebreak', '```mermaid', 'graph TD; A-->B;', '```',
    ].join('\n'), { ...options, lineOffset: 8 });
    expect(result.html).toMatch(/<pre class="docm-code docm-code-wrap docm-pagebreak">/);
    expect(result.html).toMatch(/<div class="docm-math-display docm-pagebreak" data-docm-math="math-1"><\/div>/);
    expect(result.html).toMatch(/<div class="docm-mermaid docm-pagebreak" data-docm-diagram="diagram-1"><\/div>/);
    expect(result.math[0]?.source).toEqual({ path: options.sourcePath, line: 15, column: 1 });
    expect(result.diagrams[0]?.source).toEqual({ path: options.sourcePath, line: 19, column: 1 });
  });
});

describe('heading and literal HTML authoring', () => {
  it('uses unique source-text slugs, unchanged levels, and the first unnumbered h1 title', async () => {
    const result = await prepareMarkdown('### Skip\n# A *title*\n### Skip\n# A *title*', options);
    expect(result.title).toBe('A title');
    expect(result.headings).toEqual([
      { id: 'skip', level: 3, text: 'Skip' },
      { id: 'a-title', level: 1, text: 'A title' },
      { id: 'skip-1', level: 3, text: 'Skip' },
      { id: 'a-title-1', level: 1, text: 'A title' },
    ]);
    expect(result.html).toContain('<h3 id="skip-1">Skip</h3>');
    expect(result.html).not.toContain('docm-toc');
    expect((await prepareMarkdown('No heading', options)).title).toBe('Technical notes');
  });

  it('numbers only present ancestor counters and keeps Contents unnumbered', async () => {
    const numbered = finalizeConfig({ ...defaults, document: { toc: true, number_headings: true } });
    const result = await prepareMarkdown([
      '### Orphan', '# Main', '### Jump', '### Jump', '## Middle', '###### Deep', '# Main',
    ].join('\n'), { ...options, config: numbered });
    expect(result.headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 3, text: '1 Orphan' }, { level: 1, text: '1 Main' },
      { level: 3, text: '1.1 Jump' }, { level: 3, text: '1.2 Jump' },
      { level: 2, text: '1.1 Middle' }, { level: 6, text: '1.1.1 Deep' },
      { level: 1, text: '2 Main' },
    ]);
    expect(result.title).toBe('Main');
    expect(result.html).toMatch(/^<nav class="docm-toc"/);
    expect(result.html).toContain('<p class="docm-toc-title">Contents</p>');
    expect(result.html).toContain('href="#jump-1">1.2 Jump</a>');
    expect(result.html).toContain('<h6 id="deep">1.1.1 Deep</h6>');
    expect(result.headings).toHaveLength(7);
  });

  it('renders block and inline raw HTML as literal text, never active markup', async () => {
    const result = await prepareMarkdown([
      '<script>alert("bad")</script>', '',
      'Inline <b>bold</b> and <img src="https://example.com/image.png" onerror="bad()">.',
    ].join('\n'), options);
    expect(result.html).not.toMatch(/<(?:script|b|img)(?:\s|>)/);
    expect(result.html).toMatch(/(?:&lt;|&#x3[Cc];)script>/);
    expect(result.html).toMatch(/(?:&lt;|&#x3[Cc];)b>bold/);
    expect(result.html).toContain('onerror=');
    expect(result.images).toEqual([]);
  });
});
