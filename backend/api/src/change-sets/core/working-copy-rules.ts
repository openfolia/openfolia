import {
  type Issue,
  LEGACY_CONFIG_FILE_NAME,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/core/errors.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet } from './change-set.js';
import type { ChangeSetStore } from './change-set-store.js';
import type { ChangeSetBranches } from './change-set-branches.js';
import { MAX_OWN_HISTORY, subjectPath } from './commit.js';
import { LockSubject, subjectKey } from './lock.js';
import { isActor, readsChangeSets } from './own-work.js';
import { kindOf } from './subject-kinds.js';
import type { WorkingCopyContent } from './working-copy.js';

/** The 403's detail for a change set's working copies (and save points). */
export const AUTHOR_ONLY =
  'Only its author works on a change set’s working copies.';

/**
 * The change set `id`, when `actor` is its author: a working copy is its
 * editor's alone (only the author takes the locks it needs). 404 when
 * there is none, 403 for anyone else who may read drafts (they list change
 * sets anyway), and 404 for one who may not, exactly as for none
 * (`ownChangeSet`). `forbidden` is the 403's detail.
 */
export async function authorsChangeSet(
  changeSets: ChangeSetStore,
  actor: Actor,
  id: string,
  forbidden = AUTHOR_ONLY,
): Promise<ChangeSet> {
  return ownChangeSet(await changeSets.find(id), actor, id, forbidden);
}

/**
 * `found`, the change set `id`, when `actor` is its author. For an actor
 * who may not read change sets (`content.read.draft`), another author's
 * one is not found, exactly like one that does not exist (#125): the same
 * status, code and detail. A draft reader gets 403 with `forbidden` as its
 * detail, which tells them nothing new (they list change sets anyway).
 */
export function ownChangeSet(
  found: ChangeSet | undefined,
  actor: Actor,
  id: string,
  forbidden: string,
): ChangeSet {
  const notFound = () => new NotFoundError(`No change set "${id}".`);
  if (!found) throw notFound();
  if (!isActor(actor, found.author)) {
    if (!readsChangeSets(actor)) throw notFound();
    throw new ForbiddenError(forbidden);
  }
  return found;
}

/** The problems found checking a working copy against the configuration. */
export function workingCopyIssues(
  subject: LockSubject,
  content: WorkingCopyContent,
  config: ProjectConfig,
): Issue[] {
  return kindOf(subject).issues(subject, content, config);
}

/**
 * The subject a path names, in the form locks name it (the language in its
 * canonical case); one no lock can be on is not found. Checked by the
 * action, after its policy, so an actor without the permission learns
 * nothing from the parameters.
 */
export function workingCopySubject(named: LockSubject): LockSubject {
  const parsed = LockSubject.safeParse(named);
  if (!parsed.success) {
    const name =
      named.type === 'module'
        ? `${named.lang}/${named.moduleId}`
        : named.type === 'manual'
          ? named.manualId
          : named.type === 'term'
            ? named.termId
            : named.type === 'design'
              ? named.designId
              : named.type === 'template'
                ? `${named.templateId}/${named.path}`
                : 'configuration';
    throw new NotFoundError(
      `No ${named.type} "${name}" can have a working copy.`,
    );
  }
  return parsed.data;
}

/** A full commit ID (SHA-1 or SHA-256), as Git writes them. */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * A change set's own branch, for `fileUnchangedSince`: its commits from
 * its base commit on are its author's own work.
 */
export interface OwnBranch {
  readonly branches: Pick<ChangeSetBranches, 'history' | 'changedPaths'>;
  readonly changeSet: Pick<ChangeSet, 'branch' | 'baseCommit'>;
}

/**
 * Whether the subject's file at the commit `since` is the same as at
 * `head` (both missing counts as the same). False when `since` is no
 * commit the actor may open (a missing one and an unreadable one alike).
 * The files are compared past the reading filter, never returned.
 *
 * An author without `content.read.draft` opens no draft commit by its ID,
 * yet bases their working copies on their own branch's earlier commits
 * (#126). With `own`, a `since` they cannot open still counts when it is
 * one of the branch's own commits, its base commit included (first-parent
 * history from `head`, at most `MAX_OWN_HISTORY` back): then the branch's
 * own diff since it decides.
 */
export async function fileUnchangedSince(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  actor: Actor,
  head: ReadableContent,
  since: string,
  subject: LockSubject,
  own?: OwnBranch,
): Promise<boolean> {
  // The configuration under either name (`ccms.yaml` is still read for one release): a change
  // to the file in effect, whichever it is, makes the copy stale.
  const paths =
    subject.type === 'config'
      ? [subjectPath(subject), LEGACY_CONFIG_FILE_NAME]
      : [subjectPath(subject)];
  return filesUnchangedSince(openSnapshot, actor, head, since, paths, own);
}

/** `fileUnchangedSince` for the files at `paths` (#957: a module's translation record). */
export async function filesUnchangedSince(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  actor: Actor,
  head: ReadableContent,
  since: string,
  paths: readonly string[],
  own?: OwnBranch,
): Promise<boolean> {
  if (since === head.commit) return true;
  if (!COMMIT_ID.test(since)) return false;
  let base: ReadableContent | undefined;
  try {
    base = await openSnapshot.handle({ actor, ref: since });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  if (base === undefined || base.commit !== since) {
    return own !== undefined && unchangedOnOwnBranch(own, head, since, paths);
  }
  for (const path of paths) {
    const [then, now] = await Promise.all([
      base.sourceForCheck(path),
      head.sourceForCheck(path),
    ]);
    if (!sameBytes(then, now)) return false;
  }
  return true;
}

/** `fileUnchangedSince` through the branch's own history and diff. */
async function unchangedOnOwnBranch(
  { branches, changeSet }: OwnBranch,
  head: ReadableContent,
  since: string,
  paths: readonly string[],
): Promise<boolean> {
  // Only the base commit and the branch's own line since: what lies in the
  // base's history is not theirs. Since an update from the base (#22) the
  // base commit is a merge's second parent, so the line is the first-parent
  // history that is not the base's, not the line down to the base commit.
  if (since !== changeSet.baseCommit) {
    const own = await branches.history(
      changeSet.branch,
      head.commit,
      MAX_OWN_HISTORY,
      changeSet.baseCommit,
    );
    if (!own.some((entry) => entry.commit === since)) return false;
  }
  const changed = await branches.changedPaths(since, head.commit);
  return !changed.some((entry) => paths.includes(entry.path));
}

/** Whether two files (undefined: none) hold the same bytes. */
export function sameBytes(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * 409 `stale-working-copy`: the subjects' files changed on the branch
 * since the commit their content was based on. `meta.head` is the branch
 * head: read the files there, and save with it as the base once the
 * content takes them into account.
 */
export function staleWorkingCopy(
  subjects: readonly LockSubject[],
  head: string,
): ConflictError {
  const names = subjects
    .map((s) => {
      const { type, id } = subjectKey(s);
      return `${type} ${id}`;
    })
    .join(', ');
  return new ConflictError(
    'stale-working-copy',
    `Changed on the branch since the content was based on it: ${names}. Read it again.`,
    { subjects, head },
  );
}
