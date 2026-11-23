import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { CarryChange, type CarryConflict } from '../carry-change.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
  OPEN_STATES,
} from '../change-set.js';
import { baseRewritten } from '../change-set-behind.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetEvents } from '../change-set-events.js';
import { ChangeSetStore } from '../change-set-store.js';
import { type LockSubject, subjectKey } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { isActor, readsChangeSets } from '../own-work.js';
import { ChangeSetSupersessions } from '../supersessions.js';
import { recordTransition, Workflow } from '../workflow.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { CommitWorkingCopiesAction } from './commit-working-copies.action.js';

export interface RebaseChangeSetInput {
  readonly actor: Actor;
  /** The change set to move: open, its base rewritten past its base commit. */
  readonly id: string;
}

export interface RebaseChangeSetOutcome {
  /** The new draft on the base's current head, holding the change set's own changes. */
  readonly changeSet: ChangeSet;
  /** The change set moved: abandoned now, superseded by `changeSet`. */
  readonly source: ChangeSet;
  /** The commit holding what applied; undefined when nothing did. */
  readonly commit?: string;
  /** The subjects changed by that commit, in subject-key order. */
  readonly applied: readonly LockSubject[];
  /** What did not apply, by path, modules with the blocks to apply by hand. */
  readonly conflicts: readonly CarryConflict[];
}

/** The 403's detail for anyone but its author. */
export const REBASE_NOT_AUTHOR =
  'Only its author moves a change set onto its current base: it closes the change set and starts a new one of theirs.';

/** What the commit on the new branch says (no trailer-like text in it). */
const rebaseMessage = (source: ChangeSet) =>
  `Move change set ${source.id} onto the current ${source.baseRef}`;

/**
 * Moves a change set whose base was rewritten (#471: its base commit is no
 * longer in the base branch's history, after a force-push or a restore, so
 * it can be neither updated nor merged) onto the base's current head, as a
 * new draft change set with the same title and description, by its author
 * only (`content.edit`; it closes the change set, so nobody else does it for
 * them: 403). The new change set is theirs too; approvals do not carry over
 * (it is reviewed again).
 *
 * - **What is moved:** the change set's own diff (its base commit to its
 *   branch's head), three-way onto the base's head, as carrying a fix
 *   forward does it (`CarryChange`: locks, scope and content checks, one
 *   save point; what did not apply stays as the base has it and is listed,
 *   modules with their blocks).
 * - **Working copies** are committed first, as a save point, for a draft
 *   (`CommitWorkingCopiesAction`, with every check one makes); a change set
 *   in review is refused while it has some (409
 *   `uncommitted-working-copies`, `meta.subjects`).
 * - **The old change set** is abandoned, superseded by the new one
 *   (`ChangeSetSupersessions`), in the save point's transaction: its
 *   `change-set.abandon` event (and outbox row) has `data.supersededBy`,
 *   and a `change-set.rebase` event on it names the new change set, the
 *   commit, what applied and what did not; the new one's
 *   `change-set.create` has `data.supersedes`. Its branch, its comments
 *   and its history stay readable.
 * - **Refused:** one moved already (409 `already-superseded`,
 *   `meta.changeSetId`: where its changes are now, also once it is
 *   closed), another one no longer open (409 `invalid-state`), whose
 *   base was not rewritten (409 `base-not-rewritten`: update it instead),
 *   whose base is gone or a draft the actor may not read (409
 *   `base-missing`), whose branch is gone (409 `branch-missing`), or that a
 *   change set not abandoned supersedes already (409 `already-superseded`,
 *   `meta.changeSetId`); another author's is 404 for one who reads no
 *   drafts, as everywhere.
 *
 * **Order.** Git first: the new branch at the base's head. Then one
 * transaction holding the old change set's row records the new change
 * set, its `change-set.create` event and the link, and releases the old
 * one's locks (each with `lock.release`, `data.reason: "change-set.rebase"`),
 * so the new one can take them. Then the locks and the save point, which
 * closes the old one. A request cut off before that leaves the old one
 * open and the new one a draft of the actor's: the same request again goes
 * on with that draft (its branch still at its base commit: applied again;
 * moved on already: only the old one is closed).
 */
@Injectable()
export class RebaseChangeSetAction extends ActorAction<
  RebaseChangeSetInput,
  RebaseChangeSetOutcome
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly store: ChangeSetStore,
    private readonly supersessions: ChangeSetSupersessions,
    private readonly refs: ReadableRefs,
    private readonly branches: ChangeSetBranches,
    private readonly workflow: Workflow,
    private readonly carry: CarryChange,
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly auditLog: AuditLog,
    private readonly events: ChangeSetEvents,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: RebaseChangeSetInput): Promise<RebaseChangeSetOutcome> {
    const source = await this.store.find(id);
    if (
      !source ||
      (!isActor(actor, source.author) && !readsChangeSets(actor))
    ) {
      throw new NotFoundError(`No change set "${id}".`);
    }
    if (!isActor(actor, source.author)) {
      throw new ForbiddenError(REBASE_NOT_AUTHOR);
    }
    if (!OPEN_STATES.includes(source.state)) {
      // Moved already (in another tab, or a retry of a request that went through).
      const { supersededBy } = await this.supersessions.linksOf(source.id);
      if (supersededBy !== undefined) throw superseded(supersededBy);
      refuseClosed(source);
    }
    let head = await this.workflow.headOf(source);
    const base = await this.refs.branch(actor, source.baseRef);
    if (!base) {
      throw new ConflictError(
        'base-missing',
        `The change set’s base branch ${source.baseRef} is gone.`,
      );
    }
    if (!(await baseRewritten(this.branches, source, base.commit))) {
      throw new ConflictError(
        'base-not-rewritten',
        'The base branch still holds the commit the change set started from: update it from its base instead.',
      );
    }
    if (await this.commitTyped(actor, source)) {
      head = await this.workflow.headOf(source);
    }

    const active = await this.supersessions.activeOf(source.id);
    let changeSet: ChangeSet;
    // Planned before anything is written: a refusal (too many changes) leaves the change set
    // as it was, its locks held.
    let plan = await this.carry.plan({
      from: source.baseCommit,
      to: head,
      onto: base.commit,
    });
    if (active === undefined) {
      changeSet = await this.start(actor, source, base);
    } else {
      // A request cut off earlier: its draft is gone on with, nobody else's.
      const found = await this.store.find(active);
      if (!found || found.state !== 'draft' || !isActor(actor, found.author)) {
        throw superseded(active);
      }
      changeSet = found;
      if ((await this.branches.head(found.branch)) !== found.baseCommit) {
        await this.unit.run(
          (tx) =>
            this.close(tx, actor, source, found, { applied: 0, conflicts: 0 }),
          BOUNDED,
        );
        return this.outcome(source, found, { applied: [], conflicts: [] });
      }
      if (found.baseCommit !== base.commit) {
        plan = await this.carry.plan({
          from: source.baseCommit,
          to: head,
          onto: found.baseCommit,
        });
      }
      await this.unit.run(async (tx) => {
        if (!(await this.store.lock(tx, source.id))) {
          throw new NotFoundError(`No change set "${source.id}".`);
        }
        await this.releaseLocks(tx, actor, source.id);
      }, BOUNDED);
    }

    const written = await this.carry.apply(actor, {
      changeSet,
      onto: changeSet.baseCommit,
      plan,
      source,
      sourceHead: head,
      placesRef: source.baseRef,
      message: rebaseMessage(source),
      after: (tx, done) => this.close(tx, actor, source, changeSet, done),
    });
    return this.outcome(source, changeSet, written);
  }

  /**
   * Commits the working copies of `source` (its author's) first, as a save
   * point, for a draft; true when there were any. A change set in review is
   * refused while it has some.
   */
  private async commitTyped(actor: Actor, source: ChangeSet): Promise<boolean> {
    const typed = await this.unit.run(
      (tx) => this.workingCopies.sizesOf(tx, source.id),
      BOUNDED,
    );
    if (typed.length === 0) return false;
    if (source.state !== 'draft') {
      throw new ConflictError(
        'uncommitted-working-copies',
        'Its author commits or discards its working copies first.',
        { subjects: typed.map((t) => t.subject) },
      );
    }
    await this.commitWorkingCopies.handle({
      actor,
      changeSetId: source.id,
    });
    return true;
  }

  /**
   * The new change set: its branch at the base's head, then, in one
   * transaction holding the old one's row, the check that it is still open
   * and nothing supersedes it yet, the change set, its `change-set.create`
   * event, the link, and the old one's locks released.
   */
  private async start(
    actor: Actor,
    source: ChangeSet,
    base: { name: string; commit: string; released: boolean },
  ): Promise<ChangeSet> {
    const now = new Date();
    const id = newChangeSetId(now.getTime());
    const changeSet: ChangeSet = {
      id,
      title: source.title,
      description: source.description,
      author: { kind: actor.kind, id: actor.id },
      baseRef: base.name,
      baseCommit: base.commit,
      baseReleased: base.released,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    // An orphan if the transaction refuses: the reconciler removes it.
    await this.branches.create(changeSet.branch, changeSet.baseCommit);
    await this.unit.run(async (tx) => {
      const locked = await this.store.lock(tx, source.id);
      if (!locked) throw new NotFoundError(`No change set "${source.id}".`);
      refuseClosed(locked);
      const active = await this.supersessions.activeOf(source.id, tx);
      if (active !== undefined) throw superseded(active);
      await this.store.insert(tx, changeSet);
      await this.supersessions.record(tx, {
        changeSetId: id,
        supersededId: source.id,
      });
      await this.auditLog.record(tx, actor, {
        action: 'change-set.create',
        subject: { type: 'change-set', id },
        data: {
          title: changeSet.title,
          baseRef: changeSet.baseRef,
          baseCommit: changeSet.baseCommit,
          baseReleased: changeSet.baseReleased,
          branch: changeSet.branch,
          supersedes: source.id,
        },
      });
      await this.releaseLocks(tx, actor, source.id);
    }, BOUNDED);
    return changeSet;
  }

  /** Releases every lock of `changeSetId`, each with its `lock.release` event. */
  private async releaseLocks(
    tx: Transaction,
    actor: Actor,
    changeSetId: string,
  ): Promise<void> {
    for (const lock of await this.locks.removeAllOf(tx, changeSetId)) {
      await this.auditLog.record(tx, actor, {
        action: 'lock.release',
        subject: subjectKey(lock.subject),
        data: { lockId: lock.id, changeSetId, reason: 'change-set.rebase' },
      });
    }
  }

  /**
   * Closes `source` as superseded by `changeSet`, in `tx` (the save
   * point's, or one of its own): abandoned while still open (its working
   * copies dropped, counted, and any lock taken again since released), and
   * the `change-set.rebase` event on it. Never throws for a change set
   * abandoned meanwhile: the commit has landed by then.
   */
  private async close(
    tx: Transaction,
    actor: Actor,
    source: ChangeSet,
    changeSet: ChangeSet,
    done: { commit?: string; applied: number; conflicts: number },
  ): Promise<void> {
    const locked = await this.store.lock(tx, source.id);
    if (locked && OPEN_STATES.includes(locked.state)) {
      const abandoned = await this.store.setState(tx, source.id, 'abandoned');
      const dropped = await this.workingCopies.removeAllOf(tx, source.id);
      await recordTransition(
        { auditLog: this.auditLog, events: this.events },
        tx,
        actor,
        source.id,
        {
          name: 'abandon',
          from: locked.state,
          to: abandoned.state,
          key: source.id,
          data: {
            supersededBy: changeSet.id,
            ...(dropped > 0 && { workingCopies: dropped }),
          },
        },
      );
      await this.releaseLocks(tx, actor, source.id);
    }
    await this.auditLog.record(tx, actor, {
      action: 'change-set.rebase',
      subject: { type: 'change-set', id: source.id },
      data: {
        changeSetId: changeSet.id,
        baseRef: changeSet.baseRef,
        onto: changeSet.baseCommit,
        ...(done.commit !== undefined && { commit: done.commit }),
        applied: done.applied,
        conflicts: done.conflicts,
      },
    });
  }

  private async outcome(
    source: ChangeSet,
    changeSet: ChangeSet,
    written: {
      commit?: string;
      applied: readonly LockSubject[];
      conflicts: readonly CarryConflict[];
    },
  ): Promise<RebaseChangeSetOutcome> {
    const [after, before] = await Promise.all([
      this.store.find(changeSet.id),
      this.store.find(source.id),
    ]);
    return {
      changeSet: after ?? changeSet,
      source: before ?? source,
      ...written,
    };
  }
}

/** 409 `invalid-state` for a change set no longer open. */
function refuseClosed(changeSet: ChangeSet): void {
  if (!OPEN_STATES.includes(changeSet.state)) {
    throw new ConflictError(
      'invalid-state',
      `The change set is ${changeSet.state}; only an open one is moved onto its current base.`,
      { state: changeSet.state },
    );
  }
}

/** 409 `already-superseded`: `changeSetId` holds its changes already. */
function superseded(changeSetId: string): ConflictError {
  return new ConflictError(
    'already-superseded',
    'The change set’s changes were moved onto its current base already.',
    { changeSetId },
  );
}
