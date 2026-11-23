import {
  ConfigParseError,
  ManifestParseError,
  PageDesignParseError,
  parseConfig,
  parseManifest,
  parsePageDesign,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allowsAllIn, allowsManual } from '../../access/core/allows.js';
import { UnprocessableError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  type BranchChange,
  subjectIdForMessage,
  subjectOfPath,
  subjectPath,
} from './commit.js';
import { type LockSubject, type SubjectOf, subjectKey } from './lock.js';

/**
 * A subject whose file carries a translation record of its own: a page design, a manifest, the
 * configuration (its labels, #731).
 */
export type RecordSubject =
  SubjectOf<'design'> | SubjectOf<'manual'> | SubjectOf<'config'>;

/** What the rule reads of a design, a manifest or the configuration: its record, and a manifest's audience. */
export interface RecordHolder {
  readonly translations?: Readonly<Record<string, unknown>>;
  readonly audience?: string;
}

/**
 * Where a write's record is compared: the branch head it is written on, and the commits whose
 * entries anyone may put back (`changeSetRecordBases`: the change set's base commit and, while
 * an update from the base reports the subject conflicting, the base branch's head now), asked for only
 * when needed; one that cannot be opened is left out.
 */
export interface RecordSides {
  readonly head: ReadableContent;
  readonly bases: () => Promise<readonly ReadableContent[]>;
}

/** Whether the subject's file carries its own translation record (`translations`). */
export function holdsRecord(subject: LockSubject): subject is RecordSubject {
  return (
    subject.type === 'design' ||
    subject.type === 'manual' ||
    subject.type === 'config'
  );
}

/**
 * The record and audience of the subject's file at `snapshot`, read past the reading filter;
 * undefined when there is no file, or one that does not read as a design, manifest or
 * configuration (it then holds no record anything reads).
 */
export async function recordAt(
  snapshot: ReadableContent,
  subject: RecordSubject,
): Promise<RecordHolder | undefined> {
  const bytes = await snapshot.sourceForCheck(subjectPath(subject));
  return bytes === undefined
    ? undefined
    : recordOfText(subject, new TextDecoder().decode(bytes));
}

/** `recordAt` for a file's text. */
function recordOfText(
  subject: RecordSubject,
  text: string,
): RecordHolder | undefined {
  try {
    switch (subject.type) {
      case 'design':
        return parsePageDesign(text, { id: subject.designId });
      case 'manual':
        return parseManifest(text, { id: subject.manualId });
      case 'config':
        return parseConfig(text);
    }
  } catch (error) {
    if (
      error instanceof PageDesignParseError ||
      error instanceof ManifestParseError ||
      error instanceof ConfigParseError
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The languages of `next`'s record (#663) that `actor` may not write: a design's, a
 * manifest's or the configuration's (#731) translation record (`translations`) tells the
 * translation status which source text each translation was made from, so only the
 * translation's manager changes it (the XLIFF import, marking a translation current). A
 * language's entry, added, changed or removed, is `actor`'s to write when they hold
 * `translation.manage` for that language (for a design or the configuration in a role
 * restricting nothing but languages, `managesDesignIn`, `managesConfigIn`; for a manual in one
 * covering its audience, as committed and as written, `managesManualIn`). Anyone else keeps
 * it as the branch head has it, or takes it as the change set's base commit has it (taking a
 * change back out) or, while an update from the base reports the subject conflicting, as the
 * base branch's head has it now (resolving that conflict; the update then moves the base
 * commit there): no record that none of them holds. `next` undefined: a file that does not read
 * as one (no record). A deleted file is not asked about: its record goes with it.
 */
export async function refusedRecordLanguages(
  actor: Actor,
  subject: RecordSubject,
  next: RecordHolder | undefined,
  sides: RecordSides,
): Promise<string[]> {
  return refusedFrom(
    actor,
    subject,
    await recordAt(sides.head, subject),
    next,
    sides,
  );
}

/**
 * `refusedRecordLanguages` against `head`, the record as committed (undefined: none), the
 * configuration read at `sides.head`.
 */
async function refusedFrom(
  actor: Actor,
  subject: RecordSubject,
  head: RecordHolder | undefined,
  next: RecordHolder | undefined,
  sides: RecordSides,
): Promise<string[]> {
  const changed = changedLanguages(head?.translations, next?.translations);
  if (changed.length === 0) return [];
  const manages = await managing(actor, subject, sides.head, [head, next]);
  let refused = changed.filter((lang) => !manages(lang));
  if (refused.length === 0) return [];
  // A base that cannot be opened puts nothing back.
  for (const opened of await sides.bases()) {
    if (refused.length === 0) break;
    const base = await recordAt(opened, subject);
    refused = refused.filter(
      (lang) =>
        !sameEntry(
          entryOf(base?.translations, lang),
          entryOf(next?.translations, lang),
        ),
    );
  }
  return refused.sort();
}

/** 422 `translation-record-protected` unless `actor` may write `next`'s record (`refusedRecordLanguages`). */
export async function refuseRecordChange(
  actor: Actor,
  subject: RecordSubject,
  next: RecordHolder | undefined,
  sides: RecordSides,
): Promise<void> {
  const refused = await refusedRecordLanguages(actor, subject, next, sides);
  if (refused.length > 0) throw recordProtected(subject, refused);
}

/**
 * 422 `translation-record-protected` unless `actor` may write `next`'s record where the
 * change set's base commit could not be opened (`refuseBranchRecords`): every entry counts
 * as changed, so only the languages `actor` manages pass; `config` is read for a manual's
 * audiences.
 */
export async function refuseRecordWithoutBase(
  actor: Actor,
  subject: RecordSubject,
  next: RecordHolder | undefined,
  config: ReadableContent,
): Promise<void> {
  const refused = await refusedFrom(actor, subject, undefined, next, {
    head: config,
    bases: () => Promise.resolve([]),
  });
  if (refused.length > 0) throw recordProtected(subject, refused);
}

/**
 * `refuseRecordChange` for each design or manifest a commit writes (`changes`, against the
 * head it is made on): the one check every commit onto a change set's branch passes
 * (`SavePoints.prepare`), whichever path wrote it.
 */
export async function refuseRecordChanges(
  actor: Actor,
  changes: readonly BranchChange[],
  sides: RecordSides,
): Promise<void> {
  // The bases are opened once for the whole commit.
  const shared = { head: sides.head, bases: once(sides.bases) };
  for (const change of changes) {
    if ('delete' in change) continue;
    const subject = subjectOfPath(change.path);
    if (!subject || !holdsRecord(subject)) continue;
    await refuseRecordChange(
      actor,
      subject,
      recordOfText(subject, change.content),
      shared,
    );
  }
}

/** 422 `translation-record-protected`: the record's entries for `languages` are not the actor's to change. */
export function recordProtected(
  subject: RecordSubject,
  languages: readonly string[],
): UnprocessableError {
  const { type } = subjectKey(subject);
  const id = subjectIdForMessage(subject);
  return new UnprocessableError(
    'translation-record-protected',
    `Only a translation manager of ${languages.join(', ')} changes the translation record of ${type} ${id}; keep \`translations\` as committed.`,
    { subject, languages: [...languages] },
  );
}

/** Whether `actor` manages the subject's translation into a language (`refusedRecordLanguages`). */
async function managing(
  actor: Actor,
  subject: RecordSubject,
  head: ReadableContent,
  versions: readonly (RecordHolder | undefined)[],
): Promise<(lang: string) => boolean> {
  if (subject.type === 'design' || subject.type === 'config') {
    return (lang) => allowsAllIn(actor, 'translation.manage', lang);
  }
  const audiences = (await head.config()).audiences.map((a) => a.id);
  const held = versions.filter((v) => v !== undefined);
  const targets = held.length > 0 ? held : [{}];
  return (lang) =>
    targets.every((manifest) =>
      allowsManual(actor, 'translation.manage', {
        audiences,
        audience: manifest.audience,
        lang,
      }),
    );
}

/** The languages whose entry differs between two records (one left out counts as no entry). */
function changedLanguages(
  before: RecordHolder['translations'],
  after: RecordHolder['translations'],
): string[] {
  const langs = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  return [...langs].filter(
    (lang) => !sameEntry(entryOf(before, lang), entryOf(after, lang)),
  );
}

function entryOf(
  translations: RecordHolder['translations'],
  lang: string,
): unknown {
  return translations !== undefined && Object.hasOwn(translations, lang)
    ? translations[lang]
    : undefined;
}

/** Whether two entries hold the same values (keys in any order). */
function sameEntry(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `load`, called once: later calls answer its first promise. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let found: Promise<T> | undefined;
  return () => (found ??= load());
}
