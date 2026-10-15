import path from 'node:path';
import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Properties, Root as HastRoot } from 'hast';
import type { Code, Definition, Html, Image, ImageReference, Nodes, Parent, Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Config } from '../config/schema.js';
import { RenderError } from '../shared/errors.js';
import type { SourceLocation } from '../shared/types.js';
import type { MarkdownModel } from './model.js';
import { remarkPagebreak } from './pagebreak.js';

export interface MarkdownOptions {
  sourcePath: string;
  lineOffset: number;
  config: Config;
}

let highlighterPromise: Promise<Highlighter> | undefined;

function element(tagName: string, properties: Properties = {}, children: ElementContent[] = []): Element {
  return { type: 'element', tagName, properties, children };
}

function plainText(node: Nodes): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if ('children' in node) return node.children.map(plainText).join('');
  return 'value' in node ? node.value : '';
}

function addClass(node: Nodes, name: string): void {
  const data = node.data ??= {};
  const properties = data.hProperties ??= {};
  const existing = properties.className;
  properties.className = [
    ...(Array.isArray(existing) ? existing.map(String) : []),
    name,
  ];
}


/** Attach breaks to content rather than emitting a block that could make an empty page. */
function consumePagebreaks(parent: Parent, prepared: Map<Nodes, Element>): void {
  let seenBlock = false;
  let pending = false;
  const children: typeof parent.children = [];
  for (const child of parent.children) {
    if (child.type === 'docmPagebreak') {
      pending ||= seenBlock;
      continue;
    }
    if (child.type !== 'definition' && child.type !== 'footnoteDefinition') {
      if (pending) {
        const placeholder = prepared.get(child);
        if (placeholder) {
          placeholder.properties.className = [...placeholder.properties.className as string[], 'docm-pagebreak'];
        } else {
          addClass(child, 'docm-pagebreak');
        }
      }
      seenBlock = true;
      pending = false;
    }
    if ('children' in child) consumePagebreaks(child, prepared);
    children.push(child);
  }
  parent.children = children;
}

async function renderCode(node: Code, config: Config): Promise<Element> {
  const language = node.lang ?? '';
  let pre: Element;
  if (Object.hasOwn(bundledLanguages, language)) {
    const engine = await (highlighterPromise ??= createHighlighter({ themes: [], langs: [] }));
    await Promise.all([engine.loadLanguage(language as BundledLanguage), engine.loadTheme(config.code.theme)]);
    const highlighted = engine.codeToHast(node.value, { lang: language as BundledLanguage, theme: config.code.theme });
    const result = highlighted.children.find((child): child is Element => child.type === 'element' && child.tagName === 'pre');
    if (!result) throw new Error('Syntax highlighter did not return a code block');
    pre = result;
    // Named code style owns the block; only the token spans retain Shiki colors.
    delete pre.properties.style;
    // Shiki emits `class`, while our HAST elements use `className`.
    // Keeping both serializes duplicate HTML attributes; Chromium retains the first.
    delete pre.properties.class;
    const code = pre.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
    if (code) delete code.properties.style;
  } else {
    const lines: ElementContent[] = [];
    node.value.split('\n').forEach((line, index) => {
      if (index > 0) lines.push({ type: 'text', value: '\n' });
      lines.push(element('span', { className: ['line'] }, [{ type: 'text', value: line }]));
    });
    pre = element('pre', {}, [element('code', {}, lines)]);
  }
  pre.properties.className = ['docm-code', config.code.wrap ? 'docm-code-wrap' : 'docm-code-nowrap',
    ...(config.code.line_numbers ? ['docm-code-line-numbers'] : [])];
  let line = 0;
  visit(pre, 'element', (child) => {
    if (Array.isArray(child.properties.className) && child.properties.className.includes('line')) {
      child.properties.dataLine = ++line;
    }
  });
  return pre;
}

function contents(headings: MarkdownModel['headings']): Element {
  return element('nav', { className: ['docm-toc'], ariaLabel: 'Contents' }, [
    element('p', { className: ['docm-toc-title'] }, [{ type: 'text', value: 'Contents' }]),
    element('ul', {}, headings.map((heading) => element('li', { dataLevel: heading.level }, [
      element('a', { href: `#${heading.id}` }, [{ type: 'text', value: heading.text }]),
    ]))),
  ]);
}

/** Parse authored Markdown once, with no raw HTML or unapproved image URLs in HTML. */
export async function prepareMarkdown(markdown: string, options: MarkdownOptions): Promise<MarkdownModel> {
  const { config, sourcePath, lineOffset } = options;
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  let tree: Root = parser.parse(markdown);
  const markers = [...markdown.matchAll(/:::pagebreak *(?=\r?\n|\r|$)/g)].map((match) => match.index);
  if (markers.length > 0) {
    // Block parsing normally interrupts multiline code spans/math before inline
    // parsing can identify them. Let the upstream parser own those delimiters.
    const protectedOffsets = new Set<number>();
    visit(tree, (node) => {
      if (node.type !== 'inlineCode' && node.type !== 'inlineMath') return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const offset of markers) {
        if (offset >= start && offset < end) protectedOffsets.add(offset);
      }
    });
    tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
      .use(remarkPagebreak, { protectedOffsets }).parse(markdown);
  }
  const model: MarkdownModel = {
    html: '', title: path.basename(sourcePath, path.extname(sourcePath)),
    headings: [], math: [], diagrams: [], images: [],
  };
  const source = (node: Nodes): SourceLocation => ({
    path: sourcePath, line: (node.position?.start.line ?? 1) + lineOffset,
    column: node.position?.start.column ?? 1,
  });
  const prepared = new Map<Nodes, Element>();
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const slugger = new GithubSlugger();
  const counters = [0, 0, 0, 0, 0, 0];
  let foundTitle = false;
  const codes: Code[] = [];
  visit(tree, (node) => {
    if (node.type === 'heading') {
      const text = plainText(node);
      const id = slugger.slug(text);
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, id };
      if (node.depth === 1 && !foundTitle) {
        model.title = text;
        foundTitle = true;
      }
      let label = text;
      if (config.document.number_headings) {
        counters[node.depth - 1] += 1;
        counters.fill(0, node.depth);
        const number = counters.slice(0, node.depth).filter((value) => value !== 0).join('.');
        label = `${number} ${text}`;
        node.children.unshift({ type: 'text', value: `${number} ` });
      }
      model.headings.push({ id, level: node.depth, text: label });
    } else if (node.type === 'math' || node.type === 'inlineMath') {
      const id = `math-${model.math.length + 1}`;
      const display = node.type === 'math';
      model.math.push({ id, tex: node.value, display, source: source(node) });
      prepared.set(node, element(display ? 'div' : 'span', {
        className: [display ? 'docm-math-display' : 'docm-math-inline'], dataDocmMath: id,
      }));
    } else if (node.type === 'code') {
      if (node.lang === 'mermaid') {
        const id = `diagram-${model.diagrams.length + 1}`;
        model.diagrams.push({ id, code: node.value, source: source(node) });
        prepared.set(node, element('div', { className: ['docm-mermaid'], dataDocmDiagram: id }));
      } else {
        codes.push(node);
      }
    } else if (node.type === 'image' || node.type === 'imageReference') {
      const definition = node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
      const url = node.type === 'image' ? node.url : definition?.url;
      if (url === undefined) return;
      if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) {
        throw new RenderError('Images must use local filesystem paths, not URLs', [sourcePath], source(node));
      }
      const id = `image-${model.images.length + 1}`;
      model.images.push({ id, url, source: source(node) });
      const title = node.type === 'image' ? node.title : definition?.title;
      prepared.set(node, element('img', {
        className: ['docm-image'], dataDocmImage: id, alt: node.alt ?? '', ...(title ? { title } : {}),
      }));
    }
  });
  // Keep AST/source order deterministic regardless of grammar-loading completion order.
  await Promise.all(codes.map(async (node) => {
    try {
      prepared.set(node, await renderCode(node, config));
    } catch (cause) {
      throw new RenderError(`Cannot highlight code: ${cause instanceof Error ? cause.message : String(cause)}`,
        [sourcePath], source(node), { cause });
    }
  }));
  consumePagebreaks(tree, prepared);

  const converter = unified().use(remarkRehype, {
    handlers: {
      code(state, node: Code) {
        const result = prepared.get(node)!;
        state.patch(node, result);
        return result;
      },
      math(state, node: Nodes) {
        const result = prepared.get(node)!;
        state.patch(node, result);
        return result;
      },
      inlineMath(state, node: Nodes) {
        const result = prepared.get(node)!;
        state.patch(node, result);
        return result;
      },
      image(state, node: Image) {
        const result = prepared.get(node)!;
        state.patch(node, result);
        return result;
      },
      imageReference(state, node: ImageReference) {
        const result = prepared.get(node);
        if (!result) return { type: 'text', value: node.alt ?? '' };
        state.patch(node, result);
        return result;
      },
      html(state, node: Html, parent) {
        const text = { type: 'text' as const, value: node.value };
        if (parent?.type === 'paragraph' || parent?.type === 'heading') return text;
        const result = element('div', { className: ['docm-html-literal'], style: 'white-space:pre-wrap' }, [text]);
        state.patch(node, result);
        return state.applyData(node, result);
      },
    },
  }).use(rehypeStringify);
  const htmlTree = await converter.run(tree) as HastRoot;
  // Markdown links may navigate, but executable/unapproved schemes never reach a renderer.
  visit(htmlTree, 'element', (node) => {
    if (node.tagName !== 'a' || typeof node.properties.href !== 'string') return;
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(node.properties.href);
    if (scheme && !['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())) delete node.properties.href;
  });
  if (config.document.toc && model.headings.length > 0) htmlTree.children.unshift(contents(model.headings));
  model.html = converter.stringify(htmlTree);
  return model;
}
