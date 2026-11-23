import type { Block, Item } from './blocks.js';
import type { Inline } from './inline.js';
import { walk } from './walk.js';

/** A term link (#245) in content: the term it names and the block (or list item) it is in. */
export interface TermLink {
  readonly termId: string;
  /** The block's, list item's or step's own ID. */
  readonly blockId: string;
}

/**
 * A block's or item's own inline content (not that of the blocks inside it):
 * a paragraph's text, a title, a list item's text, a hazard, a question, an
 * image's callout legends (after its title).
 */
export function ownInlineContent(node: Block | Item): Inline[][] {
  if (!('type' in node)) return [node.content];
  switch (node.type) {
    case 'paragraph':
      return [node.content];
    case 'section':
      return [node.title];
    case 'procedure':
    case 'table':
      return node.title ? [node.title] : [];
    case 'image':
      return [
        ...(node.title ? [node.title] : []),
        ...(node.callouts ?? []).map((c) => c.legend),
      ];
    case 'safety':
      return [node.hazard];
    case 'faq':
      return [node.question];
    default:
      return [];
  }
}

/**
 * Every term link in `blocks`, at any depth, in document order (each run of
 * text once; a term linked twice is listed twice). Variant blocks are
 * walked like any other; module references are not followed.
 */
export function* termLinks(blocks: readonly Block[]): Generator<TermLink> {
  for (const { node } of walk(blocks)) {
    for (const content of ownInlineContent(node)) {
      let last: string | undefined;
      for (const inline of content) {
        const termId =
          inline.type === 'text'
            ? inline.marks?.find((m) => m.type === 'term')?.termId
            : undefined;
        // Neighbouring runs of one link (split by other marks) are one link.
        if (termId !== undefined && termId !== last) {
          yield { termId, blockId: node.id };
        }
        last = termId;
      }
    }
  }
}

/** The terms `blocks` link, each once, in document order. */
export function linkedTermIds(blocks: readonly Block[]): string[] {
  return [...new Set([...termLinks(blocks)].map((link) => link.termId))];
}
