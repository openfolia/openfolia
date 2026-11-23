import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  tableTooLarge,
} from '@openfolia/content-model';
import { isRecord } from './json.js';

/** Nodes in an editor document, the document and text nodes included. */
export const MAX_EDITOR_NODES = 20_000;
/** How deep nodes may nest, counted from the document (a paragraph at the top is depth 1). */
export const MAX_EDITOR_DEPTH = 64;
/** The document's JSON text may be this long, in UTF-16 code units (about `JSON.stringify(doc).length`). */
export const MAX_EDITOR_CHARS = 2_000_000;

export type EditorLimit = 'nodes' | 'depth' | 'size' | 'table';

/** A document over one of the hard caps. Nothing was converted. */
export abstract class EditorLimitError extends Error {
  abstract readonly limit: EditorLimit;
  constructor(
    message: string,
    readonly max: number,
  ) {
    super(message);
  }
}

export class TooManyNodesError extends EditorLimitError {
  override readonly name = 'TooManyNodesError';
  readonly limit = 'nodes';
  constructor() {
    super(
      `the document has more than ${MAX_EDITOR_NODES} nodes`,
      MAX_EDITOR_NODES,
    );
  }
}

export class NestingTooDeepError extends EditorLimitError {
  override readonly name = 'NestingTooDeepError';
  readonly limit = 'depth';
  constructor() {
    super(
      `the document nests deeper than ${MAX_EDITOR_DEPTH} levels`,
      MAX_EDITOR_DEPTH,
    );
  }
}

export class DocumentTooLargeError extends EditorLimitError {
  override readonly name = 'DocumentTooLargeError';
  readonly limit = 'size';
  constructor() {
    super(
      `the document is larger than ${MAX_EDITOR_CHARS} characters of JSON`,
      MAX_EDITOR_CHARS,
    );
  }
}

/**
 * A table past the content model's caps (#686): more than `MAX_TABLE_COLUMNS` columns, or more
 * than `MAX_TABLE_CELLS` places (rows × columns). Nothing was converted, and no row of it read.
 */
export class TableTooLargeEditorError extends EditorLimitError {
  override readonly name = 'TableTooLargeEditorError';
  readonly limit = 'table';
  constructor(
    /** The table's block ID. */
    readonly tableId: string,
    message: string,
    /** The cap it passes: `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS`. */
    max: number,
  ) {
    super(`table "${tableId}": ${message}`, max);
  }
}

/** Throws `TableTooLargeEditorError` for a table of these columns and rows past the caps. */
export function assertTableFits(
  tableId: string,
  columns: number,
  rows: number,
): void {
  const problem = tableTooLarge(columns, rows);
  if (problem) {
    const max =
      columns > MAX_TABLE_COLUMNS ? MAX_TABLE_COLUMNS : MAX_TABLE_CELLS;
    throw new TableTooLargeEditorError(tableId, problem, max);
  }
}

/**
 * The cap `value` breaks, or `null` when it is within all of them. One walk
 * over everything, with a budget: it stops as soon as the nodes (along
 * `content`), their depth, the depth of an attribute value (a condition
 * tree, the metadata: at most `MAX_EDITOR_DEPTH` levels too) or the JSON text
 * length so far goes over its cap. So a cycle, a shared object met again and
 * again, or a hostile depth costs at most the caps. The length is counted as
 * `JSON.stringify` writes the value. Throws only when reading `value` itself
 * throws (a getter, a proxy).
 */
export function exceededLimit(value: unknown): EditorLimitError | null {
  let nodes = 0;
  let chars = 0;
  /** Thrown inside the walk to stop it; never escapes. */
  class Over {
    constructor(readonly error: EditorLimitError) {}
  }
  const spend = (n: number) => {
    chars += n;
    if (chars > MAX_EDITOR_CHARS) throw new Over(new DocumentTooLargeError());
  };
  /** Any JSON value; `depth` counts nesting inside an attribute value. */
  const json = (v: unknown, depth: number): void => {
    if (depth > MAX_EDITOR_DEPTH) throw new Over(new NestingTooDeepError());
    if (typeof v === 'string') return spend(JSON.stringify(v).length);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null)
      return spend(String(JSON.stringify(v)).length);
    if (typeof v !== 'object') return spend(4); // dropped or `null` in JSON
    spend(2);
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (i > 0) spend(1); // the comma
        json(item, depth + 1);
      });
      return;
    }
    let first = true;
    for (const [key, item] of Object.entries(v)) {
      if (item === undefined || typeof item === 'function') continue;
      spend(JSON.stringify(key).length + (first ? 1 : 2)); // key, colon, comma
      first = false;
      json(item, depth + 1);
    }
  };
  /** A node: its `content` holds nodes, every other field is a JSON value. */
  const node = (v: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_EDITOR_NODES) throw new Over(new TooManyNodesError());
    if (depth > MAX_EDITOR_DEPTH) throw new Over(new NestingTooDeepError());
    if (!isRecord(v)) return json(v, 0);
    spend(2);
    let first = true;
    for (const [key, item] of Object.entries(v)) {
      if (item === undefined || typeof item === 'function') continue;
      spend(JSON.stringify(key).length + (first ? 1 : 2));
      first = false;
      if (key === 'content' && Array.isArray(item)) {
        spend(2);
        item.forEach((child, i) => {
          if (i > 0) spend(1);
          node(child, depth + 1);
        });
      } else {
        json(item, 0);
      }
    }
  };
  try {
    node(value, 0);
    return null;
  } catch (error) {
    if (error instanceof Over) return error.error;
    throw error;
  }
}

/** Throws the named error for the first cap `value` breaks. */
export function assertWithinLimits(value: unknown): void {
  const over = exceededLimit(value);
  if (over) throw over;
}
