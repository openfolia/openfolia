import {
  Extension,
  Node,
  type Extensions,
  type NodeViewRenderer,
} from '@tiptap/core';
import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  MAX_TABLE_COLUMNS,
  tableTooLarge,
} from '@openfolia/content-model/core';

import { placeFor } from './block-place';

// Tables as the content model has them: a table holds an optional title, then rows of cells, and
// each cell holds blocks. The editor draws them as a CSS grid (the columns' relative widths as
// `fr`), so a cell spanning columns or rows sits where HTML would put it. Rows and columns are
// added and removed by these commands, which keep `columns` (one entry per column) and every row
// in step. Cells merge with the next one or the one below and split again (`mergeRight`,
// `mergeDown`, `splitCell`); a table with merged cells keeps its rows and columns (split first).
// Each column has an optional alignment (`columns[i].align`), shown on its cells. A table grows
// only within the content model's caps (#686): at most `MAX_TABLE_COLUMNS` columns and
// `MAX_TABLE_CELLS` places (rows × columns); past them, no row or column is added.

/** Where the caret is in a table: the table, the row and the cell (indexes among rows, cells). */
export interface TableAt {
  /** The table's position (before it). */
  readonly pos: number;
  readonly node: ProseMirrorNode;
  /** The index of the row among the table's rows (the title aside). */
  readonly row: number;
  /** The index of the cell in its row: its column, when no cell spans. */
  readonly column: number;
  /** Whether a cell spans rows or columns: then rows and columns cannot be added or removed. */
  readonly merged: boolean;
  /** Where the caret's cell stands in the grid: its first column and its spans. */
  readonly cell: GridCell;
}

/** A cell's place in the table's grid (rows and columns as a reader sees them). */
export interface GridCell {
  readonly row: number;
  readonly col: number;
  readonly colspan: number;
  readonly rowspan: number;
}

const spanOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : 1;

/**
 * Every cell's place in the grid, by row and by its index in the row: HTML's table layout (a cell
 * takes the first column not covered by a cell spanning down from a row above), as the content
 * model checks it.
 */
export function tableGrid(table: ProseMirrorNode): GridCell[][] {
  const rows = rowsOf(table);
  const carried: number[] = [];
  return rows.map((rowNode, r) => {
    const out: GridCell[] = [];
    let col = 0;
    rowNode.forEach((c) => {
      while ((carried[col] ?? 0) > 0) col += 1;
      const colspan = spanOf(c.attrs['colspan']);
      const rowspan = spanOf(c.attrs['rowspan']);
      out.push({ row: r, col, colspan, rowspan });
      for (let k = col; k < col + colspan; k += 1)
        carried[k] = Math.max(carried[k] ?? 0, rowspan);
      col += colspan;
    });
    for (let k = 0; k < carried.length; k += 1)
      carried[k] = Math.max(0, (carried[k] ?? 0) - 1);
    return out;
  });
}

const rowsOf = (table: ProseMirrorNode): ProseMirrorNode[] => {
  const rows: ProseMirrorNode[] = [];
  table.forEach((child) => {
    if (child.type.name === 'tableRow') rows.push(child);
  });
  return rows;
};

const spans = (cell: ProseMirrorNode) =>
  Number(cell.attrs['colspan'] ?? 1) > 1 ||
  Number(cell.attrs['rowspan'] ?? 1) > 1;

/** Whether any cell of the table spans rows or columns. */
export function hasMergedCells(table: ProseMirrorNode): boolean {
  return rowsOf(table).some((row) => {
    let merged = false;
    row.forEach((cell) => {
      if (spans(cell)) merged = true;
    });
    return merged;
  });
}

/** Whether a row, and a column, can be added to the table within the caps (#686). */
export interface TableRoom {
  readonly row: boolean;
  readonly column: boolean;
  /**
   * The cap that leaves no room for one of them: `cells` (`MAX_TABLE_CELLS`) when a row does
   * not fit, else `columns` (`MAX_TABLE_COLUMNS`) when that is the column's, else `cells`; null
   * when both fit.
   */
  readonly cap: 'columns' | 'cells' | null;
}

/** What the table has room for: a row, a column, within `MAX_TABLE_COLUMNS` and `MAX_TABLE_CELLS`. */
export function tableRoom(table: ProseMirrorNode): TableRoom {
  const rows = rowsOf(table).length;
  const columns = columnsOf(table).length;
  const row = tableTooLarge(columns, rows + 1) === undefined;
  const column = tableTooLarge(columns + 1, rows) === undefined;
  return {
    row,
    column,
    cap: !row
      ? 'cells'
      : !column
        ? columns + 1 > MAX_TABLE_COLUMNS
          ? 'columns'
          : 'cells'
        : null,
  };
}

/** The table around the selection's start, or null. */
export function tableAt(state: EditorState): TableAt | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'tableCell') continue;
    const tableDepth = depth - 2;
    const table = $from.node(tableDepth);
    if (table.type.name !== 'table') return null;
    const row =
      $from.index(tableDepth) -
      (table.firstChild?.type.name === 'title' ? 1 : 0);
    const column = $from.index(depth - 1);
    return {
      pos: $from.before(tableDepth),
      node: table,
      row,
      column,
      merged: hasMergedCells(table),
      cell: tableGrid(table)[row]?.[column] ?? {
        row,
        col: column,
        colspan: 1,
        rowspan: 1,
      },
    };
  }
  return null;
}

/** A node type of the content model's schema (always there: the package defines it). */
function nodeType(schema: Schema, name: string) {
  const type = schema.nodes[name];
  if (!type) throw new Error(`The schema has no ${name}`);
  return type;
}

const cell = (schema: Schema): ProseMirrorNode =>
  nodeType(schema, 'tableCell').create(
    null,
    nodeType(schema, 'paragraph').create(),
  );

const row = (schema: Schema, columns: number): ProseMirrorNode =>
  nodeType(schema, 'tableRow').create(
    null,
    Array.from({ length: columns }, () => cell(schema)),
  );

/** A new table: a header row and one row below it, two columns, empty cells. */
export function newTable(
  schema: Schema,
  rows = 2,
  columns = 2,
): ProseMirrorNode {
  return nodeType(schema, 'table').create(
    {
      id: null,
      header: true,
      columns: Array.from({ length: columns }, () => ({ width: 1 })),
    },
    Array.from({ length: rows }, () => row(schema, columns)),
  );
}

/** A position inside the cell at `row`, `column` of the table at `tablePos`, or null. */
function cellPos(
  table: ProseMirrorNode,
  tablePos: number,
  rowIndex: number,
  column: number,
): number | null {
  let seen = -1;
  let found: number | null = null;
  table.forEach((child, offset) => {
    if (found !== null || child.type.name !== 'tableRow') return;
    seen += 1;
    if (seen !== rowIndex) return;
    const rowStart = tablePos + 1 + offset + 1;
    child.forEach((_cell, cellOffset, index) => {
      if (index === column) found = rowStart + cellOffset + 1;
    });
  });
  return found;
}

/** Puts the caret in the cell at `row`, `column` (clamped) of the table at `tablePos`. */
function selectCell(
  tr: Transaction,
  tablePos: number,
  rowIndex: number,
  column: number,
): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const rows = rowsOf(table);
  const r = Math.max(0, Math.min(rowIndex, rows.length - 1));
  const c = Math.max(0, Math.min(column, (rows[r]?.childCount ?? 1) - 1));
  const pos = cellPos(table, tablePos, r, c);
  if (pos === null) return;
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
}

/**
 * Inserts a new table at the caret: in place of a blank line, else after the block the caret is
 * in (a section's first block when the caret is in its heading). The caret goes to the first cell.
 */
export const insertTable: Command = (state, dispatch) => {
  if (tableAt(state)) return false;
  const table = newTable(state.schema);
  const place = placeFor(state, table.type);
  if (!place) return false;
  const { from, to } = place;
  if (dispatch) {
    const tr = state.tr.replaceWith(from, to, table);
    selectCell(tr, from, 0, 0);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Rebuilds the table at the caret with `change`, keeping every untouched node as it is. */
function rebuild(
  change: (
    at: TableAt,
    rows: ProseMirrorNode[],
    schema: Schema,
  ) => {
    rows: ProseMirrorNode[];
    columns?: unknown[];
    header?: boolean;
    caret: { row: number; column: number };
  } | null,
): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at || at.merged) return false;
    const result = change(at, rowsOf(at.node), state.schema);
    if (!result) return false;
    if (dispatch) {
      const title =
        at.node.firstChild?.type.name === 'title' ? [at.node.firstChild] : [];
      const table = at.node.type.create(
        {
          ...at.node.attrs,
          columns: result.columns ?? at.node.attrs['columns'],
          header: result.header ?? at.node.attrs['header'],
        },
        Fragment.from([...title, ...result.rows]),
      );
      const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, table);
      selectCell(tr, at.pos, result.caret.row, result.caret.column);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

const columnsOf = (table: ProseMirrorNode): unknown[] =>
  Array.isArray(table.attrs['columns']) ? [...table.attrs['columns']] : [];

/**
 * Adds a row above (`after` false) or below the caret's row; the caret goes to `column` of the
 * new row (by default, the column it is in).
 */
export const addRow = (after: boolean, column?: number): Command =>
  rebuild((at, rows, schema) => {
    if (!tableRoom(at.node).row) return null;
    const index = after ? at.row + 1 : at.row;
    const next = [...rows];
    next.splice(index, 0, row(schema, columnsOf(at.node).length));
    return { rows: next, caret: { row: index, column: column ?? at.column } };
  });

/** Removes the caret's row; never the last one. */
export const deleteRow: Command = rebuild((at, rows) => {
  if (rows.length <= 1) return null;
  const next = rows.filter((_r, i) => i !== at.row);
  return { rows: next, caret: { row: at.row, column: at.column } };
});

/** Adds a column before (`after` false) or after the caret's column. */
export const addColumn = (after: boolean): Command =>
  rebuild((at, rows, schema) => {
    if (!tableRoom(at.node).column) return null;
    const index = after ? at.column + 1 : at.column;
    const columns = columnsOf(at.node);
    columns.splice(index, 0, { width: 1 });
    const next = rows.map((r) => {
      const cells: ProseMirrorNode[] = [];
      r.forEach((c) => cells.push(c));
      cells.splice(index, 0, cell(schema));
      return r.type.create(r.attrs, cells);
    });
    return { rows: next, columns, caret: { row: at.row, column: index } };
  });

/** Removes the caret's column; never the last one. */
export const deleteColumn: Command = rebuild((at, rows) => {
  const columns = columnsOf(at.node);
  if (columns.length <= 1) return null;
  columns.splice(at.column, 1);
  const next = rows.map((r) => {
    const cells: ProseMirrorNode[] = [];
    r.forEach((c, _o, i) => {
      if (i !== at.column) cells.push(c);
    });
    return r.type.create(r.attrs, cells);
  });
  return { rows: next, columns, caret: { row: at.row, column: at.column } };
});

/**
 * Whether the first row can be the header row: each of its cells one paragraph spanning one row
 * (the model's rule), which a merge in a table without a header row may have undone.
 */
export function canBeHeaderRow(table: ProseMirrorNode): boolean {
  const first = rowsOf(table)[0];
  if (!first) return false;
  let ok = true;
  first.forEach((cell) => {
    if (
      Number(cell.attrs['rowspan'] ?? 1) !== 1 ||
      cell.childCount !== 1 ||
      cell.firstChild?.type.name !== 'paragraph'
    )
      ok = false;
  });
  return ok;
}

/** Turns the first row into the header row, or back; not into one its cells can't make. */
export const toggleHeaderRow: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (at.node.attrs['header'] !== true && !canBeHeaderRow(at.node))
    return false;
  if (dispatch) {
    dispatch(
      state.tr.setNodeAttribute(at.pos, 'header', !at.node.attrs['header']),
    );
  }
  return true;
};

/** Removes the whole table; the caret goes where it stood. */
export const deleteTable: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (dispatch) {
    const tr = state.tr.delete(at.pos, at.pos + at.node.nodeSize);
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(Math.min(at.pos, tr.doc.content.size))),
    );
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Tab and Shift+Tab: to the next or previous cell; past the last cell, a new row. */
export const goToCell =
  (dir: 1 | -1): Command =>
  (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    // In a list inside the cell, Tab nests the item: the list's keys take it.
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const name = $from.node(depth).type.name;
      if (name === 'tableCell') break;
      if (name === 'listItem') return false;
    }
    const rows = rowsOf(at.node);
    const width = rows[at.row]?.childCount ?? 0;
    let r = at.row;
    let c = at.column + dir;
    if (c >= width) {
      r += 1;
      c = 0;
    } else if (c < 0) {
      r -= 1;
      c = (rows[r]?.childCount ?? 1) - 1;
    }
    if (r < 0) return true; // the first cell: Shift+Tab stays
    if (r >= rows.length) {
      // Past the last cell: a new row, as in a word processor (not in a merged table, nor in
      // one at the caps: the caret stays).
      if (at.merged || !tableRoom(at.node).row) return true;
      return addRow(true, 0)(state, dispatch);
    }
    if (dispatch) {
      const tr = state.tr;
      selectCell(tr, at.pos, r, c);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

/** A column's alignment as the content model has it; null leaves it to the output. */
export type ColumnAlign = 'left' | 'center' | 'right';

const ALIGNS: readonly string[] = ['left', 'center', 'right'];

/** The alignment of the caret's column (the first one its cell covers), or null for none. */
export function columnAlign(at: TableAt): ColumnAlign | null {
  const column = columnsOf(at.node)[at.cell.col] as
    { align?: unknown } | undefined;
  const align = column?.align;
  return typeof align === 'string' && ALIGNS.includes(align)
    ? (align as ColumnAlign)
    : null;
}

/** Sets the alignment of the columns the caret's cell covers (null: none). */
export const setColumnAlign =
  (align: ColumnAlign | null): Command =>
  (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    if (dispatch) {
      const columns = columnsOf(at.node).map((column, index) => {
        if (index < at.cell.col || index >= at.cell.col + at.cell.colspan)
          return column;
        const { align: _old, ...rest } = (column ?? {}) as Record<
          string,
          unknown
        >;
        return align ? { ...rest, align } : rest;
      });
      dispatch(state.tr.setNodeAttribute(at.pos, 'columns', columns));
    }
    return true;
  };

/** The cells of each row, as arrays. */
const cellsOf = (rows: ProseMirrorNode[]): ProseMirrorNode[][] =>
  rows.map((r) => {
    const cells: ProseMirrorNode[] = [];
    r.forEach((c) => cells.push(c));
    return cells;
  });

/** A cell's attributes with these spans (1 is left out, as the model writes it). */
const spanned = (cell: ProseMirrorNode, colspan: number, rowspan: number) => ({
  ...cell.attrs,
  colspan: colspan > 1 ? colspan : null,
  rowspan: rowspan > 1 ? rowspan : null,
});

/**
 * Two cells' blocks as one cell's: one after the other. In the header row a cell holds one
 * paragraph, so their texts join in one, a space between.
 */
function joinedBlocks(
  schema: Schema,
  first: ProseMirrorNode,
  second: ProseMirrorNode,
  header: boolean,
): Fragment {
  if (!header) return first.content.append(second.content);
  const paragraph = nodeType(schema, 'paragraph');
  const a = first.firstChild;
  const b = second.firstChild;
  const parts: ProseMirrorNode[] = [];
  a?.forEach((n) => parts.push(n));
  if (a?.content.size && b?.content.size) parts.push(schema.text(' '));
  b?.forEach((n) => parts.push(n));
  return Fragment.from(paragraph.create(a?.attrs ?? null, parts));
}

/** Rebuilds the table at `at` with these rows of cells, the caret in the cell at `caret`. */
function withCells(
  state: EditorState,
  at: TableAt,
  cells: ProseMirrorNode[][],
  caret: { row: number; column: number },
): Transaction {
  const rows = rowsOf(at.node);
  const title =
    at.node.firstChild?.type.name === 'title' ? [at.node.firstChild] : [];
  const table = at.node.type.create(
    at.node.attrs,
    Fragment.from([
      ...title,
      ...cells.map((row, i) => (rows[i] ?? rows[0]!).type.create(null, row)),
    ]),
  );
  const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, table);
  selectCell(tr, at.pos, caret.row, caret.column);
  return tr.scrollIntoView();
}

/**
 * Merges the caret's cell with the next one in its row, when that one covers the same rows: one
 * cell spanning both, holding both cells' blocks.
 */
export const mergeRight: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  const grid = tableGrid(at.node);
  const here = grid[at.row]?.[at.column];
  const next = grid[at.row]?.[at.column + 1];
  if (!here || !next || next.col !== here.col + here.colspan) return false;
  if (next.rowspan !== here.rowspan) return false;
  if (dispatch) {
    const cells = cellsOf(rowsOf(at.node));
    const row = cells[at.row]!;
    const a = row[at.column]!;
    const b = row[at.column + 1]!;
    const header = at.node.attrs['header'] === true && at.row === 0;
    row.splice(
      at.column,
      2,
      a.type.create(
        spanned(a, here.colspan + next.colspan, here.rowspan),
        joinedBlocks(state.schema, a, b, header),
      ),
    );
    dispatch(withCells(state, at, cells, { row: at.row, column: at.column }));
  }
  return true;
};

/**
 * Merges the caret's cell with the one below it, when that one covers the same columns: one cell
 * spanning both rows. Never in the header row (its cells span one row).
 */
export const mergeDown: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (at.node.attrs['header'] === true && at.row === 0) return false;
  const grid = tableGrid(at.node);
  const here = grid[at.row]?.[at.column];
  if (!here) return false;
  const belowRow = at.row + here.rowspan;
  const index = grid[belowRow]?.findIndex((c) => c.col === here.col) ?? -1;
  const below = grid[belowRow]?.[index];
  if (!below || below.colspan !== here.colspan) return false;
  // A row keeps at least one cell of its own (the model has no empty row).
  if ((grid[belowRow]?.length ?? 0) <= 1) return false;
  if (dispatch) {
    const cells = cellsOf(rowsOf(at.node));
    const a = cells[at.row]![at.column]!;
    const b = cells[belowRow]![index]!;
    cells[at.row]![at.column] = a.type.create(
      spanned(a, here.colspan, here.rowspan + below.rowspan),
      a.content.append(b.content),
    );
    cells[belowRow]!.splice(index, 1);
    dispatch(withCells(state, at, cells, { row: at.row, column: at.column }));
  }
  return true;
};

/**
 * Splits the caret's merged cell back into single cells: it keeps its blocks in its first row and
 * column, and every other place it covered gets an empty cell.
 */
export const splitCell: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  const here = at.cell;
  if (here.colspan === 1 && here.rowspan === 1) return false;
  if (dispatch) {
    const grid = tableGrid(at.node);
    const cells = cellsOf(rowsOf(at.node));
    const a = cells[at.row]![at.column]!;
    cells[at.row]!.splice(
      at.column,
      1,
      a.type.create(spanned(a, 1, 1), a.content),
      ...Array.from({ length: here.colspan - 1 }, () => cell(state.schema)),
    );
    for (let r = at.row + 1; r < at.row + here.rowspan; r += 1) {
      const index = (grid[r] ?? []).filter((c) => c.col < here.col).length;
      cells[r]?.splice(
        index,
        0,
        ...Array.from({ length: here.colspan }, () => cell(state.schema)),
      );
    }
    dispatch(withCells(state, at, cells, { row: at.row, column: at.column }));
  }
  return true;
};

/** Each cell's text alignment, from the column it starts in. */
function alignDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const columns = columnsOf(node) as { align?: unknown }[];
    if (!columns.some((c) => c && ALIGNS.includes(c.align as string)))
      return false;
    const grid = tableGrid(node);
    let r = -1;
    node.forEach((rowNode, rowOffset) => {
      if (rowNode.type.name !== 'tableRow') return;
      r += 1;
      rowNode.forEach((cellNode, cellOffset, i) => {
        const align = columns[grid[r]?.[i]?.col ?? -1]?.align;
        if (typeof align !== 'string' || !ALIGNS.includes(align)) return;
        const from = pos + 1 + rowOffset + 1 + cellOffset;
        decorations.push(
          Decoration.node(from, from + cellNode.nodeSize, {
            // `left` and `right` are the start and end of the text's direction (#458).
            style: `text-align: ${align === 'left' ? 'start' : align === 'right' ? 'end' : 'center'}`,
            'data-align': align,
          }),
        );
      });
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const alignKey = new PluginKey<DecorationSet>('docEditorTableAlign');

/** Shows each column's alignment on its cells. */
const tableAlign = new Plugin<DecorationSet>({
  key: alignKey,
  state: {
    init: (_config, state) => alignDecorations(state.doc),
    apply: (tr, value) => (tr.docChanged ? alignDecorations(tr.doc) : value),
  },
  props: { decorations: (state) => alignKey.getState(state) },
});

const tableView: NodeViewRenderer = ({ node, view }) => {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.setAttribute('data-node', 'table');
  dom.className = 'doc-editor-table';
  const draw = (n: ProseMirrorNode) => {
    const columns = Array.isArray(n.attrs['columns'])
      ? (n.attrs['columns'] as { width?: unknown }[])
      : [];
    dom.style.setProperty(
      '--table-columns',
      columns.length
        ? columns
            .map((c) =>
              typeof c.width === 'number' && c.width > 0
                ? `minmax(0, ${c.width}fr)`
                : 'minmax(0, 1fr)',
            )
            .join(' ')
        : 'minmax(0, 1fr)',
    );
    dom.toggleAttribute('data-header', n.attrs['header'] === true);
  };
  draw(node);
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== node.type) return false;
      draw(next);
      return true;
    },
    // The grid's style is the view's own: not a change of the document.
    ignoreMutation: (mutation) =>
      mutation.type === 'attributes' && mutation.target === dom,
  };
};

const cellView: NodeViewRenderer = ({ node, view }) => {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.setAttribute('data-node', 'tableCell');
  const draw = (n: ProseMirrorNode) => {
    const colspan = Number(n.attrs['colspan'] ?? 1);
    const rowspan = Number(n.attrs['rowspan'] ?? 1);
    dom.style.gridColumn = colspan > 1 ? `span ${colspan}` : '';
    dom.style.gridRow = rowspan > 1 ? `span ${rowspan}` : '';
  };
  draw(node);
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== node.type) return false;
      draw(next);
      return true;
    },
    ignoreMutation: (mutation) =>
      mutation.type === 'attributes' && mutation.target === dom,
  };
};

/** The content model's extensions with tables drawn as editable grids. */
export function withTables(extensions: Extensions): Extensions {
  return extensions.map((extension) =>
    extension instanceof Node && extension.name === 'table'
      ? extension.extend({ addNodeView: () => tableView })
      : extension instanceof Node && extension.name === 'tableCell'
        ? extension.extend({ addNodeView: () => cellView })
        : extension,
  );
}

/** Tab and Shift+Tab between cells; before the list keys, which would nest a list item. */
export const TableKeys = Extension.create({
  name: 'tableKeys',
  priority: 1100,
  addProseMirrorPlugins() {
    return [tableAlign];
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => goToCell(1)(editor.state, editor.view.dispatch),
      'Shift-Tab': ({ editor }) =>
        goToCell(-1)(editor.state, editor.view.dispatch),
    };
  },
});
