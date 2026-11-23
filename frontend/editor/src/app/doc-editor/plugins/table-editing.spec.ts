import type { Editor } from '@tiptap/core';
import { EditorState, TextSelection, type Command } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';

import { withoutCaretGaps } from './caret-gaps';
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  goToCell,
  hasMergedCells,
  insertTable,
  mergeDown,
  mergeRight,
  newTable,
  setColumnAlign,
  splitCell,
  TableKeys,
  tableAt,
  tableGrid,
  tableRoom,
  toggleHeaderRow,
} from './table-editing';
import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  type Module,
  type Table,
} from '@openfolia/content-model/core';
import { inside, p, testEditor } from '../testing/test-editor';

const run = (editor: Editor, command: Command) =>
  command(editor.state, editor.view.dispatch);

/** The table's cells as text, row by row. */
function grid(editor: Editor): string[][] {
  const out: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      const row: string[] = [];
      node.forEach((cell) => row.push(cell.textContent));
      out.push(row);
      return false;
    }
    return true;
  });
  return out;
}

function typeIn(editor: Editor, text: string) {
  editor.commands.insertContent(text);
}

function withTable() {
  const editor = testEditor({
    ...toEditor({
      schemaVersion: 1,
      id: 'tables',
      meta: { title: 'Tables', type: 'concept', lang: 'en', facets: {} },
      blocks: [],
    } as never),
    content: [p('intro', 'intro'), p()],
  });
  editor.commands.setTextSelection(inside(editor, 1));
  expect(run(editor, insertTable)).toBe(true);
  typeIn(editor, 'a');
  run(editor, goToCell(1));
  typeIn(editor, 'b');
  run(editor, goToCell(1));
  typeIn(editor, 'c');
  run(editor, goToCell(1));
  typeIn(editor, 'd');
  return editor;
}

describe('table editing', () => {
  it('saves a fresh table, its cells empty', () => {
    const editor = testEditor({
      ...toEditor({
        schemaVersion: 1,
        id: 'tables',
        meta: { title: 'Tables', type: 'concept', lang: 'en', facets: {} },
        blocks: [],
      } as never),
      content: [p('intro', 'intro'), p()],
    });
    editor.commands.setTextSelection(inside(editor, 1));
    expect(run(editor, insertTable)).toBe(true);
    const out = fromEditor(
      normalizeEditorDoc(withoutCaretGaps(editor.getJSON())),
    ).blocks.find((b) => b.type === 'table') as Table;
    expect(out.rows.map((r) => r.cells.map((c) => c.blocks))).toEqual([
      [[], []],
      [[], []],
    ]);
  });

  it('inserts a table in place of a blank line, with the caret in its first cell', () => {
    const editor = withTable();
    expect(grid(editor)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    const table = tableAt(editor.state);
    expect(table?.node.attrs['header']).toBe(true);
    expect(table?.node.attrs['columns']).toEqual([{ width: 1 }, { width: 1 }]);
  });

  it('adds and removes rows and columns, keeping the columns in step', () => {
    const editor = withTable();
    // The new row's caret stays in the column it was in.
    run(editor, addRow(true));
    typeIn(editor, 'f');
    run(editor, goToCell(-1));
    typeIn(editor, 'e');
    expect(grid(editor)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    // Before the caret's column (the first).
    run(editor, addColumn(false));
    expect(grid(editor)).toEqual([
      ['', 'a', 'b'],
      ['', 'c', 'd'],
      ['', 'e', 'f'],
    ]);
    expect(tableAt(editor.state)?.node.attrs['columns']).toHaveLength(3);
    run(editor, deleteColumn);
    expect(tableAt(editor.state)?.node.attrs['columns']).toHaveLength(2);
    expect(grid(editor)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    run(editor, deleteRow);
    expect(grid(editor)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('Tab past the last cell adds a row; Shift+Tab goes back', () => {
    const editor = withTable();
    run(editor, goToCell(1));
    expect(grid(editor)).toHaveLength(3);
    run(editor, goToCell(-1));
    expect(editor.state.selection.$from.parent.textContent).toBe('d');
  });

  it('toggles the header row', () => {
    const editor = withTable();
    run(editor, toggleHeaderRow);
    expect(tableAt(editor.state)?.node.attrs['header']).toBe(false);
  });

  it('converts to the content model with every cell filled', () => {
    const editor = withTable();
    const module = fromEditor(
      normalizeEditorDoc(withoutCaretGaps(editor.getJSON())),
    );
    const table = module.blocks.find((b) => b.type === 'table');
    expect(
      table?.type === 'table' && table.rows.map((r) => r.cells.length),
    ).toEqual([2, 2]);
  });

  it('leaves rows and columns of a table with merged cells alone', () => {
    const editor = withTable();
    const at = tableAt(editor.state);
    if (!at) throw new Error('no table');
    let cellPos = -1;
    editor.state.doc.nodesBetween(
      at.pos,
      at.pos + at.node.nodeSize,
      (node, pos) => {
        if (cellPos < 0 && node.type.name === 'tableCell') cellPos = pos;
      },
    );
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(cellPos, 'colspan', 2),
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(cellPos + 2)),
      ),
    );
    expect(
      hasMergedCells(tableAt(editor.state)?.node ?? editor.state.doc),
    ).toBe(true);
    expect(run(editor, addRow(true))).toBe(false);
    expect(run(editor, deleteColumn)).toBe(false);
  });

  it('inserts no table inside a table', () => {
    const editor = withTable();
    expect(run(editor, insertTable)).toBe(false);
  });
});

describe('the caps of a table (#686)', () => {
  /** An editor holding a table of `columns` columns and two rows, the caret in its last cell. */
  function wideTable(columns: number) {
    const table: Table = {
      type: 'table',
      id: 'wide',
      columns: Array.from({ length: columns }, () => ({ width: 1 })),
      header: false,
      rows: Array.from({ length: 2 }, (_r, r) => ({
        cells: Array.from({ length: columns }, (_c, c) => ({
          blocks: [
            {
              type: 'paragraph',
              id: `c${r}-${c}`,
              content: [{ type: 'text', text: 'x' }],
            },
          ],
        })),
      })),
    };
    const editor = testEditor(
      toEditor({
        schemaVersion: 1,
        id: 'tables',
        meta: { title: 'Tables', type: 'concept', lang: 'en', facets: {} },
        blocks: [table],
      } as Module),
    );
    const end = editor.state.doc.firstChild?.nodeSize ?? 0;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(end - 4)),
      ),
    );
    expect(tableAt(editor.state)?.row).toBe(1);
    return editor;
  }
  const columns = (editor: Editor) =>
    (tableAt(editor.state)?.node.attrs['columns'] as unknown[]).length;
  const rows = (editor: Editor) => grid(editor).length;

  it('adds no column past MAX_TABLE_COLUMNS, and still adds rows', () => {
    const editor = wideTable(MAX_TABLE_COLUMNS);
    const at = tableAt(editor.state);
    if (!at) throw new Error('no table');
    expect(tableRoom(at.node)).toEqual({
      row: true,
      column: false,
      cap: 'columns',
    });
    expect(run(editor, addColumn(true))).toBe(false);
    expect(run(editor, addColumn(false))).toBe(false);
    expect(columns(editor)).toBe(MAX_TABLE_COLUMNS);
    expect(run(editor, addRow(true))).toBe(true);
    expect(rows(editor)).toBe(3);
  });

  it('adds a column up to the cap', () => {
    const editor = wideTable(MAX_TABLE_COLUMNS - 1);
    expect(tableRoom(tableAt(editor.state)!.node).cap).toBeNull();
    expect(run(editor, addColumn(true))).toBe(true);
    expect(columns(editor)).toBe(MAX_TABLE_COLUMNS);
    expect(tableRoom(tableAt(editor.state)!.node).column).toBe(false);
  });

  it('adds no row or column past MAX_TABLE_CELLS, and Tab past the last cell stays', () => {
    const { schema } = testEditor({ type: 'doc', content: [p('x')] });
    // 250 rows of 200 columns: 50,000 places, the cap.
    expect(250 * 200).toBe(MAX_TABLE_CELLS);
    expect(tableRoom(newTable(schema, 250, 200))).toEqual({
      row: false,
      column: false,
      cap: 'cells',
    });
    expect(tableRoom(newTable(schema, 249, 200))).toEqual({
      row: true,
      column: false,
      cap: 'cells',
    });
    // A table whose next row would pass the cap (without a view: the editor's own node cap
    // keeps a document far smaller), the caret in its last cell.
    const full = newTable(
      schema,
      MAX_TABLE_CELLS / MAX_TABLE_COLUMNS,
      MAX_TABLE_COLUMNS,
    );
    const doc = schema.node('doc', null, [full]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.near(doc.resolve(full.nodeSize - 3)),
    });
    expect(tableAt(state)?.row).toBe(MAX_TABLE_CELLS / MAX_TABLE_COLUMNS - 1);
    const dispatch = vi.fn();
    expect(addRow(true)(state, dispatch)).toBe(false);
    expect(addRow(false)(state, dispatch)).toBe(false);
    expect(addColumn(true)(state, dispatch)).toBe(false);
    // Tab: no new row, the caret stays put.
    expect(goToCell(1)(state, dispatch)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

const textCell = (id: string, text: string) => ({
  blocks: [
    {
      type: 'paragraph' as const,
      id,
      content: [{ type: 'text' as const, text }],
    },
  ],
});

/** A 3 × 3 table of a to i, with or without a header row, as the model has it. */
function grid3(header: boolean): Module {
  const letters = 'abcdefghi';
  return {
    schemaVersion: 1,
    id: 'tables',
    meta: { title: 'Tables', type: 'concept', lang: 'en', facets: {} },
    blocks: [
      {
        type: 'table',
        id: 't',
        header,
        columns: [{ width: 1 }, { width: 1 }, { width: 1 }],
        rows: [0, 1, 2].map((r) => ({
          cells: [0, 1, 2].map((c) => {
            const l = letters[r * 3 + c]!;
            return textCell(`c-${l}`, l);
          }),
        })),
      },
    ],
  } as Module;
}

function tableEditor(header = false) {
  const editor = testEditor(toEditor(grid3(header)), [TableKeys]);
  return editor;
}

/** Puts the caret in the cell holding `text`. */
function caretIn(editor: Editor, text: string) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'paragraph' && node.textContent === text)
      at = pos + 1;
    return at < 0;
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)),
  );
}

const tableOf = (editor: Editor) =>
  fromEditor(normalizeEditorDoc(editor.getJSON())).blocks[0] as Table;

describe('merged cells', () => {
  it('never merges down the last cell of a row: a row keeps a cell of its own', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    expect(run(editor, mergeRight)).toBe(true);
    expect(run(editor, mergeRight)).toBe(true);
    // Row 1 has three cells, but the merged cell spans all three columns: none below matches.
    expect(run(editor, mergeDown)).toBe(false);
    caretIn(editor, 'd');
    expect(run(editor, mergeRight)).toBe(true);
    expect(run(editor, mergeRight)).toBe(true);
    caretIn(editor, 'a');
    // The row below would be left without a cell.
    expect(run(editor, mergeDown)).toBe(false);
    expect(tableOf(editor).rows.every((r) => r.cells.length > 0)).toBe(true);
  });

  it('keeps the header row off while the first row has merged or several-paragraph cells', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    run(editor, mergeDown);
    expect(run(editor, toggleHeaderRow)).toBe(false);
    editor.commands.undo();
    caretIn(editor, 'a');
    run(editor, mergeRight);
    expect(run(editor, toggleHeaderRow)).toBe(false);
    editor.commands.undo();
    caretIn(editor, 'a');
    expect(run(editor, toggleHeaderRow)).toBe(true);
    expect(tableOf(editor).header).toBe(true);
  });

  it('lays cells out in the grid as HTML does', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    run(editor, mergeDown);
    const at = tableAt(editor.state)!;
    expect(tableGrid(at.node).map((row) => row.map((c) => c.col))).toEqual([
      [0, 1, 2],
      [1, 2],
      [0, 1, 2],
    ]);
  });

  it('merges a cell with the next one, and splits it back', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    expect(run(editor, mergeRight)).toBe(true);
    expect(grid(editor)).toEqual([
      ['ab', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i'],
    ]);
    const merged = tableOf(editor).rows[0]!.cells[0]!;
    expect(merged.colspan).toBe(2);
    expect(merged.blocks).toHaveLength(2);
    // The caret stays in the merged cell; its rows and columns stay as they are.
    expect(tableAt(editor.state)?.cell).toEqual({
      row: 0,
      col: 0,
      colspan: 2,
      rowspan: 1,
    });
    expect(run(editor, addRow(true))).toBe(false);
    expect(run(editor, splitCell)).toBe(true);
    expect(grid(editor)).toEqual([
      ['ab', '', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i'],
    ]);
    editor.commands.undo();
    editor.commands.undo();
    expect(tableOf(editor)).toEqual(grid3(false).blocks[0]);
  });

  it('merges a cell with the one below, and splits it back', () => {
    const editor = tableEditor();
    caretIn(editor, 'b');
    expect(run(editor, mergeDown)).toBe(true);
    expect(grid(editor)).toEqual([
      ['a', 'be', 'c'],
      ['d', 'f'],
      ['g', 'h', 'i'],
    ]);
    expect(tableOf(editor).rows[0]!.cells[1]!.rowspan).toBe(2);
    // Again: a cell spanning two rows takes in the one below both.
    expect(run(editor, mergeDown)).toBe(true);
    expect(tableOf(editor).rows[0]!.cells[1]!.rowspan).toBe(3);
    expect(run(editor, mergeDown)).toBe(false);
    expect(run(editor, splitCell)).toBe(true);
    expect(grid(editor)).toEqual([
      ['a', 'beh', 'c'],
      ['d', '', 'f'],
      ['g', '', 'i'],
    ]);
    // Every row covers the three columns again (the new cells are empty: filled, they convert).
    expect(
      tableGrid(tableAt(editor.state)!.node).map((r) =>
        r.reduce((n, c) => n + c.colspan, 0),
      ),
    ).toEqual([3, 3, 3]);
  });

  it('merges only cells covering the same rows or columns', () => {
    const editor = tableEditor();
    caretIn(editor, 'b');
    run(editor, mergeDown);
    caretIn(editor, 'a');
    // b now spans two rows, a one: no merge across.
    expect(run(editor, mergeRight)).toBe(false);
    caretIn(editor, 'c');
    expect(run(editor, mergeRight)).toBe(false);
    expect(run(editor, splitCell)).toBe(false);
  });

  it('keeps the header row one row high, each cell one paragraph', () => {
    const editor = tableEditor(true);
    caretIn(editor, 'a');
    expect(run(editor, mergeDown)).toBe(false);
    expect(run(editor, mergeRight)).toBe(true);
    const cell = tableOf(editor).rows[0]!.cells[0]!;
    expect(cell.blocks).toEqual([
      {
        type: 'paragraph',
        id: 'c-a',
        content: [{ type: 'text', text: 'a b' }],
      },
    ]);
    expect(cell.colspan).toBe(2);
  });
});

describe('column alignment', () => {
  it('aligns the caret’s columns, shows it on their cells, and takes it off again', () => {
    const editor = tableEditor();
    caretIn(editor, 'e');
    expect(run(editor, setColumnAlign('center'))).toBe(true);
    expect(tableOf(editor).columns).toEqual([
      { width: 1 },
      { width: 1, align: 'center' },
      { width: 1 },
    ]);
    const aligned = [
      ...editor.view.dom.querySelectorAll('[data-align="center"]'),
    ].map((e) => e.textContent);
    expect(aligned).toEqual(['b', 'e', 'h']);
    run(editor, setColumnAlign(null));
    expect(tableOf(editor).columns[1]).toEqual({ width: 1 });
    expect(editor.view.dom.querySelector('[data-align]')).toBeNull();
  });

  it('shows left and right as the start and end of the text, mirrored right to left (#458)', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    run(editor, setColumnAlign('left'));
    caretIn(editor, 'c');
    run(editor, setColumnAlign('right'));
    const style = (text: string) =>
      [...editor.view.dom.querySelectorAll<HTMLElement>('[data-align]')].find(
        (e) => e.textContent === text,
      )?.style.textAlign;
    expect(style('a')).toBe('start');
    expect(style('c')).toBe('end');
  });

  it('aligns every column a merged cell covers', () => {
    const editor = tableEditor();
    caretIn(editor, 'a');
    run(editor, mergeRight);
    run(editor, setColumnAlign('right'));
    expect(tableOf(editor).columns.map((c) => c.align)).toEqual([
      'right',
      'right',
      undefined,
    ]);
  });
});
