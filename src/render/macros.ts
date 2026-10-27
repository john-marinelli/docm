import type { Literal, Nodes, Parent, Root } from 'mdast';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import { markdownLineEnding } from 'micromark-util-character';
import type { Construct, Extension, State, Tokenizer } from 'micromark-util-types';
import type { Plugin } from 'unified';
import type { Config } from '../config/schema.js';
import { RenderError } from '../shared/errors.js';

interface MacroMarker extends Literal {
  type: 'docmMacroMarker';
  name: string;
  closing: boolean;
  value: '';
}
interface Macro extends Parent {
  type: 'docmMacro';
  name: string;
  inline: boolean;
}
declare module 'mdast' {
  interface BlockContentMap { docmMacroMarker: MacroMarker; docmMacro: Macro }
  interface PhrasingContentMap { docmMacroMarker: MacroMarker; docmMacro: Macro }
  interface RootContentMap { docmMacroMarker: MacroMarker; docmMacro: Macro }
}
declare module 'micromark-util-types' {
  interface TokenTypeMap { docmMacroTag: 'docmMacroTag' }
}

/** Bare configured tags only. Code, math, escapes, attributes, and other HTML stay literal. */
export const remarkMacros: Plugin<[{ macros: Config['macro']; protectedOffsets?: ReadonlySet<number> }], Root> = function (options) {
  const tokenizer = (flow: boolean): Tokenizer => function (effects, ok, nok) {
    let value = '';
    if (options.protectedOffsets?.has(this.now().offset)) return nok;
    const start: State = (code) => {
      effects.enter('docmMacroTag');
      effects.consume(code);
      return inside;
    };
    const inside: State = (code) => {
      if (code === 62) {
        const match = /^(\/?)([A-Za-z][A-Za-z0-9_-]*)$/.exec(value);
        if (!match || !Object.hasOwn(options.macros, match[2]!)) return nok(code);
        effects.consume(code);
        if (flow) return after;
        effects.exit('docmMacroTag');
        return ok;
      }
      if (code === null || !(/[A-Za-z0-9_\/-]/.test(String.fromCharCode(code)))) return nok(code);
      value += String.fromCharCode(code);
      effects.consume(code);
      return inside;
    };
    const after: State = (code) => {
      if (code === 32 || code === -2 || code === -1) {
        effects.consume(code);
        return after;
      }
      if (code !== null && !markdownLineEnding(code)) return nok(code);
      effects.exit('docmMacroTag');
      return ok(code);
    };
    return start;
  };
  const block: Construct = { name: 'docmMacroTag', tokenize: tokenizer(true) };
  const inline: Construct = { name: 'docmMacroTag', tokenize: tokenizer(false) };
  const syntax: Extension = { flow: { 60: block }, text: { 60: inline } };
  const fromMarkdown: MdastExtension = {
    enter: { docmMacroTag(token) {
      const value = this.sliceSerialize(token).trim();
      this.enter({ type: 'docmMacroMarker', value: '', name: value.slice(value[1] === '/' ? 2 : 1, -1), closing: value[1] === '/' }, token);
    } },
    exit: { docmMacroTag(token) { this.exit(token); } },
  };
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};

/** HTML flow may swallow a same-line macro and its Markdown before text tokenization. */
export function expandMacroHtml(tree: Root, macros: Config['macro'], parseInlineHtml: (text: string) => Root): void {
  function expand(parent: Parent): void {
    parent.children = parent.children.flatMap((node) => {
      if (node.type === 'html') {
        const opening = /^<\/?([A-Za-z][A-Za-z0-9_-]*)>/.exec(node.value);
        if (opening && Object.hasOwn(macros, opening[1]!)) {
          const parsed = parseInlineHtml(node.value);
          const origin = node.position!.start;
          function relocate(child: Nodes): void {
            if (child.position) {
              for (const point of [child.position.start, child.position.end]) {
                if (point.line === 1) point.column += origin.column - 1;
                point.line += origin.line - 1;
                if (point.offset !== undefined) point.offset += origin.offset ?? 0;
              }
            }
            if ('children' in child) child.children.forEach(relocate);
          }
          parsed.children.forEach(relocate);
          return parsed.children;
        }
      }
      if ('children' in node) expand(node);
      return [node];
    });
  }
  expand(tree);
}

/** Pair markers in the AST, preserving ordinary Markdown nodes and source coordinates. */
export function groupMacros(tree: Root, sourcePath: string, lineOffset: number): void {
  const fail = (message: string, marker: MacroMarker): never => {
    throw new RenderError(message, [sourcePath], { path: sourcePath,
      line: (marker.position?.start.line ?? 1) + lineOffset, column: marker.position?.start.column ?? 1 });
  };
  function group(parent: Parent): void {
    // A tag crossing paragraph boundaries belongs to the enclosing block container.
    const children: typeof parent.children = [];
    for (const node of parent.children) {
      if (node.type === 'paragraph') {
        const stack: MacroMarker[] = [];
        const paired = new Set<MacroMarker>();
        for (const child of node.children) {
          if (child.type !== 'docmMacroMarker') continue;
          if (!child.closing) stack.push(child);
          else if (stack.at(-1)?.name === child.name) {
            paired.add(stack.pop()!); paired.add(child);
          }
        }
        let segment: typeof node.children = [];
        const flush = () => {
          if (segment.length) children.push({ ...node, children: segment });
          segment = [];
        };
        for (const child of node.children) {
          if (child.type === 'docmMacroMarker' && !paired.has(child)) { flush(); children.push(child); }
          else segment.push(child);
        }
        flush();
      } else children.push(node);
    }
    const output: typeof parent.children = [];
    const stack: { marker: MacroMarker; wrapper: Macro }[] = [];
    for (const node of children) {
      if (node.type === 'docmMacroMarker') {
        if (node.closing) {
          const top = stack.at(-1);
          if (!top || top.marker.name !== node.name) fail(`Unexpected closing macro tag </${node.name}>`, node);
          stack.pop();
          top!.wrapper.position = { start: top!.marker.position!.start, end: node.position!.end };
        } else {
          const wrapper: Macro = { type: 'docmMacro', name: node.name,
            inline: parent.type === 'paragraph' || parent.type === 'heading', children: [], position: node.position };
          (stack.at(-1)?.wrapper.children ?? output).push(wrapper);
          stack.push({ marker: node, wrapper });
        }
      } else {
        if ('children' in node) group(node);
        (stack.at(-1)?.wrapper.children ?? output).push(node);
      }
    }
    if (stack.length) fail(`Unclosed macro tag <${stack.at(-1)!.marker.name}>`, stack.at(-1)!.marker);
    parent.children = output;
  }
  group(tree);
}
