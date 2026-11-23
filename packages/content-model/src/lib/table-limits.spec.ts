import {
  counting,
  countingRows,
  moduleWith,
  plainTable,
  spannedTable,
} from '../fixtures/wide-table.js';
import { AsciidocParseError } from './asciidoc/syntax.js';
import { parseModule, toRows } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import { toChunks } from './chunk.js';
import { ProjectConfig } from './config.js';
import { sampleConfig } from '../fixtures/config.js';
import { MAX_EXPANDED_TABLE_CELLS } from './expansion.js';
import { Manifest } from './manifest.js';
import { Module } from './module.js';
import { PageDesign } from './page-design.js';
import { resolveManual } from './resolve.js';
import { checkStructure } from './structure.js';
import {
  MAX_MODULE_TABLE_CELLS,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  TABLE_TOO_LARGE,
  TableTooLargeError,
  tableTooLarge,
} from './table-limits.js';

/**
 * #686: a table's columns, and its grid (rows × columns), are capped, and whatever lays out the
 * grid refuses a table past the caps before laying out a row. Counted (the rows or cells read),
 * never timed.
 */

/** The code `go` throws with: an `AsciidocParseError`'s or a `TableTooLargeError`'s. */
const refusal = (go: () => unknown): string | undefined => {
  try {
    go();
  } catch (error) {
    if (
      error instanceof AsciidocParseError ||
      error instanceof TableTooLargeError
    ) {
      return error.code;
    }
    throw error;
  }
  return 'made';
};

const parsing = (table: ReturnType<typeof plainTable>) => () =>
  parseModule(printModule(moduleWith(table)), { id: 'tables' });

const cellsOf = (table: ReturnType<typeof plainTable>) =>
  table.rows.flatMap((row) => row.cells);

/** A reader standing in for the parser's, for `toRows` alone. */
const reader = {
  error: (message: string) => new AsciidocParseError(message),
} as Parameters<typeof toRows>[2];

describe('the caps (#686)', () => {
  it('take a table at the caps, and refuse one past them', () => {
    expect(tableTooLarge(MAX_TABLE_COLUMNS, 50)).toBeUndefined();
    expect(tableTooLarge(MAX_TABLE_COLUMNS + 1, 1)).toContain('1,000 columns');
    expect(tableTooLarge(500, 100)).toBeUndefined();
    expect(tableTooLarge(500, 101)).toContain('50,000 cells');
  });
});

describe('the AsciiDoc parser (#686)', () => {
  it('reads tables at the caps as before', () => {
    for (const table of [
      plainTable(MAX_TABLE_COLUMNS, 2),
      plainTable(100, 500),
    ]) {
      const module = parsing(table)();
      expect(module.blocks[1]).toEqual(table);
    }
  });

  it('refuses a table past the column cap with table-too-large, laying out no row', () => {
    expect(refusal(parsing(plainTable(MAX_TABLE_COLUMNS + 1, 1)))).toBe(
      TABLE_TOO_LARGE,
    );
    const cells = counting(cellsOf(plainTable(MAX_TABLE_COLUMNS + 1, 3)));
    expect(
      refusal(() => toRows(cells.list, MAX_TABLE_COLUMNS + 1, reader, 1)),
    ).toBe(TABLE_TOO_LARGE);
    expect(cells.reads()).toBe(0);
  });

  it('refuses a grid past the cell cap, laying out no row past it', () => {
    // 1,000 columns of single cells: 50 rows fit, the 51st does not.
    expect(refusal(parsing(plainTable(MAX_TABLE_COLUMNS, 51)))).toBe(
      TABLE_TOO_LARGE,
    );
    const cells = counting(cellsOf(plainTable(MAX_TABLE_COLUMNS, 200)));
    expect(
      refusal(() => toRows(cells.list, MAX_TABLE_COLUMNS, reader, 1)),
    ).toBe(TABLE_TOO_LARGE);
    expect(cells.reads()).toBeLessThanOrEqual(51 * MAX_TABLE_COLUMNS);
  });

  it('refuses few cells spanning a large area, as the issue has it, laying out no row past the cap', () => {
    // Ten bands of 100 rows over 901 columns: 1,000 rows of 1 or 10 cells, 901,000 places.
    expect(refusal(parsing(spannedTable(10, 9)))).toBe(TABLE_TOO_LARGE);
    // The issue's: 1,000 bands over 10,001 columns, about 10⁹ places in 2 MB.
    const wide = counting(cellsOf(spannedTable(1_000, 100)));
    expect(refusal(() => toRows(wide.list, 100 * 100 + 1, reader, 1))).toBe(
      TABLE_TOO_LARGE,
    );
    expect(wide.reads()).toBe(0);
    // Within the columns, 55 rows (one band) lay out: the 56th passes 50,000 places.
    const spanned = counting(cellsOf(spannedTable(10, 9)));
    expect(refusal(() => toRows(spanned.list, 901, reader, 1))).toBe(
      TABLE_TOO_LARGE,
    );
    expect(spanned.reads()).toBeLessThanOrEqual(10 + 55);
  });
});

describe('the schema and the structure check (#686)', () => {
  it('refuse a table past the caps with table-too-large, the structure check reading no row', () => {
    for (const table of [
      plainTable(MAX_TABLE_COLUMNS + 1, 1),
      plainTable(MAX_TABLE_COLUMNS, 51),
    ]) {
      const result = Module.safeParse(moduleWith(table));
      expect(result.success).toBe(false);
      const coded = result.error?.issues.filter(
        (issue) =>
          issue.code === 'custom' && issue.params?.['code'] === TABLE_TOO_LARGE,
      );
      expect(coded?.map((i) => i.path)).toEqual([['blocks', 1]]);
      const rows = countingRows(table);
      checkStructure([rows.table]);
      expect(rows.reads()).toBe(0);
    }
  });

  it('refuse few cells spanning a large area, the structure check reading no row', () => {
    const table = spannedTable(10, 9);
    const result = Module.safeParse(moduleWith(table));
    expect(
      result.error?.issues.some(
        (issue) =>
          issue.code === 'custom' && issue.params?.['code'] === TABLE_TOO_LARGE,
      ),
    ).toBe(true);
    const rows = countingRows(table);
    checkStructure([rows.table]);
    expect(rows.reads()).toBe(0);
  });

  it('take a table at the caps', () => {
    expect(
      Module.safeParse(moduleWith(plainTable(MAX_TABLE_COLUMNS, 50))).success,
    ).toBe(true);
    expect(
      Module.safeParse(moduleWith(plainTable(1, MAX_TABLE_CELLS))).success,
    ).toBe(true);
  });
});

describe('the chunker (#686)', () => {
  it('refuses a table past the caps (already validated content never is)', () => {
    // Its grid was already counted against the expansion limits before it is made (#681).
    const config = ProjectConfig.parse(sampleConfig);
    const module = moduleWith(plainTable(MAX_TABLE_COLUMNS + 1, 3));
    expect(
      refusal(() => toChunks({ module, config, loadModule: () => undefined })),
    ).toBe(TABLE_TOO_LARGE);
  });
});

/**
 * Few cells over a large area, within each table's caps: 101 columns by 400 rows (40,400
 * places) in about 1,600 nodes. Many of them still add up (#686).
 */
const spanned = (id: string) => spannedTable(4, 1, id);
const PLACES = 101 * 400;
const many = (count: number) =>
  Array.from({ length: count }, (_, n) => spanned(`t${n}`));
const moduleOf = (id: string, blocks: unknown[]) => ({
  ...moduleWith(spanned('first'), id),
  blocks,
});

describe('the tables of a module together (#686)', () => {
  // 24 tables fit in MAX_MODULE_TABLE_CELLS, 25 do not.
  const fits = Math.floor(MAX_MODULE_TABLE_CELLS / PLACES);

  it('are refused by the schema past the cap, checking no table’s grid', () => {
    expect(Module.safeParse(moduleOf('m', many(fits))).success).toBe(true);
    const result = Module.safeParse(moduleOf('m', many(fits + 1)));
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => [
        issue.path,
        issue.code === 'custom' ? issue.params?.['code'] : undefined,
      ]),
    ).toEqual([[['blocks'], TABLE_TOO_LARGE]]);
  });

  it('are refused by the parser past the cap, a table’s grid past it at most', () => {
    const print = (count: number) =>
      printModule(moduleOf('m', many(count)) as Module);
    expect(parseModule(print(fits), { id: 'm' }).blocks).toHaveLength(fits);
    expect(refusal(() => parseModule(print(fits + 1), { id: 'm' }))).toBe(
      TABLE_TOO_LARGE,
    );
  });

  it('are counted in a manual once per inclusion, past the cap expansion-too-large', () => {
    expect(MAX_EXPANDED_TABLE_CELLS).toBe(MAX_MODULE_TABLE_CELLS);
    const wide = Module.parse(moduleOf('wide', [spanned('t')]));
    const resolve = (refs: number) => {
      const hub = Module.parse(
        moduleOf(
          'hub',
          Array.from({ length: refs }, (_, n) => ({
            type: 'moduleRef',
            id: `r${n}`,
            module: 'wide',
          })),
        ),
      );
      return resolveManual({
        manifest: Manifest.parse({
          schemaVersion: 1,
          id: 'many',
          title: 'Many',
          variants: [{}],
          entries: [{ module: 'hub' }],
        }),
        variant: {},
        lang: 'en',
        config: ProjectConfig.parse(sampleConfig),
        loadModule: (id) =>
          id === 'wide' ? wide : id === 'hub' ? hub : undefined,
      }).issues.map((issue) => issue.code);
    };
    expect(resolve(fits)).toEqual([]);
    expect(resolve(fits + 1)).toEqual(['expansion-too-large']);
  });

  it('are refused in a page design’s regions too, every slot and language together', () => {
    const design = (count: number) =>
      PageDesign.safeParse({
        schemaVersion: 1,
        id: 'plain',
        name: 'Plain',
        preset: 'classic',
        colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
        regions: {
          back: { en: many(count - 1), de: many(1) },
        },
      });
    expect(design(fits).success).toBe(true);
    const result = design(fits + 1);
    expect(
      result.error?.issues.map((issue) => [
        issue.path,
        issue.code === 'custom' ? issue.params?.['code'] : undefined,
      ]),
    ).toEqual([[['regions'], TABLE_TOO_LARGE]]);
  });
});
