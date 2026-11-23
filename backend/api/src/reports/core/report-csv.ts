import { csvCell } from '@openfolia/content-model';
import type { ModuleUsageRow } from './module-usage-report.js';
import { percentOf, type TranslationCoverage } from './translation-coverage.js';

/** The columns of the translation report's CSV, in order. */
export const COVERAGE_CSV_COLUMNS = [
  'manual',
  'title',
  'language',
  'deprecated',
  'modules',
  'modules up to date',
  'modules outdated',
  'modules at provider',
  'modules missing',
  'percent up to date',
  'blocks',
  'blocks up to date',
  'blocks outdated',
  'blocks at provider',
  'blocks missing',
  'percent blocks up to date',
  'design units',
  'design units up to date',
  'design units outdated',
  'design units at provider',
  'design units missing',
  'cover units',
  'cover units up to date',
  'cover units outdated',
  'cover units at provider',
  'cover units missing',
  'label units',
  'label units up to date',
  'label units outdated',
  'label units at provider',
  'label units missing',
] as const;

/** The columns of the module usage report's CSV, in order. */
export const USAGE_CSV_COLUMNS = [
  'module',
  'title',
  'type',
  'deprecated',
  'languages',
  'manuals',
  'modules',
  'used in manuals',
  'used in modules',
] as const;

/**
 * The translation report as CSV (RFC 4180, CRLF, `csvCell`: a value a
 * spreadsheet would run as a formula is quoted with `'`): a header row,
 * then one row per manual and language.
 */
export function coverageCsv(rows: readonly TranslationCoverage[]): string {
  return toCsv(COVERAGE_CSV_COLUMNS, rows, (r) => [
    r.manualId,
    r.title,
    r.lang,
    String(r.deprecated),
    String(r.modules.total),
    String(r.modules.upToDate),
    String(r.modules.outdated),
    String(r.modules.atProvider),
    String(r.modules.missing),
    String(percentOf(r.modules, r.modules.upToDate)),
    String(r.blocks.total),
    String(r.blocks.upToDate),
    String(r.blocks.outdated),
    String(r.blocks.atProvider),
    String(r.blocks.missing),
    String(percentOf(r.blocks, r.blocks.upToDate)),
    ...[r.design, r.cover, r.labels].flatMap((c) => [
      String(c.total),
      String(c.upToDate),
      String(c.outdated),
      String(c.atProvider),
      String(c.missing),
    ]),
  ]);
}

/**
 * The module usage report as CSV, one row per module; the manuals and
 * modules using it are their IDs, one per line in their cell (every one,
 * not only the first 50).
 */
export function usageCsv(rows: readonly ModuleUsageRow[]): string {
  return toCsv(USAGE_CSV_COLUMNS, rows, (r) => [
    r.moduleId,
    r.title,
    r.type,
    String(r.deprecated),
    r.languages.join(' '),
    String(r.manuals),
    String(r.modules),
    r.uses
      .filter((u) => u.kind === 'manual')
      .map((u) => u.id)
      .join('\n'),
    r.uses
      .filter((u) => u.kind === 'module')
      .map((u) => u.id)
      .join('\n'),
  ]);
}

function toCsv<T>(
  columns: readonly string[],
  rows: readonly T[],
  cells: (row: T) => string[],
): string {
  return [columns, ...rows.map(cells)]
    .map((row) => `${row.map(csvCell).join(',')}\r\n`)
    .join('');
}
