import type { Block } from './blocks.js';
import type { Inline } from './inline.js';
import type { Module } from './module.js';
import { normalizeModule } from './normalize.js';
import { walk } from './walk.js';

/** Which part of a block a piece of translatable text is. */
export const TRANSLATABLE_FIELDS = [
  'title',
  'content',
  'alt',
  'hazard',
  'question',
  'name',
  'description',
  'legend',
] as const;
export type TranslatableField = (typeof TRANSLATABLE_FIELDS)[number];

/**
 * One piece of a unit's text: inline content (alt text, an attachment's
 * name and description as one text run each).
 */
export interface TranslatablePart {
  readonly field: TranslatableField;
  readonly content: readonly Inline[];
}

/**
 * What is translated as one piece: a block's own text, by its block ID (a
 * list item or procedure step counts as a block). Its nested blocks are
 * units of their own, so editing a paragraph inside a section changes the
 * paragraph's unit, not the section's.
 */
export interface TranslatableUnit {
  readonly blockId: string;
  /**
   * The block's type, `item` for a list item or procedure step, or
   * `callout` for an image callout's legend (#548).
   */
  readonly kind: Block['type'] | 'item' | 'callout';
  /** For a `callout`: the image block that holds it. */
  readonly image?: string;
  /** In a fixed order per kind; never empty. */
  readonly parts: readonly TranslatablePart[];
}

/**
 * The translatable units of a module, in document order: paragraphs; the
 * titles of sections, procedures and tables; list items and procedure
 * steps; the paragraphs in table cells; an image's alt text and title; an
 * attachment's name and description; a safety block's hazard; an FAQ
 * entry's question; an image callout's legend (#548), right after its
 * image, in the image's stored order, by the callout's ID (a block ID,
 * unique in the module): every callout, whichever variants show it. The blocks inside notices, safety, FAQ answers, variant
 * blocks and table cells are units of their
 * own. Literal and passthrough blocks are not translated, nor are module
 * references (the module they name has its own units) or page breaks; a
 * block without text of its own (a list, an admonition, a variant block, a
 * procedure or table without a title) has no unit. The module's metadata
 * (title, keywords) is not a block and has no unit.
 *
 * Read from the normalized module, so the units of a module and of its
 * printed and parsed copy are equal.
 */
export function translatableUnits(module: Module): TranslatableUnit[] {
  return blockUnits(normalizeModule(module).blocks);
}

/**
 * The translatable units of `blocks` (normalized already), as `translatableUnits` finds them in
 * a module: a page design's region text (#568) has its units this way.
 */
export function blockUnits(blocks: readonly Block[]): TranslatableUnit[] {
  const units: TranslatableUnit[] = [];
  for (const { kind, node } of walk(blocks)) {
    if (kind === 'item') {
      units.push({
        blockId: node.id,
        kind: 'item',
        parts: [{ field: 'content', content: node.content }],
      });
      continue;
    }
    const parts = partsOf(node);
    if (parts.length > 0) {
      units.push({ blockId: node.id, kind: node.type, parts });
    }
    if (node.type === 'image') {
      for (const callout of node.callouts ?? []) {
        units.push({
          blockId: callout.id,
          kind: 'callout',
          image: node.id,
          parts: [{ field: 'legend', content: callout.legend }],
        });
      }
    }
  }
  return units;
}

function partsOf(block: Block): TranslatablePart[] {
  const text = (value: string): Inline[] => [{ type: 'text', text: value }];
  switch (block.type) {
    case 'paragraph':
      return [{ field: 'content', content: block.content }];
    case 'section':
      return [{ field: 'title', content: block.title }];
    case 'procedure':
    case 'table':
      return block.title ? [{ field: 'title', content: block.title }] : [];
    case 'image':
      return [
        { field: 'alt', content: text(block.alt) },
        ...(block.title
          ? [{ field: 'title' as const, content: block.title }]
          : []),
      ];
    case 'attachment':
      return [
        { field: 'name', content: text(block.name) },
        ...(block.description
          ? [
              {
                field: 'description' as const,
                content: text(block.description),
              },
            ]
          : []),
      ];
    case 'safety':
      return [{ field: 'hazard', content: block.hazard }];
    case 'faq':
      return [{ field: 'question', content: block.question }];
    case 'list':
    case 'admonition':
    case 'variant':
    case 'moduleRef':
    case 'literal':
    case 'passthrough':
    case 'pageBreak':
      return [];
    default:
      return block satisfies never;
  }
}
