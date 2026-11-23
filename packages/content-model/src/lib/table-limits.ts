/**
 * The most a table may cover (#686): its columns, and its grid, the places of its rows times its
 * columns, a cell spanning several counted once for each. Everything that lays out a table's
 * grid (the AsciiDoc parser, the structure check, the chunker, the renderers, the DITA export,
 * the editor) works per grid place, so a table of few cells spanning a large area (a cell may
 * span 100 × 100) would hold the process: each refuses a table past these first, before laying
 * out a row. The DITA import cuts a table down to them.
 *
 * Far above real content: the largest table of the sample content, the fixtures and the scale
 * generator's profiles (`scripts/perf`, at most 5 columns and 17 rows) covers 85 places. The same
 * everywhere, not a setting: whether content is valid is the content's, not the deployment's.
 */

/** The most columns a table may have. */
export const MAX_TABLE_COLUMNS = 1_000;

/** The most places a table's grid may have: its rows times its columns. */
export const MAX_TABLE_CELLS = 50_000;

/**
 * The most places the tables of one file may cover together (#686): a module's (one language
 * file), or a page design's regions (every slot and language together); twenty
 * tables at `MAX_TABLE_CELLS`. A table of few cells may span its whole area in a few hundred
 * bytes, so without it a file of thousands of such tables would still lay out 10⁸ places. A
 * manual is held to the same over every inclusion of its modules (`MAX_EXPANDED_TABLE_CELLS`).
 */
export const MAX_MODULE_TABLE_CELLS = 1_000_000;

/** Why tables covering `total` places together are past `MAX_MODULE_TABLE_CELLS`, or `undefined`. */
export function tablesTooLarge(total: number): string | undefined {
  return total > MAX_MODULE_TABLE_CELLS
    ? `the tables of a module, or of a page design's regions, cover at most ${MAX_MODULE_TABLE_CELLS.toLocaleString('en')} cells (rows × columns) together`
    : undefined;
}

/** The stable code of a table past the caps: a schema issue's `params.code`, an error's `code`. */
export const TABLE_TOO_LARGE = 'table-too-large';

/** Why a table of `columns` columns and `rows` rows is past the caps, or `undefined`. */
export function tableTooLarge(
  columns: number,
  rows: number,
): string | undefined {
  if (columns > MAX_TABLE_COLUMNS) {
    return `a table has at most ${MAX_TABLE_COLUMNS.toLocaleString('en')} columns, not ${columns.toLocaleString('en')}`;
  }
  if (columns * rows > MAX_TABLE_CELLS) {
    return `a table covers at most ${MAX_TABLE_CELLS.toLocaleString('en')} cells (rows × columns), not ${rows.toLocaleString('en')} × ${columns.toLocaleString('en')}`;
  }
  return undefined;
}

/** A table past `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS`: refused before its grid is laid out. */
export class TableTooLargeError extends Error {
  readonly code = TABLE_TOO_LARGE;

  constructor(
    /** The table's block ID. */
    readonly tableId: string,
    message: string,
  ) {
    super(`table "${tableId}": ${message}`);
    this.name = 'TableTooLargeError';
  }
}

/**
 * Throws `TableTooLargeError` for a table past the caps. Reads only how many columns and rows it
 * has, never a row: for what lays out the grid of content that should have been validated
 * already (a renderer, an export), so content that was not never holds it.
 */
export function assertTableWithinLimits(table: {
  readonly id: string;
  readonly columns: { readonly length: number };
  readonly rows: { readonly length: number };
}): void {
  const problem = tableTooLarge(table.columns.length, table.rows.length);
  if (problem) throw new TableTooLargeError(table.id, problem);
}
