import type { Block, Variant } from './blocks.js';

/**
 * Where a block sits in its module (#223): the block, and the variant blocks around it,
 * outermost first, whose conditions decide whether it is shown.
 */
export interface BlockPlace {
  readonly block: Block;
  readonly within: readonly Variant[];
}

/**
 * Every block of `blocks` by its ID, at any depth (sections, lists, steps, tables, notices,
 * variant blocks), with the variant blocks around it: what a module reference to one block of a
 * module (`moduleRef` with `block`) looks its block up in. List items, procedure steps and
 * table cells are not blocks, so a reference never names one. A repeated ID (an invalid module)
 * keeps its first block in document order. One walk, without recursion, so a deeply nested module
 * cannot overflow the stack.
 */
export function blockPlaces(
  blocks: readonly Block[],
): ReadonlyMap<string, BlockPlace> {
  const places = new Map<string, BlockPlace>();
  // Walked in document order: each list is pushed in reverse.
  const pending: { block: Block; within: readonly Variant[] }[] = [];
  const push = (list: readonly Block[], within: readonly Variant[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      pending.push({ block: list[i] as Block, within });
    }
  };
  push(blocks, []);
  while (pending.length > 0) {
    const { block, within } = pending.pop() as {
      block: Block;
      within: readonly Variant[];
    };
    if (!places.has(block.id)) places.set(block.id, { block, within });
    const inner = block.type === 'variant' ? [...within, block] : within;
    const children = childBlockLists(block);
    for (let i = children.length - 1; i >= 0; i--) {
      push(children[i] as Block[], inner);
    }
  }
  return places;
}

/** The lists of blocks directly inside a block, in document order. */
export function childBlockLists(block: Block): Block[][] {
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
    case 'paragraph':
    case 'image':
    case 'attachment':
    case 'moduleRef':
    case 'literal':
    case 'passthrough':
    case 'pageBreak':
      return [];
    default:
      return block satisfies never;
  }
}
