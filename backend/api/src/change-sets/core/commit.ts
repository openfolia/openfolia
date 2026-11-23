import { LEGACY_CONFIG_FILE_NAME } from '@openfolia/content-model';
import type { ChangeSetAuthor } from './change-set.js';
import { hasControl } from './change-set.js';
import { type LockSubject, subjectKey } from './lock.js';
import { kindOf, subjectOfPath } from './subject-kinds.js';

/**
 * A save point: one commit on a change set's branch, made from its working
 * copies (and deletions), recorded in Postgres (`ChangeSetCommits`) with
 * its audit events once it has landed.
 */
export interface ChangeSetCommit {
  readonly changeSetId: string;
  readonly branch: string;
  readonly commit: string;
  /** The branch head it was made on. */
  readonly parent: string;
  /** Who made it, as the audit log names actors. */
  readonly actor: ChangeSetAuthor;
  /** Subjects written (created or replaced), in subject-key order. */
  readonly written: readonly LockSubject[];
  /** Subjects deleted, in subject-key order. */
  readonly deleted: readonly LockSubject[];
}

/** A file change on a change set's branch, as the branches port writes it. */
export type BranchChange =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly delete: true };

/**
 * The repository path of a subject's file, made from the subject key alone
 * (never from the content's `id` or `meta.lang`): `modules/<lang>/<id>.adoc`,
 * `manuals/<id>.yaml`, `openfolia.yaml` or `terms/<id>.yaml` (`SUBJECT_KINDS`).
 */
export function subjectPath(subject: LockSubject): string {
  return kindOf(subject).path(subject);
}

/**
 * A subject's ID for a message: the configuration by its file's name (`openfolia.yaml`), not its
 * stored subject ID (`CONFIG_SUBJECT_ID`, which keeps the earlier name).
 */
export function subjectIdForMessage(subject: LockSubject): string {
  return subject.type === 'config'
    ? subjectPath(subject)
    : subjectKey(subject).id;
}

/**
 * Whether a set of changed paths holds the subject's file: for the configuration under either
 * name (`ccms.yaml`, its earlier name, is still read for one release, #372).
 */
export function changedIn(
  paths: { has(path: string): boolean },
  subject: LockSubject,
): boolean {
  return (
    paths.has(subjectPath(subject)) ||
    (subject.type === 'config' && paths.has(LEGACY_CONFIG_FILE_NAME))
  );
}

export { subjectOfPath };

/** Orders subjects by their key, so lists and audit events are stable. */
export function bySubjectKey(a: LockSubject, b: LockSubject): number {
  const [x, y] = [subjectKey(a), subjectKey(b)];
  return `${x.type}/${x.id}`.localeCompare(`${y.type}/${y.id}`);
}

/**
 * The trailer naming the change set a commit was made in. For people and
 * tools reading the history only: recovery never trusts trailers (#154).
 */
export const CHANGE_SET_TRAILER = 'Change-set';
/** The trailer naming who made a commit: `<kind>/<id>`, as the audit log names actors. */
export const ACTOR_TRAILER = 'Actor';
/**
 * The trailer naming who wrote what a commit carries over from another change
 * set (a carry-forward, a move onto a rewritten base), one per writer:
 * `<kind>/<id>`. They count as authors of the change set it lands in (#597).
 */
export const CARRIED_AUTHOR_TRAILER = 'Carried-author';
/** The trailer naming who approved a merged change set, one per approver: `<kind>/<id>`. */
export const APPROVED_BY_TRAILER = 'Approved-by';
/**
 * The trailer naming the change set a merge commit merged. Distinct from
 * `Change-set`, which only save points carry; recovery matches commit
 * intents, never trailers, so it cannot take a merge commit either way.
 */
export const MERGED_CHANGE_SET_TRAILER = 'Merged-change-set';
/** The trailer naming who merged a change set: `<kind>/<id>`. */
export const MERGED_BY_TRAILER = 'Merged-by';
/**
 * The trailer naming the change set an update from its base (#22) was
 * made on: neither a save point's nor a merge's, so nothing reads it as
 * one.
 */
export const UPDATED_CHANGE_SET_TRAILER = 'Updated-change-set';
/** The trailer naming who updated a change set from its base: `<kind>/<id>`. */
export const UPDATED_BY_TRAILER = 'Updated-by';

/** The actor named by a `Merged-by` trailer (`user/<id>`, `service/<id>`). */
export function actorOfTrailer(value: string): ChangeSetAuthor | undefined {
  const slash = value.indexOf('/');
  const kind = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (slash < 1 || (kind !== 'user' && kind !== 'service')) return undefined;
  if (id.length < 1 || id.length > 200 || hasControl(id)) return undefined;
  return { kind, id };
}

/**
 * How large the working copies one commit takes may be together, as
 * stored JSON (a working copy is at most 512 KiB); commit fewer subjects
 * at once beyond it.
 */
export const MAX_COMMIT_JSON_BYTES = 32 * 1024 * 1024;

/** The most files (written and deleted) one commit changes. */
export const MAX_COMMIT_CHANGES = 1000;

/** The longest commit message a client may give. */
export const MAX_COMMIT_MESSAGE = 10_000;

/**
 * How far back a recovery walks a branch's history looking for commits
 * that were never recorded (a crash between Git and the database).
 */
export const MAX_RECOVERED_COMMITS = 100;

/**
 * How far back the commits of a change set's own branch are walked to
 * find the one a working copy was based on (`fileUnchangedSince` for an
 * author without `content.read.draft`); one further back is stale.
 */
export const MAX_OWN_HISTORY = 1000;
