import type { Schema } from '../api';
import {
  conditionText,
  inlineDetails,
  inlineText,
  type InlineDetail,
} from './review-diff';
import { diffTree, type DiffNode, type TreeAdapter } from './tree-diff';

export type Block = Schema<'Block'>;
type Item = Extract<Block, { type: 'list' }>['items'][number];

/**
 * A node of a module's tree as the diff sees it: a block, or a list item or procedure step (they
 * carry IDs of their own, so they are compared on their own too).
 */
export type BlockNode =
  | { readonly kind: 'block'; readonly block: Block }
  | {
      readonly kind: 'item';
      readonly item: Item;
      /** A step of a procedure (else an item of a list). */
      readonly step: boolean;
      readonly ordered: boolean;
      /** Its position, from 1. */
      readonly ordinal: number;
    };

export type BlockDiff = DiffNode<BlockNode>;

const blockNode = (block: Block): BlockNode => ({ kind: 'block', block });

/** What a block holds, as nodes: its blocks, a list's items, a procedure's steps, a table's cells. */
function children(node: BlockNode): readonly BlockNode[] {
  if (node.kind === 'item') return node.item.blocks.map(blockNode);
  const b = node.block;
  switch (b.type) {
    case 'list':
      return b.items.map((item, i) => ({
        kind: 'item',
        item,
        step: false,
        ordered: b.ordered,
        ordinal: i + 1,
      }));
    case 'procedure':
      return b.steps.map((item, i) => ({
        kind: 'item',
        item,
        step: true,
        ordered: true,
        ordinal: i + 1,
      }));
    case 'table':
      return b.rows.flatMap((row) =>
        row.cells.flatMap((cell) => cell.blocks.map(blockNode)),
      );
    default: {
      // Containers, including kinds this screen does not know yet: what they hold.
      const held = (b as { blocks?: unknown }).blocks;
      return Array.isArray(held) ? (held as Block[]).map(blockNode) : [];
    }
  }
}

/** A block's own content: everything but what it holds (a table keeps its layout, by IDs). */
function own(node: BlockNode): string {
  if (node.kind === 'item') return JSON.stringify(node.item.content);
  const b = node.block as Block & Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(b)) {
    if (key === 'blocks' || key === 'items' || key === 'steps') continue;
    rest[key] = value;
  }
  if (b.type === 'table') {
    rest['rows'] = b.rows.map((row) =>
      row.cells.map((cell) => ({
        colspan: cell.colspan ?? 1,
        rowspan: cell.rowspan ?? 1,
        ids: cell.blocks.map((x) => x.id),
      })),
    );
  }
  if (b.type === 'list') rest['items'] = b.items.length;
  return JSON.stringify(rest);
}

function texts(node: BlockNode): Record<string, string> {
  if (node.kind === 'item') return { text: inlineText(node.item.content) };
  const b = node.block;
  switch (b.type) {
    case 'paragraph':
      return { text: inlineText(b.content) };
    case 'section':
      return { text: inlineText(b.title) };
    case 'procedure':
    case 'table':
      return { text: inlineText(b.title) };
    case 'image':
      return { text: b.alt, caption: inlineText(b.title) };
    case 'attachment':
      // Its facts as text, so a new name, file, type or size shows word by word.
      return {
        text: [
          b.name,
          b.fileName,
          b.mediaType,
          `${b.size} B`,
          ...(b.description ? [b.description] : []),
        ].join(' · '),
      };
    case 'safety':
      return { text: inlineText(b.hazard) };
    case 'faq':
      return { text: inlineText(b.question) };
    case 'literal':
      return { text: b.text };
    case 'passthrough':
      return { text: b.raw };
    case 'moduleRef':
      // One block of it (#223) as `module#block`, so naming another block shows as a change.
      return { text: b.block ? `${b.module}#${b.block}` : b.module };
    case 'variant':
      return { text: conditionText(b.when) };
    default:
      return {};
  }
}

export const BLOCK_ADAPTER: TreeAdapter<BlockNode> = {
  id: (n) => (n.kind === 'item' ? n.item.id : n.block.id),
  children,
  same: (a, b) => a.kind === b.kind && own(a) === own(b),
  texts,
};

/** A module's blocks compared (either side may be empty: a module added or removed). */
export function diffBlocks(
  before: readonly Block[],
  after: readonly Block[],
): BlockDiff[] {
  return diffTree(before.map(blockNode), after.map(blockNode), BLOCK_ADAPTER);
}

/** The block or item a node shows on a side (the new one when it has both). */
export const shownNode = (n: BlockDiff): BlockNode =>
  (n.after ?? n.before) as BlockNode;

/**
 * The title of the section a node stands in on a side, found by its parent's ID: what a move
 * names ("moved from Charging"). Null at the top level, outside any section.
 */
export function sectionTitle(
  blocks: readonly Block[],
  parentId: string | null,
): string | null {
  if (parentId === null) return null;
  // Every node's parent, then up to the nearest section.
  const parents = new Map<string, BlockNode | null>();
  const nodes = new Map<string, BlockNode>();
  const walk = (list: readonly BlockNode[], parent: BlockNode | null) => {
    for (const n of list) {
      const id = BLOCK_ADAPTER.id(n);
      nodes.set(id, n);
      parents.set(id, parent);
      walk(children(n), n);
    }
  };
  walk(blocks.map(blockNode), null);
  let at: BlockNode | null | undefined = nodes.get(parentId);
  while (at) {
    if (at.kind === 'block' && at.block.type === 'section')
      return inlineText(at.block.title);
    at = parents.get(BLOCK_ADAPTER.id(at));
  }
  return null;
}

/** The inline details of a node's own text (marks, links, cross-references, attributes, keys). */
export function inlineDetailsOf(node: BlockNode | undefined): InlineDetail[] {
  if (!node) return [];
  if (node.kind === 'item') return inlineDetails(node.item.content);
  const b = node.block;
  switch (b.type) {
    case 'paragraph':
      return inlineDetails(b.content);
    case 'section':
    case 'procedure':
    case 'table':
    case 'image':
      return inlineDetails(b.title);
    case 'safety':
      return inlineDetails(b.hazard);
    case 'faq':
      return inlineDetails(b.question);
    default:
      return [];
  }
}
