import type {
  Block,
  Callout,
  CalloutPoint,
  Image,
  Item,
  TableCell,
} from './blocks.js';
import { roundCoordinate } from './callouts.js';
import type { Inline, Mark, TextNode } from './inline.js';
import { MARK_ORDER } from './mark-order.js';
import type { Module } from './module.js';

/**
 * Brings a module into canonical form without changing its meaning:
 * marks in canonical order, adjacent text runs with the same marks merged,
 * empty mark lists removed, spans of 1 dropped, an empty keyword list
 * removed, and on an image no `calloutOrder` when it is the default
 * (`reading`) and callout coordinates rounded to `COORDINATE_DECIMALS`
 * places. Printing a module and
 * parsing it back yields its normalized form.
 */
export function normalizeModule(module: Module): Module {
  const { keywords, ...meta } = module.meta;
  return {
    ...module,
    // No keywords and an empty list are the same; the file holds neither.
    meta: keywords?.length ? { ...meta, keywords } : meta,
    blocks: module.blocks.map(normalizeBlock),
  };
}

export function normalizeInline<T extends Inline>(nodes: readonly T[]): T[] {
  const out: T[] = [];
  for (const node of nodes) {
    const current = node.type === 'text' ? (normalizeText(node) as T) : node;
    const previous = out.at(-1);
    if (
      previous?.type === 'text' &&
      current.type === 'text' &&
      sameMarks(previous.marks, current.marks)
    ) {
      out[out.length - 1] = { ...previous, text: previous.text + current.text };
    } else {
      out.push(current);
    }
  }
  return out;
}

export function sortMarks(marks: readonly Mark[]): Mark[] {
  return [...marks].sort(
    (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
  );
}

export function sameMark(a: Mark, b: Mark): boolean {
  return (
    a.type === b.type &&
    (a.type !== 'link' || (b.type === 'link' && a.href === b.href)) &&
    (a.type !== 'term' || (b.type === 'term' && a.termId === b.termId))
  );
}

function sameMarks(a: readonly Mark[] = [], b: readonly Mark[] = []): boolean {
  return (
    a.length === b.length &&
    a.every((mark, i) => {
      const other = b[i];
      return other !== undefined && sameMark(mark, other);
    })
  );
}

function normalizeText(node: TextNode): TextNode {
  const { marks, ...rest } = node;
  return marks && marks.length > 0
    ? { ...rest, marks: sortMarks(marks) }
    : rest;
}

function normalizeItem(item: Item): Item {
  return {
    ...item,
    content: normalizeXrefs(item.content),
    blocks: item.blocks.map(normalizeBlock),
  };
}

function normalizeCell(cell: TableCell): TableCell {
  const { colspan, rowspan, blocks } = cell;
  return {
    ...(colspan !== undefined && colspan > 1 ? { colspan } : {}),
    ...(rowspan !== undefined && rowspan > 1 ? { rowspan } : {}),
    blocks: blocks.map(normalizeBlock),
  };
}

function normalizeXrefs(nodes: Inline[]): Inline[] {
  return normalizeInline(nodes).map((node) =>
    node.type === 'xref' && node.text
      ? { ...node, text: normalizeInline(node.text) }
      : node,
  );
}

function normalizeImage(image: Image): Image {
  const { title, callouts, calloutOrder, calloutLegend, ...rest } = image;
  return {
    ...rest,
    ...(title ? { title: normalizeXrefs(title) } : {}),
    ...(callouts ? { callouts: callouts.map(normalizeCallout) } : {}),
    ...(calloutOrder === 'manual' ? { calloutOrder } : {}),
    ...(calloutLegend !== undefined && calloutLegend !== 'below'
      ? { calloutLegend }
      : {}),
  };
}

function normalizeCallout(callout: Callout): Callout {
  const { label, ...rest } = callout;
  return {
    ...rest,
    anchor: roundPoint(callout.anchor),
    ...(label ? { label: roundPoint(label) } : {}),
    legend: normalizeXrefs(callout.legend),
  };
}

const roundPoint = (p: CalloutPoint): CalloutPoint => ({
  x: roundCoordinate(p.x),
  y: roundCoordinate(p.y),
});

export function normalizeBlock(block: Block): Block {
  switch (block.type) {
    case 'paragraph':
      return { ...block, content: normalizeXrefs(block.content) };
    case 'section':
      return {
        ...block,
        title: normalizeXrefs(block.title),
        blocks: block.blocks.map(normalizeBlock),
      };
    case 'list':
      return { ...block, items: block.items.map(normalizeItem) };
    case 'procedure':
      return {
        ...block,
        ...(block.title ? { title: normalizeXrefs(block.title) } : {}),
        steps: block.steps.map(normalizeItem),
      };
    case 'table':
      return {
        ...block,
        ...(block.title ? { title: normalizeXrefs(block.title) } : {}),
        rows: block.rows.map((row) => ({
          cells: row.cells.map(normalizeCell),
        })),
      };
    case 'image':
      return normalizeImage(block);
    case 'safety':
      return {
        ...block,
        hazard: normalizeXrefs(block.hazard),
        blocks: block.blocks.map(normalizeBlock),
      };
    case 'faq':
      return {
        ...block,
        question: normalizeXrefs(block.question),
        blocks: block.blocks.map(normalizeBlock),
      };
    case 'admonition':
    case 'variant':
      return { ...block, blocks: block.blocks.map(normalizeBlock) };
    case 'attachment':
    case 'moduleRef':
    case 'literal':
    case 'passthrough':
    case 'pageBreak':
      return block;
    default:
      return block satisfies never;
  }
}
