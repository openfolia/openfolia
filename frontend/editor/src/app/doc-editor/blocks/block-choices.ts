import type { Block, Inline } from '@openfolia/content-model/core';

/** The block types a module reference to one block (#223) can name, with their names' keys. */
export const BLOCK_TYPE_NAMES: Readonly<Record<string, string>> = {
  section: 'editor.moduleEditor.outline.types.section',
  paragraph: 'editor.moduleEditor.outline.types.paragraph',
  list: 'editor.moduleEditor.outline.types.list',
  procedure: 'editor.moduleEditor.outline.types.procedure',
  table: 'editor.moduleEditor.outline.types.table',
  image: 'editor.moduleEditor.outline.types.image',
  attachment: 'editor.moduleEditor.outline.types.attachment',
  safety: 'editor.moduleEditor.outline.types.safety',
  admonition: 'editor.moduleEditor.outline.types.admonition',
  faq: 'editor.moduleEditor.outline.types.faq',
  variant: 'editor.moduleEditor.outline.types.variant',
  moduleRef: 'editor.moduleEditor.outline.types.moduleRef',
  literal: 'editor.moduleEditor.outline.types.literal',
  passthrough: 'editor.moduleEditor.outline.types.passthrough',
};

/** The longest text a choice shows, in characters (the rest is cut with an ellipsis). */
const TEXT_MAX = 160;

/** A block of another module one can refer to on its own (#223). */
export interface BlockChoice {
  readonly id: string;
  readonly type: Block['type'];
  /** Nesting: 0 for the module's own blocks. */
  readonly depth: number;
  /** Its own text, plain and cut (`TEXT_MAX`): a title, a hazard, its first line…; may be empty. */
  readonly text: string;
}

/**
 * The blocks of a module a reference to one block can name, in document order with their depth:
 * every block at any depth (sections, lists, tables, notices, variant blocks), as the content
 * model looks one up (`blockPlaces`), but page breaks, which hold nothing to reuse.
 */
export function blockChoices(blocks: readonly Block[]): BlockChoice[] {
  const out: BlockChoice[] = [];
  const pending: { block: Block; depth: number }[] = [];
  const push = (list: readonly Block[], depth: number) => {
    for (let i = list.length - 1; i >= 0; i--)
      pending.push({ block: list[i] as Block, depth });
  };
  push(blocks, 0);
  while (pending.length > 0) {
    const { block, depth } = pending.pop() as { block: Block; depth: number };
    if (block.type !== 'pageBreak') {
      out.push({ id: block.id, type: block.type, depth, text: textOf(block) });
    }
    const children = childLists(block);
    for (let i = children.length - 1; i >= 0; i--)
      push(children[i] as Block[], depth + 1);
  }
  return out;
}

/** The block of `blocks` with this ID, at any depth, as a choice; undefined when there is none. */
export function blockChoice(
  blocks: readonly Block[],
  id: string,
): BlockChoice | undefined {
  return blockChoices(blocks).find((c) => c.id === id);
}

function childLists(block: Block): readonly (readonly Block[])[] {
  switch (block.type) {
    case 'section':
    case 'safety':
    case 'admonition':
    case 'faq':
    case 'variant':
      return [block.blocks];
    case 'list':
      return block.items.map((i) => i.blocks);
    case 'procedure':
      return block.steps.map((i) => i.blocks);
    case 'table':
      return block.rows.flatMap((r) => r.cells.map((c) => c.blocks));
    default:
      return [];
  }
}

function textOf(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return cut(plain(block.content));
    case 'section':
      return cut(plain(block.title));
    case 'list':
      return cut(plain(block.items[0]?.content));
    case 'procedure':
      return cut(plain(block.title ?? block.steps[0]?.content));
    case 'table':
      return cut(plain(block.title));
    case 'image':
      return cut(block.alt);
    case 'attachment':
      return cut(block.name);
    case 'safety':
      return cut(plain(block.hazard));
    case 'faq':
      return cut(plain(block.question));
    case 'moduleRef':
      return block.module;
    case 'literal':
      return cut(block.text.split('\n')[0] ?? '');
    default:
      return '';
  }
}

function plain(content: readonly Inline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'attribute':
          return `{${node.name}}`;
        case 'xref':
          return node.text?.map((t) => t.text).join('') ?? node.module;
        case 'kbd':
          return node.keys.join('+');
        case 'hardBreak':
          return ' ';
        default:
          return '';
      }
    })
    .join('');
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > TEXT_MAX
    ? `${chars.slice(0, TEXT_MAX - 1).join('')}…`
    : flat;
}
