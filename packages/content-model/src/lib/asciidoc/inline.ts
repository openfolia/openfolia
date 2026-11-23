import { RESERVED_TERM_IDS } from '../ids.js';
import type { Inline, Mark, TextNode } from '../inline.js';
import { normalizeInline, sameMark, sortMarks } from '../normalize.js';
import {
  AsciidocParseError,
  EMPTY,
  ESCAPED_CHARS,
  ESCAPED_PREFIXES,
  escapeText,
  guardLine,
} from './syntax.js';

/**
 * Inline syntax (always the unconstrained forms, so no word-boundary rules):
 *
 *   **strong**  __emphasis__  ``code``  ~sub~  ^sup^  [.ui]##label##
 *   link:https://example.com[text]   xref:module.adoc#block[text]
 *   [.term.<term-id>]##text##  (a term link: a span with the role `term` and the term's ID)
 *   kbd:[Ctrl+S]   {attribute}   hard break: " +" at the end of a line
 *   placeholder:document-number[]  (a page design's placeholder, #390)
 *   callout:<image-block>#<callout>[]  (a callout reference, #498)
 */

type Plain = Exclude<Mark['type'], 'link' | 'term'>;

const OPEN: Record<Plain, string> = {
  ui: '[.ui]##',
  strong: '**',
  emphasis: '__',
  code: '``',
  sub: '~',
  sup: '^',
};
const CLOSE: Record<Plain, string> = {
  ui: '##',
  strong: '**',
  emphasis: '__',
  code: '``',
  sub: '~',
  sup: '^',
};

const open = (mark: Mark) =>
  mark.type === 'link'
    ? `link:${mark.href}[`
    : mark.type === 'term'
      ? `[.term.${mark.termId}]##`
      : OPEN[mark.type];
const close = (mark: Mark) =>
  mark.type === 'link' ? ']' : mark.type === 'term' ? '##' : CLOSE[mark.type];

/** The start of a callout reference, malformed or not: `callout:` then an ID, then `#` or `[`. */
const CALLOUT_ATTEMPT = /^callout:[a-z_][a-z0-9_-]*[#[]/;

/** A term link's opening: `[.term.<id>]##`, the ID a term ID's form. */
const TERM_OPEN = /^\[\.term\.([a-z0-9]+(?:-[a-z0-9]+)*)\]##/;

/**
 * Prints inline content. Hard breaks become " +\n"; every line after a
 * break is guarded against being read as block syntax. Set `guardFirst`
 * when the content starts a line of its own.
 */
export function printInline(
  nodes: readonly Inline[],
  guardFirst: boolean,
): string {
  let out = '';
  let stack: Mark[] = [];

  const closeTo = (depth: number) => {
    while (stack.length > depth) out += close(stack.pop() as Mark);
  };

  for (const node of nodes) {
    const target = node.type === 'text' ? sortMarks(node.marks ?? []) : [];
    let keep = 0;
    while (
      keep < stack.length &&
      keep < target.length &&
      sameMark(stack[keep] as Mark, target[keep] as Mark)
    )
      keep++;
    closeTo(keep);
    for (const mark of target.slice(keep)) {
      out += open(mark);
      stack = [...stack, mark];
    }

    switch (node.type) {
      case 'text':
        out += escapeText(node.text);
        break;
      case 'attribute':
        out += `{${node.name}}`;
        break;
      case 'xref':
        out += `xref:${node.module}.adoc${node.block ? `#${node.block}` : ''}[${node.text ? printInline(node.text, false) : ''}]`;
        break;
      case 'kbd':
        out += `kbd:[${node.keys.map((key) => key.replace(/[\\+[\]]/g, (c) => `\\${c}`)).join('+')}]`;
        break;
      case 'calloutRef':
        out += `callout:${node.block}#${node.callout}[]`;
        break;
      case 'hardBreak':
        out += ' +\n';
        break;
      case 'placeholder':
        out += `placeholder:${node.key}[]`;
        break;
      default:
        node satisfies never;
    }
  }
  closeTo(0);
  // A trailing hard break ends the line with " +"; no newline follows it.
  if (out.endsWith(' +\n')) out = out.slice(0, -1);

  return out
    .split('\n')
    .map((line, i) => (i > 0 || guardFirst ? guardLine(line) : line))
    .join('\n');
}

/** Parses inline content. `line` is used for error messages. */
export function parseInline(source: string, line?: number): Inline[] {
  const nodes: Inline[] = [];
  const stack: Mark[] = [];
  let buffer = '';
  let i = 0;

  const fail = (message: string): never => {
    throw new AsciidocParseError(message, line);
  };
  const flush = () => {
    if (buffer === '') return;
    const node: TextNode = { type: 'text', text: buffer };
    if (stack.length > 0) node.marks = sortMarks(stack);
    nodes.push(node);
    buffer = '';
  };
  const toggle = (mark: Mark, token: string) => {
    flush();
    const top = stack.at(-1);
    if (top?.type === mark.type) {
      stack.pop();
    } else if (stack.some((m) => m.type === mark.type)) {
      fail(`"${token}" closes a mark that is not the innermost one`);
    } else {
      stack.push(mark);
    }
    i += token.length;
  };
  /**
   * Index of the "]" closing a bracket opened just before `from`. Text
   * brackets are always escaped, so unescaped ones nest (as in `[.ui]##`).
   */
  const closingBracket = (from: number): number => {
    let depth = 0;
    for (let j = from; j < source.length; j++) {
      const c = source.charAt(j);
      if (c === '\\') j++;
      else if (c === '[') depth++;
      else if (c === ']' && depth-- === 0) return j;
    }
    return fail('missing "]"');
  };

  while (i < source.length) {
    const ch = source.charAt(i);

    if (source.startsWith(EMPTY, i)) {
      i += EMPTY.length;
    } else if (ch === '\\') {
      const next = source.charAt(i + 1);
      const prefix = ESCAPED_PREFIXES.find((p) => source.startsWith(p, i + 1));
      if (ESCAPED_CHARS.has(next)) {
        buffer += next;
        i += 2;
      } else if (prefix) {
        buffer += prefix;
        i += 1 + prefix.length;
      } else {
        buffer += ch;
        i++;
      }
    } else if (
      source.startsWith(' +', i) &&
      (i + 2 === source.length || source.charAt(i + 2) === '\n')
    ) {
      flush();
      nodes.push({ type: 'hardBreak' });
      i += source.charAt(i + 2) === '\n' ? 3 : 2;
    } else if (ch === '\n') {
      // A soft line break (never printed, but valid AsciiDoc) reads as a space.
      buffer += ' ';
      i++;
    } else if (source.startsWith('**', i)) {
      toggle({ type: 'strong' }, '**');
    } else if (source.startsWith('__', i)) {
      toggle({ type: 'emphasis' }, '__');
    } else if (source.startsWith('``', i)) {
      toggle({ type: 'code' }, '``');
    } else if (ch === '~') {
      toggle({ type: 'sub' }, '~');
    } else if (ch === '^') {
      toggle({ type: 'sup' }, '^');
    } else if (source.startsWith('[.ui]##', i)) {
      if (stack.some((m) => m.type === 'ui')) fail('nested [.ui] label');
      flush();
      stack.push({ type: 'ui' });
      i += '[.ui]##'.length;
    } else if (source.startsWith('[.term.', i)) {
      const opening = TERM_OPEN.exec(source.slice(i));
      if (!opening)
        return fail('invalid term link; expected [.term.<term-id>]##text##');
      if (RESERVED_TERM_IDS.includes(opening[1] as string))
        fail(`"${opening[1]}" is no term ID`);
      if (stack.some((m) => m.type === 'term')) fail('nested term link');
      if (stack.some((m) => m.type === 'link')) fail('term link inside a link');
      flush();
      stack.push({ type: 'term', termId: opening[1] as string });
      i += opening[0].length;
    } else if (
      source.startsWith('##', i) &&
      (stack.at(-1)?.type === 'ui' || stack.at(-1)?.type === 'term')
    ) {
      flush();
      stack.pop();
      i += 2;
    } else if (source.startsWith('link:', i)) {
      const bracket = source.indexOf('[', i);
      if (bracket < 0) fail('link without "[...]"');
      const href = source.slice(i + 'link:'.length, bracket);
      if (href === '' || /\s/.test(href)) fail(`invalid link target "${href}"`);
      if (stack.some((m) => m.type === 'link')) fail('link inside a link');
      if (stack.some((m) => m.type === 'term')) fail('link inside a term link');
      flush();
      stack.push({ type: 'link', href });
      i = bracket + 1;
    } else if (ch === ']' && stack.at(-1)?.type === 'link') {
      flush();
      stack.pop();
      i++;
    } else if (source.startsWith('xref:', i)) {
      const target = /^xref:([a-z0-9-]+)\.adoc(?:#([a-z_][a-z0-9_-]*))?\[/.exec(
        source.slice(i),
      );
      if (!target)
        return fail('invalid xref; expected xref:<module>.adoc[#block][text]');
      const start = i + target[0].length;
      const end = closingBracket(start);
      const text = parseInline(source.slice(start, end), line);
      if (text.some((n) => n.type !== 'text'))
        fail('xref text may only contain text');
      flush();
      nodes.push({
        type: 'xref',
        module: target[1] as string,
        ...(target[2] ? { block: target[2] } : {}),
        ...(text.length > 0 ? { text: text as TextNode[] } : {}),
      });
      i = end + 1;
    } else if (CALLOUT_ATTEMPT.test(source.slice(i, i + 80))) {
      // Only what reads as a reference is one (an image ID, then `#` or `[`): `callout:`
      // in prose, which files from before callouts never escaped, stays text.
      const ref = /^callout:([a-z_][a-z0-9_-]*)#([a-z_][a-z0-9_-]*)\[\]/.exec(
        source.slice(i),
      );
      if (!ref)
        return fail(
          'invalid callout reference; expected callout:<image-block>#<callout>[]',
        );
      flush();
      nodes.push({
        type: 'calloutRef',
        block: ref[1] as string,
        callout: ref[2] as string,
      });
      i += ref[0].length;
    } else if (source.startsWith('kbd:[', i)) {
      const start = i + 'kbd:['.length;
      const end = closingBracket(start);
      flush();
      nodes.push({ type: 'kbd', keys: splitKeys(source.slice(start, end)) });
      i = end + 1;
    } else if (
      source.startsWith('placeholder:', i) &&
      /^placeholder:[a-z][a-z0-9-]*\[\]/.test(source.slice(i, i + 80))
    ) {
      // Only the whole form is one: text that merely starts so (written before #390, when the
      // printer did not escape it) stays text, so no file becomes unreadable.
      const ref = /^placeholder:([a-z][a-z0-9-]*)\[\]/.exec(
        source.slice(i),
      ) as RegExpExecArray;
      flush();
      nodes.push({ type: 'placeholder', key: ref[1] as string });
      i += ref[0].length;
    } else if (ch === '{') {
      const ref = /^\{([a-z][a-z0-9-]*)\}/.exec(source.slice(i));
      if (!ref)
        return fail(
          '"{" must start an attribute reference like {product-name}, or be escaped',
        );
      flush();
      nodes.push({ type: 'attribute', name: ref[1] as string });
      i += ref[0].length;
    } else {
      buffer += ch;
      i++;
    }
  }
  flush();
  if (stack.length > 0) fail(`unclosed ${stack.map((m) => m.type).join(', ')}`);
  return normalizeInline(nodes);
}

function splitKeys(source: string): string[] {
  const keys: string[] = [];
  let key = '';
  for (let j = 0; j < source.length; j++) {
    const ch = source.charAt(j);
    if (ch === '\\' && j + 1 < source.length) {
      key += source.charAt(++j);
    } else if (ch === '+') {
      keys.push(key);
      key = '';
    } else {
      key += ch;
    }
  }
  keys.push(key);
  return keys;
}
