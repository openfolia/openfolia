import type { ExchangeEnvelope } from './translation-exchange.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import {
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';

/**
 * What the import makes of one unit (a block of a module, in one target
 * language) of an uploaded XLIFF:
 *
 * - `ok`: its target is read and its source has not changed since export;
 * - `source-changed`: the same, but the source block changed since it was
 *   exported (its hash at the base is not the one sent): imported only
 *   with the decision `keep` (the default), and then still `outdated`;
 * - `broken-markup`: its target's inline codes do not match its source
 *   (`reason`: a `TargetRefusal`, or `source-hash` for a unit whose
 *   `ccms:sourceHash` is not the one exported); refused, alone;
 * - `unknown-block`: the job sent no such block of the module in that
 *   language, or the source has it no longer;
 * - `unknown-module`: no such module that the importer may read (at the
 *   base, or at the job's commit);
 * - `outside-scope`: a module the importer reads but does not manage
 *   translations of in that language, or whose translation there they may
 *   not see; told like a missing module, with nothing more about it.
 */
export const IMPORT_UNIT_STATES = [
  'ok',
  'source-changed',
  'broken-markup',
  'unknown-block',
  'unknown-module',
  'outside-scope',
] as const;
export type ImportUnitState = (typeof IMPORT_UNIT_STATES)[number];

/** What becomes of a `source-changed` unit: imported (still outdated), or left out. */
export const SOURCE_CHANGED_DECISIONS = ['keep', 'skip'] as const;
export type SourceChangedDecision = (typeof SOURCE_CHANGED_DECISIONS)[number];

/**
 * The texts a person decides a `source-changed` unit on, as plain text
 * (each part on a line of its own), each cut at `MAX_UNIT_TEXT_LENGTH`
 * characters (`truncated`).
 */
export interface SourceChangedTexts {
  /** The source as the job sent it (at the job's commit). */
  readonly exported: string;
  /** The source on the base now. */
  readonly current: string;
  /** The uploaded translation. */
  readonly target: string;
  /** One of them was cut. */
  readonly truncated: boolean;
}

/** The longest text of a unit kept in a report (`SourceChangedTexts`). */
export const MAX_UNIT_TEXT_LENGTH = 2000;

/**
 * The most characters of texts one report keeps (`SourceChangedTexts`):
 * past it, a `source-changed` unit has none (the screen says so).
 */
export const MAX_REPORT_TEXT_CHARACTERS = 4 * 1024 * 1024;

/** One unit of the report. */
export interface ImportUnitReport {
  readonly blockId: string;
  readonly state: ImportUnitState;
  /**
   * What the unit is: its block's type, or `item` for a list item or
   * procedure step; where the job sent it (not for `unknown-module`,
   * `outside-scope` or a block not sent).
   */
  readonly kind?: string;
  /** Why it is refused (`broken-markup`, `unknown-block`); a stable code. */
  readonly reason?: string;
  /** What is wrong, for a person. */
  readonly detail?: string;
  /** `source-changed` only: what the decision is made on, while the report's budget lasts. */
  readonly texts?: SourceChangedTexts;
}

/** The report of one module in one target language. */
export interface ImportModuleReport {
  readonly lang: string;
  /**
   * The document's `<file id>`: a module's ID, a page design's key (`designKey`, #568), a
   * manual's (`manualKey`, #656) or the project labels' (`config.project`, #731).
   */
  readonly moduleId: string;
  /** A page design's region text (#568): the design. */
  readonly designId?: string;
  /** A manual's own text (#656, its cover images' alternative text): the manual. */
  readonly manualId?: string;
  /** The project labels (#731): `moduleId` is `config.project`. */
  readonly config?: true;
  /** The source module's title on the base; not for `unknown-module` or `outside-scope`. */
  readonly title?: string;
  readonly units: readonly ImportUnitReport[];
}

export type ImportCounts = Readonly<
  Record<ImportUnitState, number> & { readonly units: number }
>;

/**
 * Where a stored import stands: `validated` (checked, kept to be applied
 * within the hour), `applying` (its apply runs now) or `applied` (its
 * change set is made).
 */
export const TRANSLATION_IMPORT_STATES = [
  'validated',
  'applying',
  'applied',
] as const;
export type TranslationImportState = (typeof TRANSLATION_IMPORT_STATES)[number];

/** An uploaded XLIFF document, kept as text so applying reads it again. */
export interface ImportDocument {
  /** Its path in the uploaded ZIP; undefined for a plain XLIFF upload. */
  readonly path?: string;
  readonly xliff: string;
  /**
   * What the package it came in says of it (#140, a COTI package's project description): its job
   * and languages, which the document must match. Undefined for a plain XLIFF or ZIP.
   */
  readonly envelope?: ExchangeEnvelope;
}

/**
 * A translation import (#51): one upload (an XLIFF document, or a ZIP of
 * them, one per target language) of a translation job, checked against a
 * base branch.
 */
export interface TranslationImport {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  readonly jobId: string;
  /** The documents' target languages, in the job's order. */
  readonly languages: readonly string[];
  /** The branch it is checked against and goes into (a change set from it). */
  readonly baseRef: string;
  /** That branch's commit when it was checked. */
  readonly baseCommit: string;
  readonly state: TranslationImportState;
  readonly createdBy: ChangeSetAuthor;
  readonly createdAt: Date;
  /** When it is removed, unless applied: an hour after its upload. */
  readonly expiresAt: Date;
  readonly counts: ImportCounts;
  /** Per module and language: the languages in the job's order, then module IDs. */
  readonly modules: readonly ImportModuleReport[];
  /** Once applied: its change set and the save point's commit (null when nothing changed). */
  readonly changeSetId?: string;
  readonly commit?: string | null;
}

/** How long a validated import is kept to be applied. */
export const TRANSLATION_IMPORT_TTL_MS = 60 * 60 * 1000;

export const newTranslationImportId = newChangeSetId;
export const isTranslationImportId = isChangeSetId;

/**
 * The report with only the units in `state` (modules without one left
 * out), or the whole report when `state` is undefined.
 */
export function reportWith(
  modules: readonly ImportModuleReport[],
  state: ImportUnitState | undefined,
): readonly ImportModuleReport[] {
  if (state === undefined) return modules;
  return modules.flatMap((m) => {
    const units = m.units.filter((u) => u.state === state);
    return units.length === 0 ? [] : [{ ...m, units }];
  });
}

/** The characters of a report's texts (`SourceChangedTexts`). */
export function reportTextLength(
  modules: readonly ImportModuleReport[],
): number {
  let n = 0;
  for (const { units } of modules) {
    for (const { texts } of units) {
      if (texts) {
        n += texts.exported.length + texts.current.length + texts.target.length;
      }
    }
  }
  return n;
}

/** The counts of a report. */
export function countReport(
  modules: readonly ImportModuleReport[],
): ImportCounts {
  const counts: Record<ImportUnitState, number> & { units: number } = {
    units: 0,
    ok: 0,
    'source-changed': 0,
    'broken-markup': 0,
    'unknown-block': 0,
    'unknown-module': 0,
    'outside-scope': 0,
  };
  for (const { units } of modules) {
    for (const { state } of units) {
      counts.units++;
      counts[state]++;
    }
  }
  return counts;
}
