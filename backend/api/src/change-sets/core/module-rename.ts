import {
  type Manifest,
  manifestNamesModule,
  type Module,
  namesModule,
  parseTranslationRecord,
  printTranslationRecord,
  renameModuleReferences,
  renameReplacement,
  replacementNamesModule,
  sourceHashes,
  TranslationRecordParseError,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { bySubjectKey } from './commit.js';
import type { LockSubject, SubjectOf } from './lock.js';
import { checkCommittedScope } from './subject-scope.js';

type ModuleSubject = SubjectOf<'module'>;
type ManualSubject = SubjectOf<'manual'>;

/**
 * One answer for every refusal of a rename on scope, whatever the reason
 * (the module in a language, a module or manual naming it, or the new ID,
 * hidden or not editable): an actor learns nothing about what they may not
 * see, not even which kind of file it was.
 */
export const RENAME_OUTSIDE_EDIT =
  'The rename touches content outside what your roles may edit: the module in one of its languages, a manual or module that names it, or the new ID.';

/** A file the rename rewrites because it names the module. */
export type Reference =
  | {
      readonly subject: ModuleSubject;
      readonly module: Module;
      /**
       * Whether its deprecation names the module as its replacement
       * (`replacedBy`, #360): only a source-language file's, which is where
       * a module's deprecation lives.
       */
      readonly replaces: boolean;
    }
  | { readonly subject: ManualSubject; readonly manifest: Manifest };

/** What renaming module `from` touches at a commit, checked against the actor's scope. */
export interface RenameScope {
  readonly from: string;
  /** The module's files by language (a broken one `'unreadable'`), in the repository's order. */
  readonly files: ReadonlyMap<string, Module | 'unreadable'>;
  /**
   * The other modules (each language a file of its own) and the manuals
   * whose module references, cross-references or entries name it, and the
   * other modules whose source-language file is deprecated in favour of it
   * (`replacedBy`, #360), in subject-key order. A manual's `replacedBy`
   * names a manual, never a module, so no manual is here for that. A
   * file that cannot be read is not among them: what it names is unknown.
   */
  readonly references: readonly Reference[];
  /** The languages module `to` has a file in already (only when `to` was given). */
  readonly taken: readonly string[];
}

/**
 * What renaming module `from` (to `to`, when given) touches at `head`,
 * read past the reading filter (`everythingForCheck`), so a hidden file is
 * checked, never skipped, and checked against the actor's scope with one
 * 403 whatever the reason (`RENAME_OUTSIDE_EDIT`): every language of the
 * module and every file naming it as for changing it
 * (`checkCommittedScope`), and, with `to`, the new ID in every configured
 * language (and any other it has a file in), as for a module with nothing
 * committed (an author who edits and reads all of the language) or a
 * committed one. Every language, not only the module's: which languages
 * the check covered would otherwise depend on where a hidden module at the
 * new ID has a file, and a 403 against a `lock-required` would tell it. So
 * a hidden module at the new ID is refused like any other out of reach,
 * before `id-taken` could say it exists.
 *
 * A module with no file in any language is 404, only for an actor who
 * edits and reads all of every configured language (anyone else gets the
 * 403 a hidden one would); with `to`, a new ID that has a file is 409
 * `id-taken`.
 */
export async function renameScope(
  actor: Actor,
  head: ReadableContent,
  from: string,
  to?: string,
): Promise<RenameScope> {
  const files = new Map<string, Module | 'unreadable'>();
  const taken: string[] = [];
  const references: Reference[] = [];
  const { languages } = await head.config();
  for await (const file of head.everythingForCheck()) {
    if (file.kind === 'module') {
      if (file.id === from) files.set(file.lang, file.module);
      else if (file.id === to) taken.push(file.lang);
      else if (file.module !== 'unreadable') {
        const replaces =
          file.lang === languages.source &&
          replacementNamesModule(file.module, from);
        if (replaces || namesModule(file.module, from)) {
          references.push({
            subject: { type: 'module', lang: file.lang, moduleId: file.id },
            module: file.module,
            replaces,
          });
        }
      }
    } else if (
      file.kind === 'manual' &&
      file.manifest !== 'unreadable' &&
      manifestNamesModule(file.manifest, from)
    ) {
      references.push({
        subject: { type: 'manual', manualId: file.id },
        manifest: file.manifest,
      });
    }
  }
  if (files.size === 0) {
    for (const lang of [languages.source, ...languages.targets]) {
      await scoped(actor, head, { type: 'module', lang, moduleId: from });
    }
    throw new NotFoundError(`No module "${from}".`);
  }
  for (const lang of files.keys()) {
    await scoped(actor, head, { type: 'module', lang, moduleId: from });
  }
  for (const { subject } of references) await scoped(actor, head, subject);
  if (to !== undefined) {
    for (const lang of new Set([
      languages.source,
      ...languages.targets,
      ...files.keys(),
      ...taken,
    ])) {
      await scoped(actor, head, { type: 'module', lang, moduleId: to });
    }
    if (taken.length > 0) {
      throw new ConflictError('id-taken', `A module "${to}" exists already.`, {
        moduleId: to,
      });
    }
  }
  return {
    from,
    files,
    references: references.sort((a, b) => bySubjectKey(a.subject, b.subject)),
    taken,
  };
}

/** `checkCommittedScope`, its refusal the rename's one answer. */
async function scoped(
  actor: Actor,
  head: ReadableContent,
  subject: LockSubject,
): Promise<void> {
  try {
    await checkCommittedScope(actor, head, subject);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new ForbiddenError(RENAME_OUTSIDE_EDIT);
    }
    throw error;
  }
}

/** The module's subjects under `id`, one per language of `scope`. */
export function moduleSubjects(
  scope: RenameScope,
  id: string,
): ModuleSubject[] {
  return [...scope.files.keys()]
    .map((lang): ModuleSubject => ({ type: 'module', lang, moduleId: id }))
    .sort(bySubjectKey);
}

/**
 * A module file with every name of `from` naming `to` instead: its module
 * references and cross-references, and, when `replaces` (its
 * source-language file, #360), its deprecation's `replacedBy`.
 */
export function rewrittenModule(
  module: Module,
  from: string,
  to: string,
  replaces: boolean,
): Module {
  const renamed = renameModuleReferences(module, from, to);
  return replaces ? renameReplacement(renamed, from, to) : renamed;
}

/** A module's translation record, which moves with it. */
export const recordPath = (lang: string, id: string): string =>
  `modules/${lang}/${id}.translation.yaml`;

/** A target-language translation record a rename rewrites, and whose module it is. */
export interface RecordRewrite {
  /** The module the record belongs to, in the record's language: locked like a file rewritten. */
  readonly subject: ModuleSubject;
  readonly path: string;
  /** The record's text with the new hashes. */
  readonly content: string;
}

/**
 * The translation records of the modules naming `scope.from` that a rename
 * (to `to`) rewrites (#354): rewriting a cross-reference changes the source
 * hash of the block holding it (an `xref` is part of its unit's content),
 * though its text did not change, so each target-language record of a
 * source-language module rewritten takes the new hash wherever it held the
 * old one, and a translation up to date stays so. Only records that change.
 * Each record's module (in the record's language) is checked against the
 * actor's scope like any file the rename rewrites (one 403), and the
 * caller locks it and refuses its working copy. A record that cannot be
 * read (not UTF-8, not a record), or whose module has no file in its
 * language, is left as it is.
 *
 * Without `to` (the plan read before a rename): any other ID, since which
 * blocks change does not depend on what the new ID is, only that it is
 * another.
 */
export async function recordRewrites(
  actor: Actor,
  head: ReadableContent,
  scope: RenameScope,
  to = `${scope.from}-x`,
): Promise<RecordRewrite[]> {
  const { languages } = await head.config();
  const rewrites: RecordRewrite[] = [];
  for (const reference of scope.references) {
    if (!('module' in reference)) continue;
    if (reference.subject.lang !== languages.source) continue;
    // Named only as its replacement (#360): no block of it changes.
    if (!namesModule(reference.module, scope.from)) continue;
    const hashes = rehash(
      reference.module,
      renameModuleReferences(reference.module, scope.from, to),
    );
    const id = reference.subject.moduleId;
    for (const lang of languages.targets) {
      const path = recordPath(lang, id);
      // A record left behind by a translation deleted since (#287) belongs
      // to no module: nothing reads it, and it is not touched.
      if (
        (await head.sourceForCheck(`modules/${lang}/${id}.adoc`)) === undefined
      ) {
        continue;
      }
      const bytes = await head.sourceForCheck(path);
      if (bytes === undefined) continue;
      // Checked wherever the translation has a record, before what it
      // holds is looked at: whether a refusal comes then never depends on
      // the hashes of a record the actor may not read.
      const subject: ModuleSubject = { type: 'module', lang, moduleId: id };
      await scoped(actor, head, subject);
      const before = decoded(bytes);
      if (before === undefined) continue;
      const after = rehashRecord(before, hashes);
      if (after === before) continue;
      rewrites.push({ subject, path, content: after });
    }
  }
  return rewrites.sort((a, b) => bySubjectKey(a.subject, b.subject));
}

/** A source module's block hashes before and after its references were rewritten. */
export interface Rehash {
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
}

export function rehash(before: Module, after: Module): Rehash {
  return { before: sourceHashes(before), after: sourceHashes(after) };
}

/**
 * A translation record's text with each block that was translated from
 * the source as it was (its hash the old one) given the new hash, the rest
 * kept; a record that cannot be read is kept as it is.
 */
export function rehashRecord(text: string, { before, after }: Rehash): string {
  let record;
  try {
    record = parseTranslationRecord(text);
  } catch (error) {
    if (error instanceof TranslationRecordParseError) return text;
    throw error;
  }
  let changed = false;
  const blocks = { ...record.blocks };
  for (const [id, hash] of Object.entries(blocks)) {
    const next = after.get(id);
    if (hash === before.get(id) && next !== undefined && next !== hash) {
      blocks[id] = next;
      changed = true;
    }
  }
  return changed ? printTranslationRecord({ ...record, blocks }) : text;
}

/** UTF-8 exactly (a byte-order mark kept), or undefined. */
function decoded(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
}

/** A file's bytes as text, exactly: a byte-order mark kept, bad UTF-8 refused. */
export async function textOf(
  head: ReadableContent,
  path: string,
): Promise<string> {
  const bytes = await head.sourceForCheck(path);
  if (bytes === undefined) {
    throw new Error(`${path} went missing while it was read.`);
  }
  const text = decoded(bytes);
  if (text === undefined) {
    throw new UnprocessableError(
      'not-renamable',
      `${path} is not UTF-8 text, so it cannot be moved.`,
      { path },
    );
  }
  return text;
}
