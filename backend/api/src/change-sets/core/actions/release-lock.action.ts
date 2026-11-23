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
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ChangeSet } from '../change-set.js';
import { ChangeSetStore } from '../change-set-store.js';
import { type Lock, type LockHolder, subjectKey } from '../lock.js';
import { type CommittedChanges, LockHolding } from '../lock-holding.js';
import { LockStore } from '../lock-store.js';
import { seesLock } from '../lock-visibility.js';

/**
 * Releases a lock its holder no longer needs: removed, with a
 * `lock.release` audit event, in one transaction that holds the lock's
 * row from the check to the removal. Only the holder releases a lock;
 * anyone else needs an admin to break it (`BreakLockAction`). Someone
 * else's lock is 403 only for an actor who may know of it (`seesLock`: a
 * draft reader whose scope covers its subject); for anyone else it is not
 * found, exactly like a lock that does not exist (#125).
 *
 * `ifUnchanged` (#472: the holder frees a subject from another of their
 * change sets) releases it only while its change set has no changes to
 * the subject: no working copy of it and no commit changing it since its
 * base (`LockHolding`); else 409 `has-changes` and the lock stays. The
 * working copy and the branch's head are read again while the lock's row
 * is held, so no save or save point of the subject (both hold that row)
 * slips in between the check and the release.
 */
@Injectable()
export class ReleaseLockAction extends ActorAction<ReleaseLockInput, Lock> {
  readonly policy = 'content.edit';

  constructor(
    private readonly locks: LockStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly changeSets: ChangeSetStore,
    private readonly holding: LockHolding,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    ifUnchanged = false,
  }: ReleaseLockInput): Promise<Lock> {
    const notFound = () => new NotFoundError(`No lock "${id}".`);
    const found = await this.locks.find(id);
    if (!found) throw notFound();
    if (!holds(actor, found.holder)) {
      // Git is read before the transaction, so no row stays locked meanwhile.
      if (!(await seesLock(this.openSnapshot, actor, found))) throw notFound();
      throw new ForbiddenError(
        'Only its holder may release a lock; an admin may break it.',
      );
    }
    // Git is read before the transaction, so no row stays locked meanwhile
    // (again inside it only when the branch moved since).
    const changeSet = ifUnchanged
      ? await this.changeSets.find(found.changeSetId)
      : undefined;
    const committed =
      changeSet && (await this.holding.committed(changeSet, found.subject));
    return runContended(
      this.unit,
      async (tx) => {
        // A lock's ID is new for every lock taken, so its holder is the one
        // checked above; gone meanwhile (released, broken) it is not found.
        const lock = await this.locks.lock(tx, id);
        if (!lock || !holds(actor, lock.holder)) throw notFound();
        if (ifUnchanged) {
          await this.checkUnchanged(tx, lock, changeSet, committed);
        }
        await this.locks.remove(tx, id);
        await this.auditLog.record(tx, actor, {
          action: 'lock.release',
          subject: subjectKey(lock.subject),
          data: { lockId: lock.id, changeSetId: lock.changeSetId },
        });
        return lock;
      },
      // Bounded, as breaking one is: with `ifUnchanged` the row stays held across a Git read.
      BOUNDED,
    );
  }

  /**
   * 409 `has-changes` unless the lock's change set has no working copy of
   * its subject and no commit changing it; read inside `tx`, which holds
   * the lock's row (`before`: the branch as read before it).
   */
  private async checkUnchanged(
    tx: Transaction,
    lock: Lock,
    changeSet: ChangeSet | undefined,
    before: CommittedChanges | undefined,
  ): Promise<void> {
    const refuse = () =>
      new ConflictError(
        'has-changes',
        'The change set holding the lock has changes to its subject; the lock stays.',
        { changeSetId: lock.changeSetId },
      );
    // Gone meanwhile (abandoned): its locks went with it, so this is not reached.
    if (!changeSet || !before) throw refuse();
    if (await this.holding.hasWorkingCopy(tx, lock.changeSetId, lock.subject)) {
      throw refuse();
    }
    // A save point that landed since the read above moved the branch.
    const head = await this.holding.head(changeSet);
    const now =
      head === before.head
        ? before
        : await this.holding.committed(
            (await this.changeSets.find(changeSet.id)) ?? changeSet,
            lock.subject,
          );
    if (now.changed) throw refuse();
  }
}

export interface ReleaseLockInput {
  readonly actor: Actor;
  readonly id: string;
  /** Only while the lock's change set has no changes to its subject (#472). */
  readonly ifUnchanged?: boolean;
}

const holds = (actor: Actor, holder: LockHolder) =>
  holder.kind === actor.kind && holder.id === actor.id;
