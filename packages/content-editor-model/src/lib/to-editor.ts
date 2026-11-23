import { CURRENT_SCHEMA_VERSION } from '@openfolia/content-model';
import type {
  Block,
  Callout,
  Inline,
  Item,
  Mark,
  Module,
  TableCell,
} from '@openfolia/content-model';
import { ConversionError } from './errors.js';
import type { EditorDoc, EditorMark, EditorNode } from './json.js';
import {
  MAX_EDITOR_DEPTH,
  NestingTooDeepError,
  assertTableFits,
  assertWithinLimits,
} from './limits.js';
import { MARK_NAMES } from './spec.js';

/**
 * A module as the editor's document. Every field of the module ends up in
 * the document, so `fromEditor(toEditor(m))` is `m` again. For a module in
 * normal form (`normalizeModule`) the result is also exactly what
 * ProseMirror's `Node.toJSON()` writes for it.
 *
 * Throws a `ConversionError` naming the block for a block or inline type the
 * converter doesn't know, and an `EditorLimitError` for a module over the
 * caps.
 */
export function toEditor(module: Module): EditorDoc {
  const doc: EditorDoc = {
    type: 'doc',
    attrs: {
      moduleId: module.id,
      schemaVersion: module.schemaVersion,
      meta: structuredClone(module.meta),
    },
    ...content(blocks(module.blocks, 1)),
  };
  assertWithinLimits(doc);
  return doc;
}

/**
 * A page design region's blocks (#393, `RegionBlocks`) as an editor document: a document of no
 * module (empty `moduleId`, no `meta`), so `regionFromEditor(regionToEditor(b))` is `b` again.
 * No blocks: an empty document.
 */
export function regionToEditor(list: readonly Block[]): EditorDoc {
  const doc: EditorDoc = {
    type: 'doc',
    attrs: {
      moduleId: '',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      meta: null,
    },
    ...content(blocks(list, 1)),
  };
  assertWithinLimits(doc);
  return doc;
}

function content(nodes: EditorNode[]): { content?: EditorNode[] } {
  return nodes.length > 0 ? { content: nodes } : {};
}

function blocks(list: readonly Block[], depth: number): EditorNode[] {
  if (depth > MAX_EDITOR_DEPTH) throw new NestingTooDeepError();
  return list.map((b) => block(b, depth));
}

function title(
  nodes: readonly Inline[] | undefined,
  blockId: string,
): EditorNode[] {
  return nodes ? [{ type: 'title', ...content(inline(nodes, blockId)) }] : [];
}

function block(b: Block, depth: number): EditorNode {
  const inner = depth + 1;
  switch (b.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        attrs: { id: b.id },
        ...content(inline(b.content, b.id)),
      };
    case 'section':
      return {
        type: 'section',
        attrs: { id: b.id },
        content: [
          { type: 'title', ...content(inline(b.title, b.id)) },
          ...blocks(b.blocks, inner),
        ],
      };
    case 'list':
      return {
        type: 'list',
        attrs: { id: b.id, ordered: b.ordered },
        content: items(b.items, inner),
      };
    case 'procedure':
      return {
        type: 'procedure',
        attrs: { id: b.id },
        content: [...title(b.title, b.id), ...items(b.steps, inner)],
      };
    case 'table':
      if (inner + 2 > MAX_EDITOR_DEPTH) throw new NestingTooDeepError();
      assertTableFits(b.id, b.columns.length, b.rows.length);
      return {
        type: 'table',
        attrs: {
          id: b.id,
          header: b.header,
          columns: structuredClone(b.columns),
        },
        content: [
          ...title(b.title, b.id),
          ...b.rows.map((row): EditorNode => ({
            type: 'tableRow',
            content: row.cells.map((c) => cell(c, inner + 2)),
          })),
        ],
      };
    case 'image':
      return {
        type: 'image',
        attrs: {
          id: b.id,
          asset: b.asset,
          alt: b.alt,
          width: b.width ?? null,
          calloutOrder: b.calloutOrder ?? null,
          calloutLegend: b.calloutLegend ?? null,
        },
        ...content([
          ...title(b.title, b.id),
          ...(b.callouts ?? []).map((c) => callout(c, b.id)),
        ]),
      };
    case 'safety':
      return {
        type: 'safety',
        attrs: { id: b.id, severity: b.severity, symbols: [...b.symbols] },
        content: [
          { type: 'hazard', ...content(inline(b.hazard, b.id)) },
          ...blocks(b.blocks, inner),
        ],
      };
    case 'faq':
      return {
        type: 'faq',
        attrs: { id: b.id },
        content: [
          { type: 'question', ...content(inline(b.question, b.id)) },
          ...blocks(b.blocks, inner),
        ],
      };
    case 'admonition':
      return {
        type: 'admonition',
        attrs: { id: b.id, kind: b.kind },
        ...content(blocks(b.blocks, inner)),
      };
    case 'variant':
      return {
        type: 'variant',
        attrs: { id: b.id, when: structuredClone(b.when) },
        ...content(blocks(b.blocks, inner)),
      };
    case 'attachment':
      return {
        type: 'attachment',
        attrs: {
          id: b.id,
          asset: b.asset,
          name: b.name,
          description: b.description ?? null,
          fileName: b.fileName,
          mediaType: b.mediaType,
          size: b.size,
        },
      };
    case 'moduleRef':
      return {
        type: 'moduleRef',
        attrs: { id: b.id, module: b.module, block: b.block ?? null },
      };
    case 'literal':
      return {
        type: 'literal',
        attrs: { id: b.id, language: b.language ?? null },
        ...content(b.text === '' ? [] : [{ type: 'text', text: b.text }]),
      };
    case 'passthrough':
      return {
        type: 'passthrough',
        attrs: { id: b.id, format: b.format, raw: b.raw },
      };
    case 'pageBreak':
      return { type: 'pageBreak', attrs: { id: b.id } };
    default: {
      b satisfies never;
      const unknown = b as { type?: unknown; id?: unknown };
      throw ConversionError.at(
        typeof unknown.id === 'string' ? unknown.id : null,
        `unknown block type "${String(unknown.type)}"`,
      );
    }
  }
}

function callout(c: Callout, imageId: string): EditorNode {
  return {
    type: 'callout',
    attrs: {
      id: c.id,
      anchor: structuredClone(c.anchor),
      label: c.label ? structuredClone(c.label) : null,
      when: c.when ? structuredClone(c.when) : null,
      style: c.style ?? null,
    },
    ...content(inline(c.legend, imageId)),
  };
}

function items(list: readonly Item[], depth: number): EditorNode[] {
  if (depth + 1 > MAX_EDITOR_DEPTH) throw new NestingTooDeepError();
  return list.map((item) => ({
    type: 'listItem',
    attrs: { id: item.id },
    content: [
      { type: 'itemText', ...content(inline(item.content, item.id)) },
      ...blocks(item.blocks, depth + 1),
    ],
  }));
}

function cell(c: TableCell, depth: number): EditorNode {
  return {
    type: 'tableCell',
    attrs: { colspan: c.colspan ?? null, rowspan: c.rowspan ?? null },
    ...content(blocks(c.blocks, depth)),
  };
}

function inline(nodes: readonly Inline[], blockId: string): EditorNode[] {
  return nodes.map((n): EditorNode => {
    switch (n.type) {
      case 'text':
        return {
          type: 'text',
          text: n.text,
          ...(n.marks ? { marks: n.marks.map((m) => mark(m, blockId)) } : {}),
        };
      case 'attribute':
        return { type: 'attribute', attrs: { name: n.name } };
      case 'xref':
        return {
          type: 'xref',
          attrs: {
            module: n.module,
            block: n.block ?? null,
            text: n.text ? structuredClone(n.text) : null,
          },
        };
      case 'kbd':
        return { type: 'kbd', attrs: { keys: [...n.keys] } };
      case 'calloutRef':
        return {
          type: 'calloutRef',
          attrs: { block: n.block, callout: n.callout },
        };
      case 'hardBreak':
        return { type: 'hardBreak' };
      case 'placeholder':
        return { type: 'placeholder', attrs: { key: n.key } };
      default: {
        n satisfies never;
        throw ConversionError.at(
          blockId,
          `unknown inline type "${String((n as { type?: unknown }).type)}"`,
        );
      }
    }
  });
}

function mark(m: Mark, blockId: string): EditorMark {
  if (m.type === 'link') return { type: 'link', attrs: { href: m.href } };
  if (m.type === 'term') return { type: 'term', attrs: { termId: m.termId } };
  if (!(MARK_NAMES as readonly string[]).includes(m.type))
    throw ConversionError.at(blockId, `unknown mark type "${String(m.type)}"`);
  return { type: m.type };
}
