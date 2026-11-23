import { placeholderText } from './placeholder.js';
import type { Block, Item } from './blocks.js';
import type { ProjectConfig } from './config.js';
import type { Inline } from './inline.js';
import { walk } from './walk.js';

/**
 * Snippets: reusable wording (a standard sentence, a safety paragraph) kept
 * as a module of a type the configuration marks `snippet: true`. Nothing
 * here names a type: which types are snippets is configuration.
 */

/** How many characters of a module's plain text `plainTextExcerpt` gives by default. */
export const SNIPPET_EXCERPT_LENGTH = 200;

/** The IDs of the configured snippet types, in their configured order. */
export function snippetTypes(
  config: Pick<ProjectConfig, 'moduleTypes'>,
): string[] {
  return config.moduleTypes.filter((t) => t.snippet).map((t) => t.id);
}

/** Whether `type` is a configured snippet type. */
export function isSnippetType(
  config: Pick<ProjectConfig, 'moduleTypes'>,
  type: string,
): boolean {
  return config.moduleTypes.some((t) => t.id === type && t.snippet);
}

/**
 * The blocks a snippet should not hold (`snippet-too-large`): a section
 * makes it a document of its own, a module reference makes it a manual's
 * part. Every such block, in document order (one inside another too).
 */
export function blocksTooLargeForSnippet(blocks: readonly Block[]): Block[] {
  const found: Block[] = [];
  for (const { kind, node } of walk(blocks)) {
    if (
      kind === 'block' &&
      (node.type === 'section' || node.type === 'moduleRef')
    )
      found.push(node);
  }
  return found;
}

/**
 * The plain text of some blocks as a reader reads it, in document order:
 * each block's or item's own text (a paragraph's, a heading's, an item's, a
 * safety notice's hazard, a code block's, an image's alt text), runs of
 * white space as one space, cut to `max` characters (code points, never
 * half a pair). A text attribute's value depends on the manual, so it reads
 * as its reference, `{name}`; a cross-reference reads as its own text, if
 * it has any.
 */
export function plainTextExcerpt(
  blocks: readonly Block[],
  max: number = SNIPPET_EXCERPT_LENGTH,
): string {
  const parts: string[] = [];
  let length = 0;
  for (const { node } of walk(blocks)) {
    const text = ownText(node).replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
    if (length > max) break;
  }
  const whole = parts.join(' ');
  const chars = Array.from(whole);
  return chars.length <= max ? whole : chars.slice(0, max).join('').trimEnd();
}

/**
 * Text folded for comparing, as search folds it: lower case, no
 * diacritics (`ä` is `a`), `ß` as `ss`, runs of white space as one space.
 */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('ß', 'ss')
    .replace(/\s+/gu, ' ');
}

function inlineText(content: readonly Inline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'xref':
          return node.text?.map((run) => run.text).join('') ?? '';
        case 'kbd':
          return node.keys.join('+');
        case 'hardBreak':
          return ' ';
        case 'calloutRef':
          return '';
        case 'attribute':
          return `{${node.name}}`;
        case 'placeholder':
          return placeholderText(node.key);
        default:
          node satisfies never;
          return '';
      }
    })
    .join('');
}

function ownText(node: Block | Item): string {
  if (!('type' in node)) return inlineText(node.content);
  switch (node.type) {
    case 'paragraph':
      return inlineText(node.content);
    case 'section':
      return inlineText(node.title);
    case 'procedure':
    case 'table':
      return inlineText(node.title);
    case 'image':
      return node.alt;
    case 'attachment':
      return node.name;
    case 'safety':
      return inlineText(node.hazard);
    case 'faq':
      return inlineText(node.question);
    case 'literal':
      return node.text;
    case 'list':
    case 'admonition':
    case 'variant':
    case 'moduleRef':
    case 'passthrough':
    case 'pageBreak':
      return '';
    default:
      node satisfies never;
      return '';
  }
}
