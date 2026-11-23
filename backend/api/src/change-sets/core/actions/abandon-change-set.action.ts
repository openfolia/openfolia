import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { type ChangeSet, OPEN_STATES } from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetEvents } from '../change-set-events.js';
import { ChangeSetStore } from '../change-set-store.js';
import { subjectKey } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { mergedMeanwhile, recordTransition, Workflow } from '../workflow.js';
import { ownChangeSet } from '../working-copy-rules.js';
import { isActor, readsChangeSets } from '../own-work.js';

const ONLY_ITS_AUTHOR = 'Only its author may abandon a change set.';

export interface AbandonChangeSetInput {
  readonly actor: Actor;
  readonly id: string;
  /** Why, for the audit log. */
  readonly comment?: string;
}

/**
 * Abandons an open change set: its state becomes `abandoned`, recorded in
 * the audit log and the outbox (`change-set.abandon`, keyed by the change
 * set) in the same transaction, which holds the change set's row
 * locked from the check to the change. Nothing is deleted in Git; the
 * branch stays readable. Only its author may abandon it (until the open
 * question on who else may says otherwise), with one exception: an admin
 * (`admin.roles`, reading change sets) may abandon another author's whose
 * branch is gone from the content repository (#317), as nothing of it can
 * be read or worked on any more (the event then says `data.branchMissing`).
 * For an actor who may not read change sets, another author's is not
 * found, exactly like a missing one. Its locks are released in the
 * same transaction, each with a `lock.release` audit event, and its
 * working copies are dropped (what was not committed is gone; the
 * abandon event counts them in `data.workingCopies` when there were any).
 */
@Injectable()
export class AbandonChangeSetAction extends ActorAction<
  AbandonChangeSetInput,
  ChangeSet
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly store: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly auditLog: AuditLog,
    private readonly events: ChangeSetEvents,
    private readonly unit: UnitOfWork,
    /** Asked whether an approved change set was merged meanwhile (always, in the app). */
    private readonly workflow?: Workflow,
    /** Asked whether its branch is gone, for an admin's abandon (always, in the app). */
    private readonly branches?: ChangeSetBranches,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    comment,
  }: AbandonChangeSetInput): Promise<ChangeSet> {
    const outcome = await runContended(
      this.unit,
      async (tx) => {
        // Another author's change set is not found, exactly like a missing
        // one, for an actor who may not read change sets (#125).
        const locked = await this.store.lock(tx, id);
        const byAdmin = await this.adminMayAbandon(locked, actor);
        const found =
          byAdmin && locked
            ? locked
            : ownChangeSet(locked, actor, id, ONLY_ITS_AUTHOR);
        if (!OPEN_STATES.includes(found.state)) {
          throw new ConflictError(
            'invalid-state',
            `The change set is ${found.state}; only an open one can be abandoned.`,
            { state: found.state },
          );
        }
        // A merge that landed but was never recorded is recorded, not lost
        // (#21): such a change set is merged, not abandoned.
        if (await this.workflow?.landedMerge(tx, found)) {
          return { merged: true as const };
        }
        const abandoned = await this.store.setState(tx, id, 'abandoned');
        const dropped = await this.workingCopies.removeAllOf(tx, id);
        // One audit event and one outbox row, as every transition (L8):
        // notifications and the review screen see an abandon too. Keyed by
        // the change set: it is abandoned once.
        await recordTransition(
          { auditLog: this.auditLog, events: this.events },
          tx,
          actor,
          id,
          {
            name: 'abandon',
            from: found.state,
            to: abandoned.state,
            key: id,
            ...(comment !== undefined && { comment }),
            data: {
              ...(dropped > 0 && { workingCopies: dropped }),
              ...(byAdmin && { branchMissing: true }),
            },
          },
        );
        for (const lock of await this.locks.removeAllOf(tx, id)) {
          await this.auditLog.record(tx, actor, {
            action: 'lock.release',
            subject: subjectKey(lock.subject),
            data: {
              lockId: lock.id,
              changeSetId: id,
              reason: 'change-set.abandon',
            },
          });
        }
        return abandoned;
      },
      BOUNDED,
    );
    if ('merged' in outcome) throw mergedMeanwhile();
    return outcome;
  }

  /**
   * Whether `actor` may abandon `found` as an admin, not as its author: they
   * are not its author, read change sets, hold `admin.roles`, and its branch
   * is gone (#317). Asked under the row lock, so the answer holds for this
   * abandon.
   */
  private async adminMayAbandon(
    found: ChangeSet | undefined,
    actor: Actor,
  ): Promise<boolean> {
    if (
      !found ||
      !this.branches ||
      isActor(actor, found.author) ||
      !readsChangeSets(actor) ||
      !allows(actor, 'admin.roles', ANYWHERE)
    ) {
      return false;
    }
    return (await this.branches.head(found.branch)) === undefined;
  }
}
