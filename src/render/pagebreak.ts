import type { Literal, Root } from 'mdast';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import { markdownLineEnding } from 'micromark-util-character';
import type { Construct, Extension, State, Tokenizer } from 'micromark-util-types';
import type { Plugin } from 'unified';

export interface Pagebreak extends Literal {
  type: 'docmPagebreak';
  value: '';
}

export interface PagebreakOptions {
  /** Marker offsets inside upstream-parsed multiline inline code/math. */
  protectedOffsets?: ReadonlySet<number>;
}

declare module 'mdast' {
  interface BlockContentMap { docmPagebreak: Pagebreak }
  interface RootContentMap { docmPagebreak: Pagebreak }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap { docmPagebreak: 'docmPagebreak' }
}

const marker = ':::pagebreak';

/** A flow construct, not a text replacement: code/math own their contents. */
export function pagebreakSyntax(options: PagebreakOptions = {}): Extension {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    let index = 0;
    if (options.protectedOffsets?.has(this.now().offset)) return nok;
    // Flow's linePrefix has already consumed up to three spaces. Tabs are not
    // accepted as the marker's indentation, even when their visual width is short.
    const previous = this.events[this.events.length - 1];
    const prefix = previous?.[1].type === 'linePrefix'
      ? this.sliceSerialize(previous[1]) : '';
    if (!/^ {0,3}$/.test(prefix)) return nok;

    const start: State = (code) => {
      effects.enter('docmPagebreak');
      return sequence(code);
    };
    const sequence: State = (code) => {
      if (index < marker.length) {
        if (code !== marker.charCodeAt(index)) return nok(code);
        effects.consume(code);
        index += 1;
        return sequence;
      }
      if (code === 32) {
        effects.consume(code);
        return sequence;
      }
      if (code === null || markdownLineEnding(code)) {
        effects.exit('docmPagebreak');
        return ok(code);
      }
      return nok(code);
    };
    return start;
  };
  const construct: Construct = { name: 'docmPagebreak', tokenize };
  return { flow: { 58: construct } };
}

export function pagebreakFromMarkdown(): MdastExtension {
  return {
    enter: {
      docmPagebreak(token) {
        this.enter({ type: 'docmPagebreak', value: '' }, token);
      },
    },
    exit: {
      docmPagebreak(token) { this.exit(token); },
    },
  };
}

export const remarkPagebreak: Plugin<[PagebreakOptions?], Root> = function (options) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(pagebreakSyntax(options));
  (data.fromMarkdownExtensions ??= []).push(pagebreakFromMarkdown());
};
