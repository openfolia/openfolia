import type { TranslatedText } from '@openfolia/ui/i18n';
import type { ListFramePage } from '@openfolia/ui/list-frame';

import type { ApiError, Schema } from '../../api';
import { apiErrorText } from '../../i18n';

/** An importer as `GET /importers` lists it, with its options schema and upload limit. */
export type Importer = Schema<'ImporterResource'>;
/** An import as `POST /imports` and `GET /imports/{importId}` answer it. */
export type ImportDoc = Schema<'ImportDocument'>;
export type ImportResource = ImportDoc['data'];
export type ImportReport = Schema<'ImportReport'>;
export type ReportItem = Schema<'ImportReportItem'>;
export type ReportIssue = Schema<'ImportReportIssue'>;
export type ConverterNote = ImportReport['converterReport'][number];
export type ImportProgress = Schema<'ImportProgress'>;
export type ItemResult = ReportItem['action'];

/** The documented import format: offered first, with a link to its guide page. */
export const DOCUMENTED_IMPORTER = 'bundle';

/** The import format's guide page (`frontend/docs`, #57). */
export const FORMAT_ARTICLE = 'guide.integrations.import-format';

/** A stored import's ID (a UUID), as the address names it. */
export const IMPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An importer's ID, as the address names it. */
export const IMPORTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The results, in the order the counts and the filter show them. */
export const ITEM_RESULTS: readonly ItemResult[] = [
  'create',
  'update',
  'skip',
  'refuse',
];

/** A result's word: the badge and the filter say it (a word and an icon, never colour alone). */
export const RESULT_TEXT: Readonly<Record<ItemResult, string>> = {
  create: 'editor.admin.import.result.create',
  update: 'editor.admin.import.result.update',
  skip: 'editor.admin.import.result.skip',
  refuse: 'editor.admin.import.result.refuse',
};

/** An item kind's word. */
export const KIND_TEXT: Readonly<Record<ReportItem['kind'], string>> = {
  module: 'editor.admin.import.kind.module',
  manual: 'editor.admin.import.kind.manual',
  asset: 'editor.admin.import.kind.asset',
};

/** The apply job's phases, as the progress names them. */
export const PHASE_TEXT: Readonly<Record<ImportProgress['phase'], string>> = {
  queued: 'editor.admin.import.progress.phase.queued',
  'change-set': 'editor.admin.import.progress.phase.changeSet',
  assets: 'editor.admin.import.progress.phase.assets',
  files: 'editor.admin.import.progress.phase.files',
  done: 'editor.admin.import.progress.phase.done',
};

/** The report's page sizes; the first is the default. */
export const REPORT_PAGE_SIZES: readonly number[] = [25, 50, 100];

/** The importers in the order offered: the documented format first, then as listed. */
export function orderImporters(
  importers: readonly Importer[],
): readonly Importer[] {
  return [
    ...importers.filter((i) => i.id === DOCUMENTED_IMPORTER),
    ...importers.filter((i) => i.id !== DOCUMENTED_IMPORTER),
  ];
}

/** An item's key: its kind, ID and language (a module's translation is an item of its own). */
export const itemKey = (item: ReportItem): string =>
  `${item.kind}|${item.id}|${item.lang ?? ''}`;

/** The items showing `result` (all for none). */
export function itemsShowing(
  items: readonly ReportItem[],
  result: ItemResult | undefined,
): readonly ReportItem[] {
  return result ? items.filter((i) => i.action === result) : items;
}

/** How many items show `result`. */
export function countOf(report: ImportReport, result: ItemResult): number {
  return report.counts[result];
}

/**
 * One page of `items` (counted from 1), with the paging the list frame shows. A page past the end
 * shows the last one.
 */
export function pageOf<T>(
  items: readonly T[],
  page: number,
  size: number,
): { readonly items: readonly T[]; readonly page: ListFramePage } {
  const lastPage = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), lastPage);
  const start = (current - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: {
      currentPage: current,
      lastPage,
      perPage: size,
      total: items.length,
    },
  };
}

/**
 * The converter's notes about an item: those naming the module it became (a module), or its ID in
 * the source system.
 */
export function notesFor(
  report: ImportReport,
  item: ReportItem,
): readonly ConverterNote[] {
  if (item.kind === 'asset') return [];
  return report.converterReport.filter(
    (note) =>
      (item.kind === 'module' && note.module === item.id) ||
      (item.sourceId !== undefined && note.sourceId === item.sourceId),
  );
}

/** The converter's notes that belong to no item (a source page not converted at all). */
export function looseNotes(report: ImportReport): readonly ConverterNote[] {
  const modules = new Set(
    report.items.filter((i) => i.kind === 'module').map((i) => i.id),
  );
  const sources = new Set(
    report.items.flatMap((i) => (i.sourceId === undefined ? [] : [i.sourceId])),
  );
  return report.converterReport.filter(
    (note) =>
      !(note.module !== undefined && modules.has(note.module)) &&
      !sources.has(note.sourceId),
  );
}

/** The bundle's own errors (not an item's): an import with one cannot be applied in part. */
export const bundleErrors = (report: ImportReport): readonly ReportIssue[] =>
  report.issues.filter((i) => i.severity === 'error');

/** The items the import writes: created or updated. */
export const writtenCount = (report: ImportReport): number =>
  report.counts.create + report.counts.update;

/** A share done, in whole percent (0 when there is nothing to do). */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/** The apply job's progress as one share: files uploaded, then working copies saved. */
export function applyPercent(progress: ImportProgress): number {
  if (progress.phase === 'done') return 100;
  const total = progress.assets.total + progress.files.total;
  return percentOf(progress.assets.done + progress.files.done, total);
}

/** The stored import is past its expiry (an hour after its upload) and was never applied. */
export function expired(resource: ImportResource, now: number): boolean {
  return (
    resource.attributes.state === 'validated' &&
    Date.parse(resource.attributes.expiresAt) <= now
  );
}

/** The change set an import writes into, once its job made it. */
export const changeSetOf = (resource: ImportResource): string | null =>
  resource.relationships?.changeSet.data?.id ?? null;

/** A file the importer takes: a ZIP, by its name (the server reads the bytes). */
export const ACCEPTED_FILES = '.zip,application/zip';

/** Codes of the import routes with a text of their own. */
const IMPORT_ERRORS: Readonly<Record<string, string>> = {
  'too-large': 'editor.admin.import.error.tooLarge',
  'invalid-archive': 'editor.admin.import.error.invalidArchive',
  'import-too-large': 'editor.admin.import.error.importTooLarge',
  'unknown-importer': 'editor.admin.import.error.unknownImporter',
  'invalid-options': 'editor.admin.import.error.invalidOptions',
  'invalid-base': 'editor.admin.import.error.invalidBase',
  'import-busy': 'editor.admin.import.error.busy',
  'upload-interrupted': 'editor.admin.import.error.interrupted',
  'import-expired': 'editor.admin.import.error.expired',
  'import-not-applicable': 'editor.admin.import.error.notApplicable',
};

/** The text for a failed import request: the import's own codes, else the general one. */
export function importErrorText(error: ApiError): TranslatedText {
  const key = Object.hasOwn(IMPORT_ERRORS, error.code)
    ? IMPORT_ERRORS[error.code]
    : undefined;
  if (!key) return apiErrorText(error);
  const meta = error.errors[0]?.meta ?? {};
  const max = typeof meta['max'] === 'number' ? meta['max'] : 0;
  return { key, params: { max: megabytes(max) } };
}

/** Codes a failed apply job names (`meta.failure.code`) with a text of their own. */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'import-outdated': 'editor.admin.import.failure.outdated',
  locked: 'editor.admin.import.failure.locked',
  'importer-gone': 'editor.admin.import.failure.importerGone',
  forbidden: 'editor.admin.import.failure.forbidden',
  'upload-missing': 'editor.admin.import.failure.uploadMissing',
};

/** Why an apply job failed, in words. */
export function failureText(code: string): string {
  return (
    (Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code] : undefined) ??
    'editor.admin.import.failure.other'
  );
}

/** Bytes as mebibytes, at most one decimal (the size limit, a file's size). */
export function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
