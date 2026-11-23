import type { TranslatedText } from '@openfolia/ui/i18n';

import type { ApiError, Schema } from '../api';
import { apiErrorText } from '../i18n';
import { diffText, type Segment } from '../review/review-diff';

/** A translation import with one page of its report (`GET /translations/imports/{importId}`). */
export type ImportDoc = Schema<'TranslationImportDocument'>;
export type ImportResource = ImportDoc['data'];
export type ImportCounts = Schema<'TranslationImportCounts'>;
/** One module in one target language of the report. */
export type ReportModule = Schema<'TranslationImportModule'>;
export type ReportUnit = Schema<'TranslationImportUnit'>;
export type UnitState = ReportUnit['state'];
export type Decision = 'keep' | 'skip';

/** The states, in the order the filter offers them. */
export const UNIT_STATES: readonly UnitState[] = [
  'ok',
  'source-changed',
  'broken-markup',
  'unknown-block',
  'unknown-module',
  'outside-scope',
];

/** The states whose units are never imported. */
export const REFUSED_STATES: ReadonlySet<UnitState> = new Set([
  'broken-markup',
  'unknown-block',
  'unknown-module',
  'outside-scope',
]);

/** A state's word: the filter and each unit's badge say it (a word, never colour alone). */
export const UNIT_STATE_TEXT: Readonly<Record<UnitState, string>> = {
  ok: 'editor.translations.importScreen.state.ok',
  'source-changed': 'editor.translations.importScreen.state.sourceChanged',
  'broken-markup': 'editor.translations.importScreen.state.brokenMarkup',
  'unknown-block': 'editor.translations.importScreen.state.unknownBlock',
  'unknown-module': 'editor.translations.importScreen.state.unknownModule',
  'outside-scope': 'editor.translations.importScreen.state.outsideScope',
};

export const UNIT_STATE_BADGE: Readonly<
  Record<UnitState, 'success' | 'warning' | 'destructive' | 'outline'>
> = {
  ok: 'success',
  'source-changed': 'warning',
  'broken-markup': 'destructive',
  'unknown-block': 'destructive',
  'unknown-module': 'outline',
  'outside-scope': 'outline',
};

/** A state's count in `meta.counts`. */
export function countOf(counts: ImportCounts, state: UnitState): number {
  switch (state) {
    case 'ok':
      return counts.ok;
    case 'source-changed':
      return counts.sourceChanged;
    case 'broken-markup':
      return counts.brokenMarkup;
    case 'unknown-block':
      return counts.unknownBlock;
    case 'unknown-module':
      return counts.unknownModule;
    case 'outside-scope':
      return counts.outsideScope;
  }
}

/** The units that can never be imported. */
export const refusedCount = (counts: ImportCounts): number =>
  counts.brokenMarkup +
  counts.unknownBlock +
  counts.unknownModule +
  counts.outsideScope;

/** Why a refused unit is refused, by its stable `reason` (or its state, without one). */
const REASON_TEXT: Readonly<Record<string, string>> = {
  'missing-segment': 'editor.translations.importScreen.reason.missingSegment',
  'extra-segment': 'editor.translations.importScreen.reason.extraSegment',
  'missing-target': 'editor.translations.importScreen.reason.missingTarget',
  'unsupported-markup':
    'editor.translations.importScreen.reason.unsupportedMarkup',
  'unknown-code': 'editor.translations.importScreen.reason.unknownCode',
  'code-mismatch': 'editor.translations.importScreen.reason.codeMismatch',
  'missing-code': 'editor.translations.importScreen.reason.missingCode',
  'extra-code': 'editor.translations.importScreen.reason.extraCode',
  nesting: 'editor.translations.importScreen.reason.nesting',
  'line-break': 'editor.translations.importScreen.reason.lineBreak',
  empty: 'editor.translations.importScreen.reason.empty',
  'invalid-content': 'editor.translations.importScreen.reason.invalidContent',
  'source-hash': 'editor.translations.importScreen.reason.sourceHash',
  'not-sent': 'editor.translations.importScreen.reason.notSent',
  removed: 'editor.translations.importScreen.reason.removed',
};

const STATE_REASON_TEXT: Readonly<Partial<Record<UnitState, string>>> = {
  'broken-markup': 'editor.translations.importScreen.reason.brokenMarkup',
  'unknown-block': 'editor.translations.importScreen.reason.unknownBlock',
  'unknown-module': 'editor.translations.importScreen.reason.unknownModule',
  'outside-scope': 'editor.translations.importScreen.reason.outsideScope',
};

/** What the person reads about a refused unit; null for one that goes in. */
export function reasonText(unit: ReportUnit): string | null {
  if (!REFUSED_STATES.has(unit.state)) return null;
  const byReason =
    unit.reason !== undefined && Object.hasOwn(REASON_TEXT, unit.reason)
      ? REASON_TEXT[unit.reason]
      : undefined;
  return byReason ?? STATE_REASON_TEXT[unit.state] ?? null;
}

/** One unit's key in the decisions: its language, module and block. */
export const unitKey = (lang: string, moduleId: string, blockId: string) =>
  `${lang}/${moduleId}/${blockId}`;

/**
 * The decisions on the `source-changed` units: `all` for each, but those in `except`, which take
 * the other. "Keep all" and "Skip all" set `all` and clear `except`, so they hold for the units
 * of every page, also those not read yet. `keep` is the default (#240): imported, still outdated.
 */
export interface Decisions {
  readonly all: Decision;
  readonly except: ReadonlySet<string>;
}

export const KEEP_ALL: Decisions = { all: 'keep', except: new Set() };

export const decisionOf = (decisions: Decisions, key: string): Decision =>
  decisions.except.has(key)
    ? decisions.all === 'keep'
      ? 'skip'
      : 'keep'
    : decisions.all;

/** `decisions` with the unit `key` decided `decision`. */
export function decide(
  decisions: Decisions,
  key: string,
  decision: Decision,
): Decisions {
  const except = new Set(decisions.except);
  if (decision === decisions.all) except.delete(key);
  else except.add(key);
  return { all: decisions.all, except };
}

/** How many `source-changed` units are skipped. */
export const skippedCount = (
  decisions: Decisions,
  sourceChanged: number,
): number =>
  decisions.all === 'keep'
    ? decisions.except.size
    : sourceChanged - decisions.except.size;

/** How many units an apply would import now: the `ok` ones and the changed ones kept. */
export const importCount = (
  counts: ImportCounts,
  decisions: Decisions,
): number =>
  counts.ok +
  counts.sourceChanged -
  skippedCount(decisions, counts.sourceChanged);

/** A `source-changed` unit as the apply names it. */
export interface ChangedUnit {
  readonly lang: string;
  readonly moduleId: string;
  readonly blockId: string;
}

/**
 * The apply's `meta.decisions`: a `skip` for each unit skipped (`keep` is the API's default).
 * With "Skip all", `changed` (every `source-changed` unit of the report) names them.
 */
export function decisionsBody(
  decisions: Decisions,
  changed: readonly ChangedUnit[],
): { lang: string; moduleId: string; blockId: string; decision: 'skip' }[] {
  const skipped =
    decisions.all === 'keep'
      ? changed.filter((u) =>
          decisions.except.has(unitKey(u.lang, u.moduleId, u.blockId)),
        )
      : changed.filter(
          (u) => !decisions.except.has(unitKey(u.lang, u.moduleId, u.blockId)),
        );
  return skipped.map((u) => ({ ...u, decision: 'skip' as const }));
}

/** The `source-changed` units of report pages. */
export function changedUnits(modules: readonly ReportModule[]): ChangedUnit[] {
  return modules.flatMap((m) =>
    m.units
      .filter((u) => u.state === 'source-changed')
      .map((u) => ({ lang: m.lang, moduleId: m.moduleId, blockId: u.blockId })),
  );
}

/** The old and the new source, each with its own marks: what was deleted, what was inserted. */
export function sourceSides(
  exported: string,
  current: string,
): { readonly before: Segment[]; readonly after: Segment[] } {
  const segments = diffText(exported, current);
  return {
    before: segments.filter((s) => s.op !== 'ins'),
    after: segments.filter((s) => s.op !== 'del'),
  };
}

/** A report row's key (a module in one language): the list frame tracks rows by it. */
export const moduleKey = (m: ReportModule): string => `${m.lang}/${m.moduleId}`;

/** The import is the validation of an upload, kept until `expiresAt`. */
export const expired = (resource: ImportResource, now: number): boolean =>
  resource.attributes.state === 'validated' &&
  Date.parse(resource.attributes.expiresAt) <= now;

/** An import ID as the API makes them (a UUID). */
export const IMPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const REPORT_PAGE_SIZES = [10, 25, 50] as const;

/** An upload's name says it is one the import reads: an XLIFF document, a ZIP of them or a COTI package (#140). */
export const ACCEPTED_FILES = '.xlf,.xliff,.zip,.coti';
export const acceptedFile = (name: string): boolean =>
  /\.(xlf|xliff|zip|coti)$/i.test(name);

/**
 * The import's own refusals, by code: a whole document's XML (`xliff-…`), and what only an
 * import answers. Kept with the import screen, not in the shared error texts.
 */
const IMPORT_ERRORS: Readonly<Record<string, string>> = {
  'xliff-dtd-forbidden':
    'editor.translations.importScreen.fileError.dtdForbidden',
  'xliff-not-well-formed':
    'editor.translations.importScreen.fileError.notWellFormed',
  'xliff-too-large': 'editor.translations.importScreen.fileError.tooLarge',
  'xliff-too-deep': 'editor.translations.importScreen.fileError.tooComplex',
  'xliff-too-many-nodes':
    'editor.translations.importScreen.fileError.tooComplex',
  'xliff-too-many-attributes':
    'editor.translations.importScreen.fileError.tooComplex',
  'xliff-unsupported-encoding':
    'editor.translations.importScreen.fileError.encoding',
  'unknown-job': 'editor.translations.importScreen.error.unknownJob',
  'mixed-jobs': 'editor.translations.importScreen.error.mixedJobs',
  'duplicate-language':
    'editor.translations.importScreen.error.duplicateLanguage',
  'language-mismatch':
    'editor.translations.importScreen.error.languageMismatch',
  'job-not-open': 'editor.translations.importScreen.error.jobNotOpen',
  'no-xliff': 'editor.translations.importScreen.error.noXliff',
  'not-xliff': 'editor.translations.importScreen.error.notXliff',
  'invalid-xliff': 'editor.translations.importScreen.error.invalidXliff',
  'import-busy': 'editor.translations.importScreen.error.importBusy',
  'too-many-imports': 'editor.translations.importScreen.error.tooManyImports',
  'nothing-to-import': 'editor.translations.importScreen.error.nothingToImport',
  'invalid-base': 'editor.translations.importScreen.error.invalidBase',
  'invalid-archive': 'editor.translations.importScreen.error.invalidArchive',
  'invalid-coti': 'editor.translations.importScreen.error.invalidCoti',
  'coti-job-mismatch': 'editor.translations.importScreen.error.cotiJobMismatch',
  'unreadable-translation':
    'editor.translations.importScreen.error.unreadableTranslation',
  'source-moved': 'editor.translations.importScreen.error.sourceMoved',
};

/** Why an upload or an apply failed, as the person reads it. */
export function importErrorText(error: ApiError): TranslatedText {
  const key = Object.hasOwn(IMPORT_ERRORS, error.code)
    ? IMPORT_ERRORS[error.code]
    : error.code.startsWith('xliff-')
      ? 'editor.translations.importScreen.fileError.invalid'
      : undefined;
  return key ? { key, params: {} } : apiErrorText(error);
}
