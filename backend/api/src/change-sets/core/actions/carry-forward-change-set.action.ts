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
import { RELEASED_BRANCH } from '../../../content/core/released.js';
import { MaintenanceLineStore } from '../../../releases/core/maintenance-line-store.js';
import { CarryChange, type CarryConflict } from '../carry-change.js';
import { CarryForwards } from '../carry-forwards.js';
import {
  type ChangeSet,
  ChangeSetTitle,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetEvents } from '../change-set-events.js';
import { ChangeSetStore } from '../change-set-store.js';
import { type LockSubject } from '../lock.js';
import { isActor, readsChangeSets } from '../own-work.js';
import { coversChanges } from '../review-scope.js';
import { Workflow } from '../workflow.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

export type { CarryConflict } from '../carry-change.js';

export interface CarryForwardInput {
  readonly actor: Actor;
  /** The change set to carry forward: merged into a maintenance line. */
  readonly id: string;
}

export interface CarryForwardOutcome {
  /** The new draft on `main`. */
  readonly changeSet: ChangeSet;
  /** The change set carried forward. */
  readonly source: ChangeSet;
  /** The commit holding what applied; undefined when nothing did. */
  readonly commit?: string;
  /** The subjects changed by that commit, in subject-key order. */
  readonly applied: readonly LockSubject[];
  /** What did not apply, by path. */
  readonly conflicts: readonly CarryConflict[];
}

/** The 403's detail for one who is neither the author nor an editor of all of it. */
export const CARRY_OUTSIDE_EDIT =
  'Only its author, or an editor whose roles cover everything it changes, carries a change set forward.';

/** What the commit on the new branch says (no trailer-like text in it). */
const carryMessage = (source: ChangeSet) =>
  `Carry forward change set ${source.id} from ${source.baseRef}`;

/**
 * Carries a fix forward (#60): a change set merged into a maintenance
 * line is applied again, as a new draft change set on `main`, by the
 * author or an editor (`content.edit`) whose scope covers all of it
 * (`coversChanges`). Never automatic.
 *
 * - **What is applied:** the change set's own diff (its base commit to its
 *   review head), three-way onto `main`'s head
 *   (`ChangeSetBranches.applyChange`: only that change, never what the
 *   line held before it). Each module, manual, configuration or term it
 *   changes is locked for the new change set (`AcquireLockAction`, with
 *   its scope rules on `main`), then what applied cleanly is committed on
 *   the new branch as a save point (`SavePoints.write`: intent, then the
 *   commit by compare-and-swap and its record).
 * - **What is not:** a path that conflicts, whose lock another change set
 *   holds, that the actor may not change on `main`, a module naming a
 *   file the actor may not use (`unknown-asset`, as a save refuses it,
 *   #335), or that is no subject
 *   (`CarryConflict`) is left as it is on `main` and listed, the subject
 *   and the blocks to apply by hand where it can tell; the locks taken
 *   stay, so the author fixes those in the editor.
 * - **Refused:** a change set not merged (409 `invalid-state`), not merged
 *   into a maintenance line (409 `not-on-maintenance-line`), carried
 *   forward already by a change set that is not abandoned (409
 *   `already-carried-forward`, `meta.changeSetId`), or that `main` holds
 *   already (409 `no-changes`); another author's is 404 for one who reads
 *   no drafts, as everywhere.
 *
 * **Order.** Git first: the new branch at `main`'s head; then one
 * transaction holding the carried change set's row (so two requests never
 * both carry it) records the new change set, its `change-set.create`
 * event (`data.carriedForwardFrom`) and the link (`CarryForwards`). Then
 * the locks and the save point; the `change-set.carry-forward` audit event
 * (on the carried change set) and outbox row (keyed by the new one), both
 * naming the two, are written in the save point's transaction. A request
 * cut off after the change set was recorded leaves it a draft for its
 * author (a commit that landed is recorded from its intent). The applying,
 * locking, checking and the save point are `CarryChange`'s, shared with
 * moving a change set onto a rewritten base (#471).
 */
@Injectable()
export class CarryForwardChangeSetAction extends ActorAction<
  CarryForwardInput,
  CarryForwardOutcome
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly store: ChangeSetStore,
    private readonly lines: MaintenanceLineStore,
    private readonly carries: CarryForwards,
    private readonly refs: ReadableRefs,
    private readonly branches: ChangeSetBranches,
    private readonly workflow: Workflow,
    private readonly carry: CarryChange,
    private readonly auditLog: AuditLog,
    private readonly events: ChangeSetEvents,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  /** Counted against a public sandbox's cap (#826): past it, 422 `sandbox-limit-reached`. */
  protected run(input: CarryForwardInput): Promise<CarryForwardOutcome> {
    return this.sandbox.counted('change-sets', () => this.make(input));
  }

  private async make({
    actor,
    id,
  }: CarryForwardInput): Promise<CarryForwardOutcome> {
    const source = await this.store.find(id);
    if (
      !source ||
      (!isActor(actor, source.author) && !readsChangeSets(actor))
    ) {
      throw new NotFoundError(`No change set "${id}".`);
    }
    if (source.state !== 'merged' || source.reviewHead === undefined) {
      throw new ConflictError(
        'invalid-state',
        `The change set is ${source.state}; only a merged one is carried forward.`,
        { state: source.state },
      );
    }
    const line = await this.lines.findByBranch(source.baseRef);
    // Exactly the line's branch: another case is another branch where
    // refs are case-sensitive.
    if (!line || line.branch !== source.baseRef) {
      throw new ConflictError(
        'not-on-maintenance-line',
        'The change set was not merged into a maintenance line.',
      );
    }
    const reviewHead = source.reviewHead;
    if (
      !isActor(actor, source.author) &&
      !coversChanges(
        actor,
        'content.edit',
        await this.workflow.changes(actor, source, reviewHead),
      )
    ) {
      throw new ForbiddenError(CARRY_OUTSIDE_EDIT);
    }
    await this.refuseCarried(source.id);

    const main = await this.refs.branch(actor, RELEASED_BRANCH);
    if (!main) {
      throw new ConflictError(
        'branch-missing',
        `There is no branch "${RELEASED_BRANCH}" to carry the change forward to.`,
      );
    }
    const plan = await this.carry.plan({
      from: source.baseCommit,
      to: reviewHead,
      onto: main.commit,
    });
    if (this.carry.isEmpty(plan)) {
      throw new ConflictError(
        'no-changes',
        `"${RELEASED_BRANCH}" holds this change already.`,
      );
    }

    const changeSet = await this.start(actor, source, main);
    const outcome = await this.carry.apply(actor, {
      changeSet,
      onto: main.commit,
      plan,
      source,
      sourceHead: reviewHead,
      // The files a module names: used on `main` (the new branch's start)
      // or on the line as the actor reads them, or uploaded into a change
      // set of theirs (#335).
      placesRef: source.baseRef,
      message: carryMessage(source),
      after: async (tx, done) => {
        const data = {
          changeSetId: changeSet.id,
          maintenanceLine: line.id,
          onto: main.commit,
          ...(done.commit !== undefined && { commit: done.commit }),
          applied: done.applied,
          conflicts: done.conflicts,
        };
        await this.auditLog.record(tx, actor, {
          action: 'change-set.carry-forward',
          subject: { type: 'change-set', id: source.id },
          data,
        });
        await this.events.emit(tx, {
          topic: 'change-set.carry-forward',
          key: changeSet.id,
          payload: {
            sourceId: source.id,
            actor: { kind: actor.kind, id: actor.id },
            ...data,
          },
        });
      },
    });
    return {
      changeSet: (await this.store.find(changeSet.id)) ?? changeSet,
      source,
      ...outcome,
    };
  }

  /**
   * 409 when a change set carrying `sourceId` forward is not abandoned;
   * read in `tx` when given.
   */
  private async refuseCarried(
    sourceId: string,
    tx?: Transaction,
  ): Promise<void> {
    const carried = await this.carries.activeOf(sourceId, tx);
    if (carried !== undefined) {
      throw new ConflictError(
        'already-carried-forward',
        'The change set was carried forward already.',
        { changeSetId: carried },
      );
    }
  }

  /**
   * The new change set on `main`: its branch at `main`'s head, then, in
   * one transaction holding the carried change set's row, the check that
   * nothing carries it yet, the change set, its `change-set.create` event
   * and the link.
   */
  private async start(
    actor: Actor,
    source: ChangeSet,
    main: { name: string; commit: string; released: boolean },
  ): Promise<ChangeSet> {
    const now = new Date();
    const id = newChangeSetId(now.getTime());
    const title = ChangeSetTitle.parse(
      `Carry forward: ${source.title}`.slice(0, 200),
    );
    const changeSet: ChangeSet = {
      id,
      title,
      description: null,
      author: { kind: actor.kind, id: actor.id },
      baseRef: main.name,
      baseCommit: main.commit,
      baseReleased: main.released,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    // An orphan if the transaction refuses: the reconciler removes it.
    await this.branches.create(changeSet.branch, changeSet.baseCommit);
    await this.unit.run(async (tx) => {
      if (!(await this.store.lock(tx, source.id))) {
        throw new NotFoundError(`No change set "${source.id}".`);
      }
      await this.refuseCarried(source.id, tx);
      await this.store.insert(tx, changeSet);
      await this.carries.record(tx, { changeSetId: id, sourceId: source.id });
      await this.auditLog.record(tx, actor, {
        action: 'change-set.create',
        subject: { type: 'change-set', id },
        data: {
          title,
          baseRef: changeSet.baseRef,
          baseCommit: changeSet.baseCommit,
          baseReleased: changeSet.baseReleased,
          branch: changeSet.branch,
          carriedForwardFrom: source.id,
        },
      });
    }, BOUNDED);
    return changeSet;
  }
}
