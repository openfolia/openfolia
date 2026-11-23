import type { Block, Callout, Item, Table, TableCell } from '../blocks.js';
import { roundCoordinate } from '../callouts.js';
import type { Inline } from '../inline.js';
import type { Module } from '../module.js';
import { formatCondition } from './condition-syntax.js';
import { printInline } from './inline.js';
import {
  type AttrList,
  escapeText,
  formatAttrList,
  quoteValue,
} from './syntax.js';

interface Context {
  /** Depth of the enclosing section (0 at module level). */
  sectionDepth: number;
  /** Depth of the enclosing list, counted through list items (0 outside lists). */
  listDepth: number;
  /** Number of enclosing `====` blocks; each level uses a longer delimiter. */
  delimDepth: number;
}

const TOP: Context = { sectionDepth: 0, listDepth: 0, delimDepth: 0 };

/**
 * Prints a module as canonical AsciiDoc. The output depends only on the
 * module's normalized content, so equal modules print byte for byte the
 * same. The module ID is the file name and is not printed.
 */
export function printModule(module: Module): string {
  const { meta } = module;
  const header = [
    `= ${escapeText(meta.title)}`,
    `:schema-version: ${module.schemaVersion}`,
  ];
  header.push(`:module-type: ${meta.type}`, `:lang: ${meta.lang}`);
  if (meta.audience) header.push(`:audience: ${meta.audience}`);
  for (const key of Object.keys(meta.facets).sort()) {
    header.push(`:facet-${key}: ${(meta.facets[key] ?? []).join(', ')}`);
  }
  if (meta.keywords?.length) {
    header.push(`:keywords: ${meta.keywords.join(', ')}`);
  }
  if (meta.source)
    header.push(
      `:source-system: ${meta.source.system}`,
      `:source-id: ${meta.source.id}`,
    );
  if (meta.deprecated) {
    header.push(`:deprecated: ${meta.deprecated.reason}`);
    if (meta.deprecated.replacedBy)
      header.push(`:replaced-by: ${meta.deprecated.replacedBy}`);
  }

  const body = printBlocks(module.blocks, TOP);
  return `${header.join('\n')}\n${body ? `\n${body}\n` : ''}`;
}

/**
 * Prints blocks without a module header, as canonical AsciiDoc: a page design's region text
 * (#390). `parseBlocksSource` reads it back.
 */
export function printBlocksSource(blocks: readonly Block[]): string {
  return printBlocks(blocks, TOP);
}

function printBlocks(blocks: readonly Block[], ctx: Context): string {
  return blocks.map((block) => printBlock(block, ctx)).join('\n\n');
}

const attrs = (list: Partial<AttrList>) =>
  formatAttrList({ positional: [], named: [], ...list });
/** Always quoted: a bare first value could read as a style. */
const quoted = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
const title = (content: Inline[] | undefined) =>
  content ? `\n.${printInline(content, true)}` : '';

function printBlock(block: Block, ctx: Context): string {
  switch (block.type) {
    case 'paragraph':
      return `${attrs({ id: block.id })}\n${printInline(block.content, true)}`;

    case 'section': {
      const heading = `${'='.repeat(ctx.sectionDepth + 2)} ${printInline(block.title, false)}`;
      const body = printBlocks(block.blocks, {
        ...ctx,
        sectionDepth: ctx.sectionDepth + 1,
      });
      return `${attrs({ id: block.id })}\n${heading}${body ? `\n\n${body}` : ''}`;
    }

    case 'list':
      return `${attrs({ id: block.id })}\n${printItems(block.items, block.ordered, ctx)}`;

    case 'procedure':
      return `${attrs({ style: 'procedure', id: block.id })}${title(block.title)}\n${printItems(block.steps, true, ctx)}`;

    case 'table':
      return printTable(block, ctx);

    case 'image': {
      const width = block.width === undefined ? '' : `,width=${block.width}%`;
      const order =
        block.calloutOrder === 'manual' ? ',callout-order=manual' : '';
      const legend =
        block.calloutLegend === undefined || block.calloutLegend === 'below'
          ? ''
          : `,callout-legend=${block.calloutLegend}`;
      const callouts = (block.callouts ?? []).map(
        (c) => `\n${printCallout(c)}`,
      );
      return `${attrs({ id: block.id })}${title(block.title)}\nimage::${block.asset}[${quoted(block.alt)}${width}${order}${legend}]${callouts.join('')}`;
    }

    case 'attachment': {
      const named: [string, string][] = [
        ['file', block.fileName],
        ['type', block.mediaType],
        ['size', String(block.size)],
      ];
      if (block.description !== undefined)
        named.push(['description', block.description]);
      return `${attrs({ id: block.id })}\nattachment::${block.asset}[${quoted(block.name)},${named.map(([k, v]) => `${k}=${quoteValue(v)}`).join(',')}]`;
    }

    case 'safety': {
      const named: [string, string][] = [['severity', block.severity]];
      if (block.symbols.length > 0)
        named.push(['symbols', block.symbols.join(',')]);
      return delimited(
        attrs({ style: 'safety', id: block.id, named }) + title(block.hazard),
        block.blocks,
        ctx,
      );
    }

    case 'faq':
      return delimited(
        attrs({ style: 'faq', id: block.id }) + title(block.question),
        block.blocks,
        ctx,
      );

    case 'admonition':
      return delimited(
        attrs({ style: block.kind.toUpperCase(), id: block.id }),
        block.blocks,
        ctx,
      );

    case 'variant':
      return delimited(
        attrs({
          style: 'variant',
          id: block.id,
          named: [['when', formatCondition(block.when)]],
        }),
        block.blocks,
        ctx,
      );

    case 'moduleRef':
      return `${attrs({ id: block.id })}\nmodule::${block.module}[${block.block === undefined ? '' : `block=${block.block}`}]`;

    case 'literal':
      return verbatim(
        attrs({
          style: 'source',
          id: block.id,
          positional: block.language ? [block.language] : [],
        }),
        '-',
        block.text,
      );

    case 'passthrough':
      return verbatim(
        attrs({
          style: 'passthrough',
          id: block.id,
          named: [['format', block.format]],
        }),
        '+',
        block.raw,
      );

    case 'pageBreak':
      return `${attrs({ id: block.id })}\n<<<`;

    default:
      return block satisfies never;
  }
}

/**
 * A callout as an item of AsciiDoc's callout list, right below the image:
 * `<.>` (the number is derived, so the file holds none), the callout's
 * attribute list, then its legend.
 */
function printCallout(callout: Callout): string {
  const named: [string, string][] = [
    ['x', formatCoordinate(callout.anchor.x)],
    ['y', formatCoordinate(callout.anchor.y)],
  ];
  if (callout.label) {
    named.push(
      ['label-x', formatCoordinate(callout.label.x)],
      ['label-y', formatCoordinate(callout.label.y)],
    );
  }
  if (callout.style !== undefined) named.push(['style', callout.style]);
  if (callout.when) named.push(['when', formatCondition(callout.when)]);
  return `<.> ${attrs({ style: 'callout', id: callout.id, named })} ${printInline(callout.legend, false)}`;
}

/** A coordinate as the file holds it: rounded, never in exponent form (it has at most 4 places). */
const formatCoordinate = (value: number) => String(roundCoordinate(value));

function delimited(
  head: string,
  blocks: readonly Block[],
  ctx: Context,
): string {
  const fence = '='.repeat(4 + ctx.delimDepth);
  const body = printBlocks(blocks, {
    sectionDepth: 0,
    listDepth: 0,
    delimDepth: ctx.delimDepth + 1,
  });
  return `${head}\n${fence}\n${body ? `${body}\n` : ''}${fence}`;
}

/** A block whose content is kept as-is; the fence grows longer than any fence-like line inside. */
function verbatim(head: string, fenceChar: '-' | '+', text: string): string {
  const fenceLike = new RegExp(`^\\${fenceChar}{4,}$`);
  const longest = Math.max(
    3,
    ...text
      .split('\n')
      .filter((l) => fenceLike.test(l))
      .map((l) => l.length),
  );
  const fence = fenceChar.repeat(longest + 1);
  return `${head}\n${fence}\n${text}\n${fence}`;
}

function printItems(
  items: readonly Item[],
  ordered: boolean,
  ctx: Context,
): string {
  const depth = ctx.listDepth + 1;
  const marker = (ordered ? '.' : '*').repeat(depth);
  const inner: Context = { ...ctx, listDepth: depth };

  return items
    .map((item) => {
      let out = `${marker} [[${item.id}]]${printInline(item.content, false)}`;
      let previous: Block | undefined;
      for (const block of item.blocks) {
        // After a nested list, blank lines end that many list levels before "+" attaches here.
        out += `\n${'\n'.repeat(previous ? trailingListDepth(previous) : 0)}+\n${printBlock(block, inner)}`;
        previous = block;
      }
      return out;
    })
    .join('\n');
}

/** How many list levels are still open at the end of a block. */
function trailingListDepth(block: Block): number {
  if (block.type !== 'list' && block.type !== 'procedure') return 0;
  const items = block.type === 'list' ? block.items : block.steps;
  const last = items.at(-1)?.blocks.at(-1);
  return 1 + (last ? trailingListDepth(last) : 0);
}

function printTable(table: Table, ctx: Context): string {
  const align = { left: '<', center: '^', right: '>' } as const;
  const cols = table.columns
    .map((c) => `${c.align ? align[c.align] : ''}${c.width}`)
    .join(',');
  const named: [string, string][] = [['cols', cols]];
  if (table.header) named.push(['options', 'header']);

  const cellCtx: Context = {
    sectionDepth: 0,
    listDepth: 0,
    delimDepth: ctx.delimDepth + 1,
  };
  const rows = table.rows.map((row) => {
    const simple = row.cells.every(isSimpleCell);
    const cells = row.cells.map((cell) => printCell(cell, cellCtx));
    return cells.join(simple ? ' ' : '\n');
  });

  return `${attrs({ id: table.id, named })}${title(table.title)}\n|===\n${rows.join('\n')}\n|===`;
}

/** A cell printed on its row's line: one paragraph, or nothing (an empty cell is a bare `|`). */
function isSimpleCell(cell: TableCell): boolean {
  return (
    cell.blocks.length === 0 ||
    (cell.blocks.length === 1 && cell.blocks[0]?.type === 'paragraph')
  );
}

function printCell(cell: TableCell, ctx: Context): string {
  const span =
    (cell.colspan ?? 1) > 1 || (cell.rowspan ?? 1) > 1
      ? `${(cell.colspan ?? 1) > 1 ? cell.colspan : ''}${(cell.rowspan ?? 1) > 1 ? `.${cell.rowspan}` : ''}+`
      : '';
  const [only] = cell.blocks;
  if (!only) return `${span}|`;
  if (isSimpleCell(cell) && only.type === 'paragraph') {
    return `${span}|[[${only.id}]]${printInline(only.content, false)}`;
  }
  return `${span}a|\n${printBlocks(cell.blocks, ctx)}`;
}
