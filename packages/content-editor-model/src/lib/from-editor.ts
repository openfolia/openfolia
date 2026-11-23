import {
  isLinkHref,
  isTermId,
  Module,
  RegionBlocks,
  type Block,
} from '@openfolia/content-model';
import { ConversionError, type ConversionProblem } from './errors.js';
import { isRecord } from './json.js';
import { assertTableFits, assertWithinLimits } from './limits.js';
import { BLOCK_NODES, MARK_NAMES } from './spec.js';

/**
 * The editor's document as a module: the exact inverse of `toEditor`. Strict:
 * it repairs nothing and drops nothing. Anything the model can't hold (an
 * unknown node or mark, a node in the wrong place, formatting on something
 * other than text, an empty paragraph, a field the model refuses) is a
 * `ConversionError` naming the block it is in. Run `normalizeEditorDoc`
 * first on what an editor hands over, so only real problems are left.
 *
 * Throws an `EditorLimitError` for a document over the caps, before reading it.
 */
export function fromEditor(doc: unknown): Module {
  assertWithinLimits(doc);
  if (!isRecord(doc) || doc['type'] !== 'doc')
    throw ConversionError.at(null, 'not an editor document');
  const attrs = isRecord(doc['attrs']) ? doc['attrs'] : {};
  const candidate = {
    schemaVersion: attrs['schemaVersion'],
    id: attrs['moduleId'],
    meta: attrs['meta'],
    blocks: readBlocks(children(doc, null, 'the document'), null),
  };
  const result = Module.safeParse(candidate);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) =>
    problemAt(candidate, issue.path, issue.message),
  );
  throw new ConversionError(
    problems as [ConversionProblem, ...ConversionProblem[]],
  );
}

/**
 * A page design region's editor document (#393) as its blocks, the inverse of `regionToEditor`,
 * as strict as `fromEditor` and checked as `RegionBlocks` (headings one level deep; no page
 * breaks, module references or cross-references; unique IDs; at most `MAX_REGION_BLOCKS`).
 * A document with nothing in it but empty paragraphs is no text: `[]`.
 */
export function regionFromEditor(doc: unknown): Block[] {
  assertWithinLimits(doc);
  if (!isRecord(doc) || doc['type'] !== 'doc')
    throw ConversionError.at(null, 'not an editor document');
  const nodes = children(doc, null, 'the document');
  const blank = nodes.every(
    (n) =>
      isRecord(n) &&
      n['type'] === 'paragraph' &&
      children(n, null, 'a paragraph').length === 0,
  );
  if (blank) return [];
  const candidate = { blocks: readBlocks(nodes, null) };
  const result = RegionBlocks.safeParse(candidate.blocks);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) =>
    problemAt(candidate, ['blocks', ...issue.path], issue.message),
  );
  throw new ConversionError(
    problems as [ConversionProblem, ...ConversionProblem[]],
  );
}

type Raw = Record<string, unknown>;

function children(node: Raw, blockId: string | null, what: string): unknown[] {
  const content = node['content'];
  if (content === undefined) return [];
  if (!Array.isArray(content))
    throw ConversionError.at(blockId, `${what}: content is not a list`);
  return content;
}

function attr(node: Raw, name: string): unknown {
  const attrs = node['attrs'];
  return isRecord(attrs) ? attrs[name] : undefined;
}

/** An optional field: the model leaves it out where the editor has `null`. */
function optional(key: string, value: unknown): Raw {
  return value === null || value === undefined ? {} : { [key]: value };
}

function asNode(
  raw: unknown,
  blockId: string | null,
  where: string,
): Raw & { type: string } {
  if (!isRecord(raw) || typeof raw['type'] !== 'string')
    throw ConversionError.at(blockId, `${where}: not a node`);
  return raw as Raw & { type: string };
}

function idOf(node: Raw, parentId: string | null, index: number): string {
  const id = attr(node, 'id');
  if (typeof id === 'string') return id;
  throw ConversionError.at(
    parentId,
    `the ${String(node['type'])} at position ${index + 1} has no ID`,
  );
}

function hasEntries(value: unknown): boolean {
  return value !== undefined && !(Array.isArray(value) && value.length === 0);
}

/** Only text carries formatting. */
function noMarks(node: Raw, blockId: string | null): void {
  if (hasEntries(node['marks']))
    throw ConversionError.at(
      blockId,
      `formatting on a "${String(node['type'])}" node: only text carries formatting`,
    );
}

function readBlocks(list: unknown[], parentId: string | null): unknown[] {
  return list.map((raw, index) => readBlock(raw, parentId, index));
}

function readBlock(
  raw: unknown,
  parentId: string | null,
  index: number,
): unknown {
  const node = asNode(raw, parentId, `block ${index + 1}`);
  const type = node.type;
  if (!BLOCK_TYPES.has(type))
    throw ConversionError.at(
      parentId,
      `a "${type}" node can't stand here (position ${index + 1})`,
    );
  const id = idOf(node, parentId, index);
  noMarks(node, id);
  const list = children(node, id, type);
  switch (type) {
    case 'paragraph':
      return { type, id, content: readInline(list, id) };
    case 'section': {
      const [first, ...rest] = list;
      return {
        type,
        id,
        title: titleOf(first, id, 'title', 'a section starts with its title'),
        blocks: readBlocks(rest, id),
      };
    }
    case 'list':
      return {
        type,
        id,
        ordered: attr(node, 'ordered'),
        items: list.map((item, i) => readItem(item, id, i)),
      };
    case 'procedure': {
      const [title, rest] = splitTitle(list, id);
      return {
        type,
        id,
        ...optional('title', title),
        steps: rest.map((item, i) => readItem(item, id, i)),
      };
    }
    case 'table': {
      const [title, rows] = splitTitle(list, id);
      const columns = attr(node, 'columns');
      // Past the caps (#686): refused before a row of it is read.
      assertTableFits(
        id,
        Array.isArray(columns) ? columns.length : 0,
        rows.length,
      );
      return {
        type,
        id,
        ...optional('title', title),
        columns,
        header: attr(node, 'header'),
        rows: rows.map((row, r) => readRow(row, id, r)),
      };
    }
    case 'image': {
      const [title, rest] = splitTitle(list, id);
      const callouts = rest.map((raw, i) => readCallout(raw, id, i));
      return {
        type,
        id,
        asset: attr(node, 'asset'),
        alt: attr(node, 'alt'),
        ...optional('title', title),
        ...optional('width', attr(node, 'width')),
        ...(callouts.length > 0 ? { callouts } : {}),
        ...optional('calloutOrder', attr(node, 'calloutOrder')),
        ...optional('calloutLegend', attr(node, 'calloutLegend')),
      };
    }
    case 'safety': {
      const [first, ...rest] = list;
      return {
        type,
        id,
        severity: attr(node, 'severity'),
        hazard: titleOf(
          first,
          id,
          'hazard',
          'a safety message starts with its hazard',
        ),
        symbols: attr(node, 'symbols'),
        blocks: readBlocks(rest, id),
      };
    }
    case 'faq': {
      const [first, ...rest] = list;
      return {
        type,
        id,
        question: titleOf(
          first,
          id,
          'question',
          'an FAQ entry starts with its question',
        ),
        blocks: readBlocks(rest, id),
      };
    }
    case 'admonition':
      return {
        type,
        id,
        kind: attr(node, 'kind'),
        blocks: readBlocks(list, id),
      };
    case 'variant':
      return {
        type,
        id,
        when: attr(node, 'when'),
        blocks: readBlocks(list, id),
      };
    case 'attachment':
      noContent(list, id, type);
      return {
        type,
        id,
        asset: attr(node, 'asset'),
        name: attr(node, 'name'),
        ...optional('description', attr(node, 'description')),
        fileName: attr(node, 'fileName'),
        mediaType: attr(node, 'mediaType'),
        size: attr(node, 'size'),
      };
    case 'moduleRef':
      noContent(list, id, type);
      return {
        type,
        id,
        module: attr(node, 'module'),
        ...optional('block', attr(node, 'block')),
      };
    case 'literal':
      return {
        type,
        id,
        text: literalText(list, id),
        ...optional('language', attr(node, 'language')),
      };
    case 'passthrough':
      noContent(list, id, type);
      return { type, id, format: attr(node, 'format'), raw: attr(node, 'raw') };
    case 'pageBreak':
      noContent(list, id, type);
      return { type, id };
    default:
      throw ConversionError.at(id, `unknown block type "${type}"`);
  }
}

const BLOCK_TYPES: ReadonlySet<string> = new Set(Object.values(BLOCK_NODES));

function noContent(list: unknown[], id: string, type: string): void {
  if (list.length > 0) throw ConversionError.at(id, `a ${type} has no content`);
}

/** The inline content of a `title`, `hazard` or `question` node that must come first. */
function titleOf(
  raw: unknown,
  blockId: string,
  type: string,
  missing: string,
): unknown[] {
  if (raw === undefined) throw ConversionError.at(blockId, missing);
  const node = asNode(raw, blockId, type);
  if (node.type !== type) throw ConversionError.at(blockId, missing);
  noMarks(node, blockId);
  return readInline(children(node, blockId, type), blockId);
}

/** An optional leading `title`, and the rest. */
function splitTitle(
  list: unknown[],
  blockId: string,
): [unknown[] | null, unknown[]] {
  const [first, ...rest] = list;
  if (isRecord(first) && first['type'] === 'title') {
    noMarks(first, blockId);
    return [readInline(children(first, blockId, 'title'), blockId), rest];
  }
  return [null, list];
}

/** A callout of an image; a problem in it names the image, the block it belongs to. */
function readCallout(raw: unknown, imageId: string, index: number): unknown {
  const node = asNode(raw, imageId, `callout ${index + 1}`);
  if (node.type !== 'callout')
    throw ConversionError.at(
      imageId,
      `an image holds its title and its callouts, not a "${node.type}" node (position ${index + 1})`,
    );
  noMarks(node, imageId);
  return {
    id: idOf(node, imageId, index),
    anchor: attr(node, 'anchor'),
    ...optional('label', attr(node, 'label')),
    legend: readInline(children(node, imageId, 'callout'), imageId),
    ...optional('when', attr(node, 'when')),
    ...optional('style', attr(node, 'style')),
  };
}

function readItem(raw: unknown, parentId: string, index: number): unknown {
  const node = asNode(raw, parentId, `item ${index + 1}`);
  if (node.type !== 'listItem')
    throw ConversionError.at(
      parentId,
      `a "${node.type}" node can't stand where a list item belongs (position ${index + 1})`,
    );
  const id = idOf(node, parentId, index);
  noMarks(node, id);
  const [first, ...rest] = children(node, id, 'listItem');
  return {
    id,
    content: titleOf(first, id, 'itemText', 'a list item starts with its text'),
    blocks: readBlocks(rest, id),
  };
}

function readRow(raw: unknown, tableId: string, r: number): unknown {
  const row = asNode(raw, tableId, `row ${r + 1}`);
  noMarks(row, tableId);
  if (row.type !== 'tableRow')
    throw ConversionError.at(tableId, `row ${r + 1} is a "${row.type}" node`);
  return {
    cells: children(row, tableId, 'tableRow').map((rawCell, c) => {
      const cell = asNode(rawCell, tableId, `row ${r + 1}, cell ${c + 1}`);
      noMarks(cell, tableId);
      if (cell.type !== 'tableCell')
        throw ConversionError.at(
          tableId,
          `row ${r + 1}, cell ${c + 1} is a "${cell.type}" node`,
        );
      return {
        ...optional('colspan', attr(cell, 'colspan')),
        ...optional('rowspan', attr(cell, 'rowspan')),
        blocks: cellBlocks(children(cell, tableId, 'tableCell'), tableId),
      };
    }),
  };
}

/**
 * A cell's blocks: none for a cell holding only an empty paragraph (an empty cell, which the
 * editor shows with a paragraph to type in), else its blocks as they are.
 */
function cellBlocks(list: unknown[], tableId: string): unknown[] {
  if (list.length === 1) {
    const only = asNode(list[0], tableId, 'cell block');
    if (
      only.type === 'paragraph' &&
      children(only, tableId, 'paragraph').length === 0
    )
      return [];
  }
  return readBlocks(list, tableId);
}

function literalText(list: unknown[], id: string): string {
  let text = '';
  for (const raw of list) {
    const node = asNode(raw, id, 'literal text');
    if (node.type !== 'text' || typeof node['text'] !== 'string')
      throw ConversionError.at(
        id,
        `a literal holds only text, not "${node.type}"`,
      );
    if (Array.isArray(node['marks']) && node['marks'].length > 0)
      throw ConversionError.at(id, 'a literal has no formatting');
    text += node['text'];
  }
  return text;
}

function readInline(list: unknown[], blockId: string): unknown[] {
  return list.map((raw, index) => {
    const node = asNode(raw, blockId, `inline node ${index + 1}`);
    if (hasEntries(node['content']))
      throw ConversionError.at(
        blockId,
        `a "${node.type}" node in a line of text holds no content`,
      );
    const marks = node['marks'];
    if (
      node.type !== 'text' &&
      marks !== undefined &&
      !(Array.isArray(marks) && marks.length === 0)
    )
      throw ConversionError.at(
        blockId,
        `formatting on a "${node.type}" node: only text carries formatting`,
      );
    switch (node.type) {
      case 'text':
        return {
          type: 'text',
          text: node['text'],
          ...(marks === undefined ? {} : { marks: readMarks(marks, blockId) }),
        };
      case 'attribute':
        return { type: 'attribute', name: attr(node, 'name') };
      case 'xref':
        return {
          type: 'xref',
          module: attr(node, 'module'),
          ...optional('block', attr(node, 'block')),
          ...optional('text', attr(node, 'text')),
        };
      case 'kbd':
        return { type: 'kbd', keys: attr(node, 'keys') };
      case 'calloutRef':
        return {
          type: 'calloutRef',
          block: attr(node, 'block'),
          callout: attr(node, 'callout'),
        };
      case 'hardBreak':
        return { type: 'hardBreak' };
      case 'placeholder':
        return { type: 'placeholder', key: attr(node, 'key') };
      default:
        throw ConversionError.at(
          blockId,
          `a "${node.type}" node can't stand in a line of text`,
        );
    }
  });
}

function readMarks(raw: unknown, blockId: string): unknown[] {
  if (!Array.isArray(raw))
    throw ConversionError.at(blockId, 'marks are not a list');
  return raw.map((m) => {
    const type = isRecord(m) ? m['type'] : undefined;
    if (
      typeof type !== 'string' ||
      !(MARK_NAMES as readonly string[]).includes(type)
    )
      throw ConversionError.at(blockId, `unknown mark "${String(type)}"`);
    if (type === 'term') {
      const termId = attr(m as Raw, 'termId');
      if (!isTermId(termId))
        throw ConversionError.at(blockId, 'a term link names no term ID');
      return { type, termId };
    }
    if (type !== 'link') return { type };
    const href = attr(m as Raw, 'href');
    // Checked here too, not only by the model's schema: no other address is ever stored.
    if (!isLinkHref(href))
      throw ConversionError.at(
        blockId,
        'a link takes only an absolute http, https or mailto address',
      );
    return { type, href };
  });
}

/**
 * The block a schema issue is in: the innermost object with an `id` along
 * the issue's path. The module's own checks (duplicate IDs, structure) report
 * at `blocks` and name the block in quotes in their message.
 */
function problemAt(
  candidate: { blocks: unknown[] },
  path: readonly PropertyKey[],
  message: string,
): ConversionProblem {
  if (path[0] !== 'blocks') {
    return {
      blockId: null,
      message: path.length > 0 ? `${path.join('.')}: ${message}` : message,
    };
  }
  let current: unknown = candidate.blocks;
  let blockId: string | null = null;
  let rest: PropertyKey[] = [];
  // Only an element of a list of blocks, items or steps is a block: an `id` in an attribute value isn't.
  let list: PropertyKey = 'blocks';
  for (const key of path.slice(1)) {
    const holdsBlocks =
      Array.isArray(current) &&
      typeof key === 'number' &&
      (list === 'blocks' || list === 'items' || list === 'steps');
    current =
      isRecord(current) || Array.isArray(current)
        ? (current as Record<PropertyKey, unknown>)[key as never]
        : undefined;
    rest.push(key);
    if (typeof key === 'string') list = key;
    if (holdsBlocks && isRecord(current) && typeof current['id'] === 'string') {
      blockId = current['id'];
      rest = [];
    }
  }
  if (path.length === 1) {
    blockId = /"([^"]+)"/.exec(message)?.[1] ?? null;
  }
  return {
    blockId,
    message:
      rest.length > 0 ? `${rest.map(String).join('.')}: ${message}` : message,
  };
}
