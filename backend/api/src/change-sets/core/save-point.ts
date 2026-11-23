import type { Actor } from '../../access/core/actor.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  type UnitOfWork,
} from '../../base/core/unit-of-work.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet, ChangeSetAuthor } from './change-set.js';
import type { ChangeSetBranches } from './change-set-branches.js';
import type { ChangeSetStore } from './change-set-store.js';
import type { CommitIntents, ConsumedCopy } from './commit-intents.js';
import {
  type BranchChange,
  bySubjectKey,
  subjectOfPath,
  subjectPath,
} from './commit.js';
import type { CommitRecorder } from './commit-recorder.js';
import { type Lock, type LockSubject, subjectKey } from './lock.js';
import type { LockStore } from './lock-store.js';
import { opensAsAuthor } from './own-work.js';
import {
  AUTHOR_ONLY,
  ownChangeSet,
  workingCopySubject,
} from './working-copy-rules.js';
import type { WorkingCopyStore } from './working-copy-store.js';
import {
  holdsRecord,
  once,
  recordAt,
  refuseRecordChange,
  refuseRecordChanges,
  refuseRecordWithoutBase,
} from './translation-records.js';

declare const CHECKED: unique symbol;

/**
 * A commit's tree as `SavePoints.prepare` made it, its changes checked as every commit's are
 * (`refuseRecordChanges`): the only tree a save point's write step takes.
 */
export type CheckedTree = string & { readonly [CHECKED]: true };

/** What a save point did. */
export interface CommitOutcome {
  readonly changeSetId: string;
  readonly branch: string;
  /** The new commit; undefined when nothing changed (no commit is made). */
  readonly commit?: string;
  /** The branch head the commit was made on (or, without one, the head). */
  readonly parent: string;
  readonly message?: string;
  readonly written: readonly LockSubject[];
  readonly deleted: readonly LockSubject[];
  /**
   * Working copies dropped because they hold exactly what is committed,
   * and listed subjects that had none: nothing to commit for these.
   */
  readonly unchanged: readonly LockSubject[];
}

/**
 * Something the preflight read moved before the write step held it: the
 * branch (`head`, where it is now) or working copies (`subjects`, saved
 * again or discarded meanwhile).
 */
export class Moved {
  constructor(
    readonly what:
      | { readonly head: string | undefined }
      | { readonly subjects: readonly LockSubject[] },
  ) {}

  /** The answer once the second attempt moved too. */
  conflict(): ConflictError {
    return 'head' in this.what
      ? new ConflictError(
          'branch-moved',
          'The change set’s branch moved while committing; try again.',
          { head: this.what.head ?? null },
        )
      : new ConflictError(
          'working-copy-changed',
          'Working copies changed while committing; try again.',
          { subjects: [...this.what.subjects].sort(bySubjectKey) },
        );
  }
}

/** What a preflight worked out: everything the write step does, decided. */
export interface SavePointPlan {
  readonly changeSet: ChangeSet;
  /** The branch head it was worked out on: the commit's parent. */
  readonly head: string;
  /** The commit's tree, prepared in Git (`SavePoints.prepare`); undefined when nothing changes. */
  readonly tree?: CheckedTree;
  readonly message: string;
  /** Who wrote what the commit carries over from another change set (#597). */
  readonly carried?: readonly ChangeSetAuthor[];
  /** The client's message, for the audit event's comment. */
  readonly comment?: string;
  /** The working copies it commits or drops, at the versions read. */
  readonly consumes: readonly ConsumedCopy[];
  /** Every subject whose lock it needs held. */
  readonly locked: readonly LockSubject[];
  readonly outcome: Omit<CommitOutcome, 'commit' | 'message'>;
}

/**
 * More of the write step, in its transaction, once the commit (if any) is
 * made and recorded and the working copies are dropped: `held` are the
 * locks it holds (`plan.locked`'s), `commit` the commit made.
 */
export type AfterWrite = (
  tx: Transaction,
  done: {
    readonly changeSet: ChangeSet;
    readonly held: readonly Lock[];
    readonly commit?: string;
  },
) => Promise<void>;

/**
 * The write path every commit onto a change set's branch takes (save
 * points, taking changes back out): opening the branch head with what an
 * earlier attempt left unrecorded caught up, holding the locks, and the
 * write step (the intent, then one bounded transaction holding the row and
 * the locks for the Git commit by compare-and-swap and its recording).
 * See `CommitWorkingCopiesAction` for the order and why.
 */
export class SavePoints {
  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly branches: ChangeSetBranches,
    private readonly recorder: CommitRecorder,
    private readonly intents: CommitIntents,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly unit: UnitOfWork,
  ) {}

  /**
   * Runs `attempt` (a preflight and a write), once more when something it
   * read moved, then answers 409 `branch-moved` or `working-copy-changed`.
   */
  async retrying<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof Moved)) throw error;
        if (tries >= 2) throw error.conflict();
      }
    }
  }

  /**
   * The first half of a commit onto the change set's branch, on top of `head` (the branch
   * head the preflight read, as the actor opens it): checks what every commit onto a change
   * set's branch must hold, whichever path wrote it, then writes its tree in Git
   * (`ChangeSetBranches.prepare`: objects only, no ref moves). Checked: no design or manifest
   * gets a translation record `actor` may not write (422 `translation-record-protected`,
   * `refuseRecordChanges`, against `head` and the change set's base commit).
   */
  async prepare(
    actor: Actor,
    changeSet: ChangeSet,
    head: ReadableContent,
    request: {
      readonly changes: readonly BranchChange[];
      readonly message: string;
      /** Who wrote what it carries over from another change set (`ChangeSetBranches.commit`). */
      readonly carried?: readonly ChangeSetAuthor[];
      /** Base heads an update from the base reported its subjects conflicting against (`changeSetRecordBases`). */
      readonly reported?: readonly string[];
    },
  ): Promise<CheckedTree> {
    await refuseRecordChanges(actor, request.changes, {
      head,
      bases: () =>
        changeSetRecordBases(
          this.openSnapshot,
          actor,
          changeSet,
          request.reported,
        ),
    });
    const { tree } = await this.branches.prepare(changeSet.branch, {
      parent: head.commit,
      changes: request.changes,
      message: request.message,
      author: { kind: actor.kind, id: actor.id },
      changeSetId: changeSet.id,
      ...(request.carried !== undefined && { carried: request.carried }),
    });
    return tree as CheckedTree;
  }

  /**
   * The change set `changeSetId` (its author only, a draft only: `verb`
   * says what only a draft takes) and its branch head as the actor opens
   * it. A commit an earlier attempt landed without recording it is
   * recorded first, under the row lock, so the next one is made on a
   * recorded head.
   */
  async open(
    actor: Actor,
    changeSetId: string,
    verb: string,
  ): Promise<{ changeSet: ChangeSet; head: ReadableContent }> {
    let changeSet = ownChangeSet(
      await this.changeSets.find(changeSetId),
      actor,
      changeSetId,
      AUTHOR_ONLY,
    );
    checkDraft(changeSet, verb);
    const head = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
      authored: opensAsAuthor(actor, changeSet),
    });
    if (await this.recorder.mayCatchUp(changeSet, head.commit)) {
      await this.unit.run(async (tx) => {
        const locked = await this.changeSets.lock(tx, changeSetId);
        if (!locked) return;
        changeSet = locked;
        await this.recorder.catchUp(tx, locked, head.commit);
      }, BOUNDED);
    }
    return { changeSet, head };
  }

  /**
   * The write step: the intent (when there is a commit to make), then one
   * bounded transaction holding the row and the locks for the Git commit
   * and its recording only, and `after` in it.
   */
  async write(
    actor: Actor,
    plan: SavePointPlan,
    verb: string,
    after?: AfterWrite,
  ): Promise<CommitOutcome> {
    const { changeSet, outcome } = plan;
    const author = { kind: actor.kind, id: actor.id };
    const intent =
      plan.tree === undefined
        ? undefined
        : await this.unit.run(
            (tx) =>
              this.intents.add(tx, {
                changeSetId: changeSet.id,
                actor: author,
                parent: plan.head,
                tree: plan.tree as string,
                written: outcome.written,
                deleted: outcome.deleted,
                consumes: plan.consumes,
                ...(plan.comment !== undefined && { message: plan.comment }),
              }),
            BOUNDED,
          );
    // Whether the Git write may have happened: then the intent stays, for
    // recovery; otherwise it is removed again.
    let mayHaveLanded = false;
    try {
      return await this.unit.run(async (tx) => {
        const locked = await this.changeSets.lock(tx, changeSet.id);
        if (!locked) {
          throw new NotFoundError(`No change set "${changeSet.id}".`);
        }
        checkDraft(locked, verb);
        // The row is held: opened without asking the database again.
        ownChangeSet(locked, actor, changeSet.id, AUTHOR_ONLY);
        const held = await this.holdLocks(tx, changeSet.id, plan.locked);
        // Saved again, or discarded and saved again (version 1 anew, but
        // another `createdAt`), since the preflight read it: not what was
        // checked and printed.
        const now = new Map(
          (await this.workingCopies.sizesOf(tx, changeSet.id)).map((s) => [
            keyOf(s.subject),
            s,
          ]),
        );
        const moved = plan.consumes.filter((c) => {
          const at = now.get(keyOf(c.subject));
          return (
            at?.version !== c.version ||
            at.createdAt.getTime() !== c.createdAt.getTime()
          );
        });
        // A copy saved since the preflight on a subject it holds the lock
        // on, but did not read: it would outlive the write unseen.
        const read = new Set(plan.consumes.map((c) => keyOf(c.subject)));
        const unread = plan.locked.filter(
          (subject) => now.has(keyOf(subject)) && !read.has(keyOf(subject)),
        );
        if (moved.length > 0 || unread.length > 0) {
          throw new Moved({
            subjects: [...moved.map((c) => c.subject), ...unread],
          });
        }
        if (intent === undefined) {
          // No commit, so no compare-and-swap: the copies dropped as
          // unchanged must still be the branch's files.
          const head = await this.openSnapshot.handle({
            actor,
            ref: locked.branch,
            authored: opensAsAuthor(actor, locked),
          });
          if (head.commit !== plan.head) throw new Moved({ head: head.commit });
          await this.dropAll(tx, changeSet.id, plan.consumes);
          await after?.(tx, { changeSet: locked, held });
          return outcome;
        }
        mayHaveLanded = true;
        const result = await this.branches.commit(changeSet.branch, {
          parent: plan.head,
          tree: intent.tree,
          message: plan.message,
          author,
          changeSetId: changeSet.id,
          ...(plan.carried !== undefined && { carried: plan.carried }),
        });
        if ('moved' in result) {
          mayHaveLanded = false;
          throw new Moved({ head: result.moved });
        }
        await this.dropAll(tx, changeSet.id, plan.consumes);
        await this.recorder.record(
          tx,
          { ...outcome, commit: result.commit, actor: author },
          intent.message === undefined ? {} : { comment: intent.message },
        );
        await this.intents.remove(tx, intent.id);
        await after?.(tx, { changeSet: locked, held, commit: result.commit });
        return { ...outcome, commit: result.commit, message: plan.message };
      }, BOUNDED);
    } catch (error) {
      if (intent && !mayHaveLanded) await this.forget(intent.id);
      throw error;
    }
  }

  /**
   * Holds the locks on `subjects` to the end (in lock-ID order, as bulk
   * removals take them: #149) and returns them; 409 `lock-required` for
   * the first subject the change set holds no lock on.
   */
  async holdLocks(
    tx: Transaction,
    changeSetId: string,
    subjects: readonly LockSubject[],
  ): Promise<Lock[]> {
    const held = (await this.locks.holdAll(tx, subjects)).filter(
      (lock) => lock.changeSetId === changeSetId,
    );
    const keys = new Set(held.map((lock) => keyOf(lock.subject)));
    const missing = subjects.find((subject) => !keys.has(keyOf(subject)));
    if (missing) {
      throw new ConflictError(
        'lock-required',
        `Take the lock on ${keyOf(missing)} for this change set first.`,
        { subject: missing },
      );
    }
    return held;
  }

  /** Removes an intent whose commit never landed; one left behind expires. */
  private async forget(id: number): Promise<void> {
    try {
      await this.unit.run((tx) => this.intents.remove(tx, id), BOUNDED);
    } catch {
      // Expires (`INTENT_TTL_MS`); never in the way of the answer.
    }
  }

  private async dropAll(
    tx: Transaction,
    changeSetId: string,
    drop: readonly ConsumedCopy[],
  ): Promise<void> {
    for (const { subject, version, createdAt } of drop) {
      // The change set's row is held: no save changed it since it was read.
      await this.workingCopies.removeAt(
        tx,
        changeSetId,
        subject,
        version,
        createdAt,
      );
    }
  }
}

/** The states a change set is committed to: a draft only. */
const COMMITTABLE = ['draft'];

/** 409 `invalid-state` unless the change set is a draft. */
export function checkDraft(changeSet: ChangeSet, verb: string): void {
  if (!COMMITTABLE.includes(changeSet.state)) {
    throw new ConflictError(
      'invalid-state',
      `The change set is ${changeSet.state}; only a draft ${verb}.`,
      { state: changeSet.state },
    );
  }
}

/** `<type>/<id>`, one key per subject. */
export function keyOf(subject: LockSubject): string {
  const { type, id } = subjectKey(subject);
  return `${type}/${id}`;
}

/** The subjects in their canonical form; one named twice is a 422. */
export function distinct(
  subjects: readonly LockSubject[],
  member: string,
): LockSubject[] {
  const seen = new Set<string>();
  return subjects.map((named) => {
    const subject = workingCopySubject(named);
    const key = keyOf(subject);
    if (seen.has(key)) {
      throw new UnprocessableError(
        'duplicate-subject',
        `${key} is named twice in \`${member}\`.`,
        { subject },
      );
    }
    seen.add(key);
    return subject;
  });
}

/**
 * The change set's base commit as `actor` opens it (an author without `content.read.draft`
 * through their own work, `opensAsAuthor`); undefined when it cannot be opened.
 */
export async function openChangeSetBase(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  actor: Actor,
  changeSet: Pick<ChangeSet, 'author' | 'baseReleased' | 'baseCommit'>,
): Promise<ReadableContent | undefined> {
  try {
    const base = await openSnapshot.handle({
      actor,
      ref: changeSet.baseCommit,
      ...(opensAsAuthor(actor, changeSet) && { authoredBase: true }),
    });
    return base.commit === changeSet.baseCommit ? base : undefined;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/**
 * The commits whose translation records anyone may put back into the change set
 * (`RecordSides.bases`): its base commit (`openChangeSetBase`) and, resolving an update from
 * the base, the base heads `reported` names (a commit ID, or a branch by its full name
 * `refs/heads/<name>`), opened as `actor`; one that cannot be opened is left out.
 */
export async function changeSetRecordBases(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  actor: Actor,
  changeSet: Pick<ChangeSet, 'author' | 'baseReleased' | 'baseCommit'>,
  reported: readonly string[] = [],
): Promise<ReadableContent[]> {
  const opened = await Promise.all([
    openChangeSetBase(openSnapshot, actor, changeSet),
    ...[...new Set(reported)].map(async (commit) => {
      try {
        const there = await openSnapshot.handle({ actor, ref: commit });
        return commit.startsWith('refs/heads/') || there.commit === commit
          ? there
          : undefined;
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    }),
  ]);
  return opened.filter((s) => s !== undefined);
}

/**
 * Refuses (422 `translation-record-protected`) a translation record the change set's branch
 * at `head` holds and `actor` may not have written (#663), for every design or manifest the
 * branch changed since its base commit (deleted ones aside; with `only`, those of them it
 * names) and every `kept` one. Each language's entry is the base commit's, or one `actor`
 * manages; with `onto` (an update from the base, merging onto that base head, opened only
 * when there is something to check), it may be `onto`'s too, a `kept` subject (taken as it
 * is there) only `onto`'s. Run where what the branch holds goes on into a merge: an update
 * from the base, a submit. A base commit that cannot be opened puts nothing back.
 * `inTransaction`: for a caller inside a transaction holding the change set's row, the branch
 * is opened telling `OpenSnapshotAction` whether `actor` authors it (`opensAsAuthor`), so no
 * second query waits on that row. `'moved'` when the branch
 * is no longer at `head`.
 */
export async function refuseBranchRecords(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  branches: Pick<ChangeSetBranches, 'changedPaths'>,
  actor: Actor,
  changeSet: Pick<
    ChangeSet,
    'author' | 'baseReleased' | 'baseCommit' | 'branch'
  >,
  head: string,
  options: {
    readonly onto?: () => Promise<ReadableContent>;
    readonly kept?: readonly LockSubject[];
    readonly only?: readonly LockSubject[];
    readonly inTransaction?: boolean;
  } = {},
): Promise<'moved' | undefined> {
  const kept = options.kept ?? [];
  const keptKeys = new Set(kept.map(keyOf));
  const changed = (await branches.changedPaths(changeSet.baseCommit, head))
    .flatMap((c) => {
      const subject = c.deleted ? undefined : subjectOfPath(c.path);
      return subject && holdsRecord(subject) ? [subject] : [];
    })
    .filter((s) => !keptKeys.has(keyOf(s)))
    .filter(
      (s) =>
        options.only === undefined ||
        options.only.some((o) => keyOf(o) === keyOf(s)),
    );
  const subjects = [...kept.filter(holdsRecord), ...changed];
  if (subjects.length === 0) return undefined;
  const branch = await openSnapshot.handle({
    actor,
    ref: changeSet.branch,
    ...(options.inTransaction === true && {
      authored: opensAsAuthor(actor, changeSet),
    }),
  });
  if (branch.commit !== head) return 'moved';
  const onto = options.onto && once(options.onto);
  const base = once(() => openChangeSetBase(openSnapshot, actor, changeSet));
  const bases = async () => {
    const opened = await base();
    return opened ? [opened] : [];
  };
  for (const subject of subjects) {
    if ((await branch.sourceForCheck(subjectPath(subject))) === undefined) {
      continue;
    }
    const next = await recordAt(branch, subject);
    if (onto !== undefined) {
      await refuseRecordChange(actor, subject, next, {
        head: await onto(),
        bases: keptKeys.has(keyOf(subject)) ? () => Promise.resolve([]) : bases,
      });
      continue;
    }
    const opened = await base();
    if (opened === undefined) {
      await refuseRecordWithoutBase(actor, subject, next, branch);
    } else {
      await refuseRecordChange(actor, subject, next, {
        head: opened,
        bases: () => Promise.resolve([]),
      });
    }
  }
  return undefined;
}
