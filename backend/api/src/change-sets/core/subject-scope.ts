import {
  type Module,
  type PageDesign,
  PageDesignParseError,
  parsePageDesign,
  parseTerm,
  type Term,
  TermParseError,
  termLanguages,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  ANYWHERE,
  allows,
  allowsAllIn,
  allowsAllInEach,
  allowsManual,
  allowsUnrestricted,
  moduleTarget,
} from '../../access/core/allows.js';
import type { Permission } from '../../access/core/permissions.js';
import { ForbiddenError } from '../../base/core/errors.js';
import type {
  ReadableContent,
  ReadPermission,
} from '../../content/core/readable-content.js';
import type { LockSubject, SubjectOf } from './lock.js';
import type { DraftManifest } from './working-copy.js';

type ModuleSubject = SubjectOf<'module'>;
type ManualSubject = SubjectOf<'manual'>;
type TermSubject = SubjectOf<'term'>;

/**
 * One answer for every refusal of a module, whatever the reason (the
 * committed module hidden, not editable, or missing while the actor may
 * not create one): an actor learns nothing about modules they may not see.
 */
export const OUTSIDE_EDIT =
  'The module lies outside what your roles may edit (its language, type, audience or facets).';

/**
 * A derived manual (#451) whose rule names a source manual the actor may not read: one answer
 * whether it is hidden from them or does not exist (for one who may read manuals of every
 * audience a missing source is no refusal, only its check), so it tells nothing about manuals
 * they may not see.
 */
export class DerivedSourceOutsideScopeError extends ForbiddenError {
  override readonly code = 'derived-source-outside-scope';

  constructor() {
    super(
      'The derived manual’s source manual is not one you may read. Name a manual you can open as its source.',
    );
  }
}

/** One answer for every refusal of a manual, as for modules. */
export const MANUAL_OUTSIDE_EDIT =
  'The manual lies outside what your roles may edit, or names modules you may not see.';

/**
 * One answer for every refusal of a configuration change: it needs
 * `content.edit` through a role whose scope restricts nothing, and
 * `admin.roles`.
 */
export const CONFIG_OUTSIDE_EDIT =
  'Changing the configuration needs `content.edit` through a role whose scope restricts nothing, and `admin.roles`.';

/**
 * One answer for every refusal of a page design change: it needs
 * `content.edit` through a role whose scope restricts nothing.
 */
export const DESIGN_OUTSIDE_EDIT =
  'Changing a page design needs `content.edit` through a role whose scope restricts nothing.';

/** One answer for every refusal of a term, as for modules. */
export const TERM_OUTSIDE_EDIT =
  'The term holds languages outside what your roles may edit.';

/**
 * The one rule for changing a subject as it is committed in `snapshot`
 * (taking its lock, saving its working copy): 403 with one answer whatever
 * the reason, so a refusal tells nothing about what the actor may not see.
 * The committed file is looked up past the reading filter, so a hidden
 * file is checked, never skipped as missing.
 *
 * - A committed module must lie within a role holding `content.edit` and
 *   be one the actor reads. Where none is committed (or the file is
 *   broken), only an actor who edits and reads all of its language may
 *   change it: for anyone else, a missing module and a hidden one would
 *   otherwise answer differently.
 * - A committed manual's audience must lie within a role holding
 *   `content.edit` and one the actor reads it with, and its manifest must
 *   name no module they may not see (saving what they see would drop the
 *   rest). Where none is committed (or the file is broken), only an actor
 *   who edits and reads manuals of every audience may change it.
 */
export async function checkCommittedScope(
  actor: Actor,
  snapshot: ReadableContent,
  subject: LockSubject,
): Promise<void> {
  switch (subject.type) {
    case 'module':
      return checkCommittedModule(actor, snapshot, subject);
    case 'manual':
      return checkCommittedManual(actor, snapshot, subject);
    case 'config':
      return checkConfigChange(actor);
    case 'term':
      return checkTermChange(actor, snapshot, subject, undefined);
    case 'design':
    case 'template':
      return checkDesignChange(actor);
  }
}

/**
 * Module scope. The new content must lie within a role holding
 * `content.edit`; the committed module is checked as for every change of
 * it (`checkCommittedModule`).
 */
export async function checkModuleScope(
  actor: Actor,
  snapshot: ReadableContent,
  subject: ModuleSubject,
  module: Module,
): Promise<void> {
  const config = await snapshot.config();
  if (!allows(actor, 'content.edit', moduleTarget(module.meta, config))) {
    throw new ForbiddenError(OUTSIDE_EDIT);
  }
  await checkCommittedModule(actor, snapshot, subject);
}

/**
 * Manual scope. The new audience must lie within a role holding
 * `content.edit` (`allowsManual`); the committed manifest is checked as
 * for every change of it (`checkCommittedManual`).
 */
export async function checkManualScope(
  actor: Actor,
  snapshot: ReadableContent,
  subject: ManualSubject,
  manifest: DraftManifest,
): Promise<void> {
  const may = await manualScope(actor, snapshot);
  if (!may('content.edit', manifest.audience)) {
    throw new ForbiddenError(MANUAL_OUTSIDE_EDIT);
  }
  await checkCommittedManual(actor, snapshot, subject);
  // A derived manual gathers from its source (#451): only from one the actor may read, read
  // past the reading filter as the committed manual is. A missing (or broken) source only for
  // one who reads manuals of every audience, or a hidden one and a missing one would differ.
  const rule = manifest.kind === 'derived' ? manifest.rule : undefined;
  if (rule) {
    const source = await snapshot.manifestForCheck(rule.source);
    const reads =
      source === undefined || source === 'unreadable'
        ? may(snapshot.permission, undefined)
        : may(snapshot.permission, source.audience);
    if (!reads) throw new DerivedSourceOutsideScopeError();
  }
}

/**
 * The configuration decides what every reader sees and what every role
 * means: only an actor holding `content.edit` through a role whose scope
 * restricts nothing, and `admin.roles` (who may change roles anyway),
 * changes it. Its content needs no further scope: it has none.
 */
export function checkConfigChange(actor: Actor): void {
  if (
    !allowsUnrestricted(actor, 'content.edit') ||
    !allows(actor, 'admin.roles', ANYWHERE)
  ) {
    throw new ForbiddenError(CONFIG_OUTSIDE_EDIT);
  }
}

/**
 * Term scope: one role holding `content.edit` over everything in each
 * language the term holds, as committed and as `term` (the new content,
 * when there is one) has it (`allowsAllInEach`). A committed file that
 * cannot be read: only a role covering every language. A term with
 * nothing committed and no content yet (taking its lock): a role holding
 * `content.edit` restricted by nothing but languages; the content is
 * checked when it is saved. Terms
 * carry no audience, so nothing about them is hidden from a reader and
 * the refusal needs no disguise; it is still one answer.
 */
export async function checkTermChange(
  actor: Actor,
  snapshot: ReadableContent,
  subject: TermSubject,
  term: Term | undefined,
): Promise<void> {
  const committed = await committedTerm(snapshot, subject.termId);
  const langs =
    committed === 'unreadable'
      ? ('every' as const)
      : [
          ...new Set([
            ...(term ? termLanguages(term) : []),
            ...(committed ? termLanguages(committed) : []),
          ]),
        ];
  // No languages yet (a new term): still a role restricted only by
  // languages, so one that could never save a term cannot lock one.
  const may = allowsAllInEach(actor, 'content.edit', langs);
  if (!may) throw new ForbiddenError(TERM_OUTSIDE_EDIT);
}

/**
 * The term committed in `snapshot`: `undefined` when there is none,
 * `'unreadable'` when its file is no term.
 */
export async function committedTerm(
  snapshot: ReadableContent,
  termId: string,
): Promise<Term | 'unreadable' | undefined> {
  const text = await snapshot.termSource(termId);
  if (text === undefined) return undefined;
  try {
    return parseTerm(text, { id: termId });
  } catch (error) {
    if (error instanceof TermParseError) return 'unreadable';
    throw error;
  }
}

/**
 * A page design's committed file (`design/<id>.yaml`) read past every
 * filter: the design, `'unreadable'` for a file that is no design, or
 * `undefined` when there is none.
 */
export async function committedPageDesign(
  snapshot: ReadableContent,
  designId: string,
): Promise<PageDesign | 'unreadable' | undefined> {
  const text = await snapshot.pageDesignSource(designId);
  if (text === undefined) return undefined;
  try {
    return parsePageDesign(text, { id: designId });
  } catch (error) {
    if (error instanceof PageDesignParseError) return 'unreadable';
    throw error;
  }
}

/** The module half of `checkCommittedScope`. */
export async function checkCommittedModule(
  actor: Actor,
  snapshot: ReadableContent,
  subject: ModuleSubject,
): Promise<void> {
  const config = await snapshot.config();
  const committed = await snapshot.moduleMetaForCheck(
    subject.moduleId,
    subject.lang,
  );
  const editable =
    committed === undefined || committed === 'unreadable'
      ? allowsAllIn(actor, 'content.edit', subject.lang) &&
        allowsAllIn(actor, snapshot.permission, subject.lang)
      : allows(actor, 'content.edit', moduleTarget(committed, config)) &&
        (await snapshot.module(subject.moduleId, subject.lang)) !== undefined;
  if (!editable) throw new ForbiddenError(OUTSIDE_EDIT);
}

/** The manual half of `checkCommittedScope`. */
export async function checkCommittedManual(
  actor: Actor,
  snapshot: ReadableContent,
  subject: ManualSubject,
): Promise<void> {
  const may = await manualScope(actor, snapshot);
  const committed = await snapshot.manifestForCheck(subject.manualId);
  const editable =
    committed === undefined || committed === 'unreadable'
      ? may('content.edit', undefined) && may(snapshot.permission, undefined)
      : may('content.edit', committed.audience) &&
        may(snapshot.permission, committed.audience) &&
        !committed.hidesEntries;
  if (!editable) throw new ForbiddenError(MANUAL_OUTSIDE_EDIT);
}

/**
 * Whether `actor` may use a permission on a manual of an audience
 * (`undefined`: the most restricted level, so only a role covering every
 * one), with the audiences `snapshot` configures (`allowsManual`).
 */
export async function manualScope(
  actor: Actor,
  snapshot: ReadableContent,
): Promise<(permission: Permission, audience: string | undefined) => boolean> {
  const audiences = (await snapshot.config()).audiences.map((a) => a.id);
  return (permission, audience) =>
    allowsManual(actor, permission, { audiences, audience, lang: undefined });
}

/**
 * A page design (#390) is every manual's look, in every language and for
 * every audience that uses it: only an actor holding `content.edit` through
 * a role whose scope restricts nothing changes one, as for the
 * configuration, but without `admin.roles` (a design decides no role).
 */
export function checkDesignChange(actor: Actor): void {
  if (!allowsUnrestricted(actor, 'content.edit')) {
    throw new ForbiddenError(DESIGN_OUTSIDE_EDIT);
  }
}

/**
 * Whether a lock on `subject` is one `actor` may know of: the
 * configuration and a term always (every reader of the branch reads
 * them); a module or manual when it, as
 * committed in `snapshot` (its change set's branch), lies within their
 * `permission` scope (`content.read.draft`; an author without it sees
 * their own locks through `content.read`, `draftReadPermission`), as a
 * read of it would. A subject with nothing committed (or a broken file)
 * only for one who reads all of its language (a module) or manuals of
 * every audience: for anyone else a lock on a new subject and one on a
 * hidden subject would look different.
 */
export async function seesSubject(
  actor: Actor,
  snapshot: ReadableContent,
  subject: LockSubject,
  permission: ReadPermission = 'content.read.draft',
): Promise<boolean> {
  // The configuration, terms, page designs and their templates are read by every reader of the branch.
  if (
    subject.type === 'config' ||
    subject.type === 'term' ||
    subject.type === 'design' ||
    subject.type === 'template'
  )
    return true;
  if (subject.type === 'module') {
    const committed = await snapshot.moduleMetaForCheck(
      subject.moduleId,
      subject.lang,
    );
    return committed === undefined || committed === 'unreadable'
      ? allowsAllIn(actor, permission, subject.lang)
      : allows(
          actor,
          permission,
          moduleTarget(committed, await snapshot.config()),
        );
  }
  const may = await manualScope(actor, snapshot);
  const committed = await snapshot.manifestForCheck(subject.manualId);
  return committed === undefined || committed === 'unreadable'
    ? may(permission, undefined)
    : may(permission, committed.audience);
}

/**
 * Whether some role of `actor` holding `content.read.draft` restricts
 * nothing: they may know of every lock, so none needs checking.
 */
export function readsAllDrafts(actor: Actor): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes('content.read.draft') &&
      Object.values(scope).every((value) => value === undefined),
  );
}

/**
 * The languages `actor` reads drafts in (the roles holding
 * `content.read.draft`); `undefined` when one of them covers every
 * language. A lock on a module in any other language is outside their
 * scope whatever the module says: a cheap first cut before content is read.
 */
export function draftLanguages(actor: Actor): string[] | undefined {
  const languages = new Set<string>();
  for (const { permissions, scope } of actor.roles) {
    if (!permissions.includes('content.read.draft')) continue;
    if (scope.languages === undefined) return undefined;
    for (const lang of scope.languages) languages.add(lang);
  }
  return [...languages];
}
