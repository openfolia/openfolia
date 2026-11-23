import { placeholderText } from './placeholder.js';
import type { Inline, Mark } from './inline.js';

/**
 * Markdown (CommonMark with GFM tables) for the retrieval chunks: plain
 * text a pipeline embeds, never HTML. Every character Markdown would read
 * as markup (or HTML) is backslash-escaped, so text reads back as the text
 * it is.
 */

/** Characters escaped anywhere in text: emphasis, code, links, HTML and entities, tables. */
const ESCAPED = /[\\`*_[\]<>|~&]/g;

/** Escapes text for use inside a Markdown line. */
export function escapeMarkdown(text: string): string {
  return text.replace(ESCAPED, (ch) => `\\${ch}`);
}

/**
 * Escapes what would start a block at the start of a line (a heading, a
 * quote, a list item, a thematic break, a table row, a fence).
 */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])/, '$1$2\\$3');
}

/** A code span holding `text` verbatim: the fence is longer than any run of backticks inside. */
export function codeSpan(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced code block holding `text` verbatim: the fence is longer than any run of backticks inside. */
export function codeBlock(text: string, info = ''): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info.replace(/[`\s]/g, '')}\n${text}\n${fence}`;
}

export interface InlineContext {
  /** The text of an `attribute` node (`{name}` when there is no value). */
  attribute: (name: string) => string;
  /** The text of a cross-reference without its own text: the target's title. */
  xrefTitle: (module: string, block: string | undefined) => string;
  /** The text of a callout reference (`calloutRef`), by its image block and callout. */
  callout: (block: string, callout: string) => string;
}

const has = (marks: readonly Mark[] | undefined, type: Mark['type']) =>
  marks?.some((m) => m.type === type) ?? false;

/**
 * Inline content as Markdown on one line or more (a hard break is a
 * backslash at the end of a line). Emphasis around a run keeps its
 * surrounding spaces outside the delimiters, so it still reads as emphasis.
 */
export function inlineMarkdown(
  nodes: readonly Inline[],
  context: InlineContext,
): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += markedText(node.text, node.marks);
        break;
      case 'attribute':
        out += escapeMarkdown(context.attribute(node.name));
        break;
      case 'xref': {
        const text =
          node.text?.map((run) => markedText(run.text, run.marks)).join('') ??
          escapeMarkdown(context.xrefTitle(node.module, node.block));
        out += text;
        break;
      }
      case 'kbd':
        out += codeSpan(node.keys.join('+'));
        break;
      case 'calloutRef':
        out += escapeMarkdown(context.callout(node.block, node.callout));
        break;
      case 'hardBreak':
        out += '\\\n';
        break;
      case 'placeholder':
        out += escapeMarkdown(placeholderText(node.key));
        break;
      default:
        node satisfies never;
    }
  }
  return out;
}

function markedText(text: string, marks: readonly Mark[] | undefined): string {
  if (has(marks, 'code')) return wrapLink(codeSpan(text), marks);
  const [, lead = '', core = '', trail = ''] =
    /^(\s*)(.*?)(\s*)$/s.exec(text) ?? [];
  if (core === '') return text;
  let inner = escapeMarkdown(core);
  if (has(marks, 'emphasis')) inner = `*${inner}*`;
  // A label in a user interface reads as bold, as the renderers show it.
  if (has(marks, 'strong') || has(marks, 'ui')) inner = `**${inner}**`;
  return `${lead}${wrapLink(inner, marks)}${trail}`;
}

function wrapLink(text: string, marks: readonly Mark[] | undefined): string {
  const link = marks?.find((m) => m.type === 'link');
  // `LinkHref` holds no whitespace, brackets or `|`; parentheses are escaped.
  return link
    ? `[${text}](${link.href.replace(/[()]/g, (ch) => `\\${ch}`)})`
    : text;
}
