import type { Block, Item } from './blocks.js';

/** Anything in the tree that carries an ID: a block, or a list item or procedure step. */
export type Node =
  { kind: 'block'; node: Block } | { kind: 'item'; node: Item };

/** Depth-first, document order. Does not follow `moduleRef`s into other modules. */
export function* walk(blocks: readonly Block[]): Generator<Node> {
  for (const block of blocks) {
    yield { kind: 'block', node: block };
    switch (block.type) {
      case 'section':
      case 'safety':
      case 'admonition':
      case 'faq':
      case 'variant':
        yield* walk(block.blocks);
        break;
      case 'list':
        yield* walkItems(block.items);
        break;
      case 'procedure':
        yield* walkItems(block.steps);
        break;
      case 'table':
        for (const row of block.rows) {
          for (const cell of row.cells) {
            yield* walk(cell.blocks);
          }
        }
        break;
      case 'paragraph':
      case 'image':
      case 'attachment':
      case 'moduleRef':
      case 'literal':
      case 'passthrough':
      case 'pageBreak':
        break;
      default:
        block satisfies never;
    }
  }
}

function* walkItems(items: readonly Item[]): Generator<Node> {
  for (const item of items) {
    yield { kind: 'item', node: item };
    yield* walk(item.blocks);
  }
}
