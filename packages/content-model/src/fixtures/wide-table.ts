import type { Block, Table, TableCell, TableRow } from '../lib/blocks.js';
import type { Module } from '../lib/module.js';

/**
 * Tables past the caps (#686), for tests that count the work of laying out a table's grid
 * instead of timing it.
 */

const text = (t: string) => [{ type: 'text' as const, text: t }];

/** An empty cell spanning `colspan` columns and `rowspan` rows (1: left out). */
const cell = (colspan = 1, rowspan = 1): TableCell => ({
  ...(colspan > 1 ? { colspan } : {}),
  ...(rowspan > 1 ? { rowspan } : {}),
  blocks: [],
});

/** A table of `columns` columns and `rows` rows of empty single cells. */
export function plainTable(columns: number, rows: number, id = 'wide'): Table {
  return {
    type: 'table',
    id,
    columns: Array.from({ length: columns }, () => ({ width: 1 })),
    header: false,
    rows: Array.from({ length: rows }, () => ({
      cells: Array.from({ length: columns }, () => cell()),
    })),
  };
}

/**
 * The shape the issue names (#686): few cells covering a large area. `bands` bands of 100 rows
 * over `100 * blocks + 1` columns: at the top of each band, `blocks` cells spanning 100 × 100
 * and one single cell; every other row of the band one single cell, in the last column.
 */
export function spannedTable(
  bands: number,
  blocks: number,
  id = 'spanned',
): Table {
  const columns = 100 * blocks + 1;
  const rows: TableRow[] = [];
  for (let band = 0; band < bands; band++) {
    rows.push({
      cells: [...Array.from({ length: blocks }, () => cell(100, 100)), cell()],
    });
    for (let r = 1; r < 100; r++) rows.push({ cells: [cell()] });
  }
  return {
    type: 'table',
    id,
    columns: Array.from({ length: columns }, () => ({ width: 1 })),
    header: false,
    rows,
  };
}

/** A module holding `table` (not validated: `printModule` prints it as it is). */
export function moduleWith(table: Block, id = 'tables'): Module {
  return {
    schemaVersion: 1,
    id,
    meta: {
      title: 'Tables',
      type: 'concept',
      lang: 'en',
      audience: 'public',
      facets: {},
      keywords: [],
    },
    blocks: [
      { type: 'paragraph', id: 'intro', content: text('Before the table.') },
      table,
    ],
  };
}

/**
 * `list` behind a proxy counting how many of its items are read: what laying out a grid reads,
 * row by row (or cell by cell). Its length is read for free.
 */
export function counting<T>(list: readonly T[]): {
  list: T[];
  reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy(list as T[], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list: proxy, reads: () => reads };
}

/** `table` with its rows behind `counting`. */
export function countingRows(table: Table): {
  table: Table;
  reads: () => number;
} {
  const rows = counting(table.rows);
  return { table: { ...table, rows: rows.list }, reads: rows.reads };
}
