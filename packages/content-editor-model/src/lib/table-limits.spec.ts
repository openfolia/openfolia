import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  type Module,
  type Table,
} from '@openfolia/content-model';
import { fromEditor } from './from-editor.js';
import { EditorLimitError, TableTooLargeEditorError } from './limits.js';
import { toEditor } from './to-editor.js';

/**
 * #686: the converters refuse a table past the content model's caps (`MAX_TABLE_COLUMNS`,
 * `MAX_TABLE_CELLS`) with a `TableTooLargeEditorError`, before a row of it is converted.
 */

const meta = { title: 'A module', type: 'concept', lang: 'en', facets: {} };

/** A table of `columns` × `rows` empty cells, its rows behind a proxy counting reads. */
function tableOf(
  columns: number,
  rows: number,
): { table: Table; reads: () => number } {
  const list = Array.from({ length: rows }, () => ({
    cells: Array.from({ length: columns }, () => ({ blocks: [] })),
  }));
  let reads = 0;
  const counted = new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    table: {
      type: 'table',
      id: 'wide',
      columns: Array.from({ length: columns }, () => ({ width: 1 })),
      header: false,
      rows: counted,
    },
    reads: () => reads,
  };
}

const moduleOf = (table: Table): Module => ({
  schemaVersion: 1,
  id: 'sample',
  meta,
  blocks: [table],
});

/** What `run` throws. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a table past the caps (#686)', () => {
  it('is refused by toEditor before a row of it is converted', () => {
    for (const [columns, rows] of [
      [MAX_TABLE_COLUMNS + 1, 2],
      [100, MAX_TABLE_CELLS / 100 + 1],
    ] as const) {
      const { table, reads } = tableOf(columns, rows);
      const error = thrown(() => toEditor(moduleOf(table)));
      expect(error).toBeInstanceOf(TableTooLargeEditorError);
      expect(error).toBeInstanceOf(EditorLimitError);
      expect(error).toMatchObject({ limit: 'table', tableId: 'wide' });
      expect(reads()).toBe(0);
    }
  });

  it('is refused by fromEditor, as an editor limit naming the table', () => {
    const { table } = tableOf(MAX_TABLE_COLUMNS, 2);
    const doc = toEditor(moduleOf(table));
    const node = doc.content?.[0];
    if (!node?.attrs) throw new Error('no table');
    // One more column, as an editor that skipped its checks would make it.
    node.attrs['columns'] = [
      ...(node.attrs['columns'] as unknown[]),
      { width: 1 },
    ];
    for (const row of node.content ?? []) {
      row.content = [
        ...(row.content ?? []),
        { type: 'tableCell', content: [{ type: 'paragraph' }] },
      ];
    }
    const error = thrown(() => fromEditor(doc));
    expect(error).toBeInstanceOf(TableTooLargeEditorError);
    expect(error).toMatchObject({
      limit: 'table',
      tableId: 'wide',
      max: MAX_TABLE_COLUMNS,
    });
  });

  it('is not a table at the caps: that converts both ways', () => {
    const { table } = tableOf(MAX_TABLE_COLUMNS, 2);
    const module = moduleOf({ ...table, rows: [...table.rows] });
    expect(fromEditor(toEditor(module))).toEqual(module);
  });
});
