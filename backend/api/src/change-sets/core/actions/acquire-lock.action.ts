import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import { runContended, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ChangeSet, ChangeSetState } from '../change-set.js';
import { ChangeSetStore } from '../change-set-store.js';
import {
  type Lock,
  type LockSubject,
  MAX_LOCKS_PER_HOLDER,
  newLockId,
  subjectKey,
} from '../lock.js';
import { type HoldingChangeSet, LockHolding } from '../lock-holding.js';
import { LockStore } from '../lock-store.js';
import { seesLock } from '../lock-visibility.js';
import { checkCommittedScope } from '../subject-scope.js';
import { authorsChangeSet, ownChangeSet } from '../working-copy-rules.js';

export interface AcquireLockInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly subject: LockSubject;
}

export interface AcquireLockResult {
  readonly lock: Lock;
  /** False when the change set held it already (nothing changed). */
  readonly created: boolean;
}

/** The states a change set can take locks in. */
export const LOCKING_STATES: readonly ChangeSetState[] = ['draft'];

/**
 * How often a subject that was locked, but whose lock was gone when read
 * again, is tried again before giving up.
 */
const ATTEMPTS = 3;

/**
 * What a refusal says about who holds a subject (`meta` of 409 `locked`):
 * the lock, and the change set holding it (#472) while it is there.
 */
export const lockedMeta = (lock: Lock, holding?: HoldingChangeSet) => ({
  lockId: lock.id,
  holder: lock.holder,
  changeSetId: lock.changeSetId,
  since: lock.since.toISOString(),
  ...(holding && {
    changeSetTitle: holding.title,
    changeSetState: holding.state,
    hasChanges: holding.hasChanges,
  }),
});

/**
 * Takes the lock on a module or manual for a change set, so nobody else
 * changes it meanwhile: a `lock.acquire` audit event in the same
 * transaction. Only the change set's author takes locks for it (another
 * author's change set is not found, exactly like a missing one, for an
 * actor who may not read change sets: `ownChangeSet`), and only while it
 * is a draft. The subject, as committed on the change set's branch, must
 * lie within the actor's scope as for every change of it
 * (`checkCommittedScope`: a module's language, type, audience and facets,
 * a manual's audience; a new one only for an actor who edits and reads all
 * of its language, or manuals of every audience). A subject the change set
 * holds already is answered with its lock (nothing changes, nothing is
 * audited); one locked by another change set is 409 `locked`, naming the
 * holder, and that change set's title, state and whether it has changes to
 * the subject (`LockHolding`, #472), only to an actor who may know of that
 * lock (`seesLock`). One holder
 * holds at most `MAX_LOCKS_PER_HOLDER` locks, across change sets.
 *
 * The change set's row is locked from the check to the end, so it cannot
 * be abandoned meanwhile (abandoning releases its locks: none is left on a
 * closed change set). The database decides between two change sets taking
 * one subject at once (a unique constraint): exactly one gets it.
 */
@Injectable()
export class AcquireLockAction extends ActorAction<
  AcquireLockInput,
  AcquireLockResult
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly holding: LockHolding,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    subject,
  }: AcquireLockInput): Promise<AcquireLockResult> {
    const found = await authorsChangeSet(
      this.changeSets,
      actor,
      changeSetId,
      NOT_THE_AUTHOR,
    );
    checkState(found);
    // Git is read before the transaction, so no row stays locked meanwhile.
    const snapshot = await this.openSnapshot.handle({
      actor,
      ref: found.branch,
    });
    await checkCommittedScope(actor, snapshot, subject);
    const result = await runContended(
      this.unit,
      async (tx): Promise<AcquireLockResult | { heldByOther: Lock }> => {
        // Locked to the end: it cannot be abandoned meanwhile.
        const changeSet = ownChangeSet(
          await this.changeSets.lock(tx, changeSetId),
          actor,
          changeSetId,
          NOT_THE_AUTHOR,
        );
        checkState(changeSet);
        const holder = { kind: actor.kind, id: actor.id };
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const held = await this.locks.findBySubject(tx, subject);
          if (held) {
            if (held.changeSetId === changeSetId) {
              return { lock: held, created: false };
            }
            // Refused after the transaction: whether the actor may know of
            // the lock is read from its change set's branch (Git).
            return { heldByOther: held };
          }
          if (
            (await this.locks.countHeldBy(tx, holder)) >= MAX_LOCKS_PER_HOLDER
          ) {
            throw new ConflictError(
              'too-many-locks',
              `One holder holds at most ${MAX_LOCKS_PER_HOLDER} locks; release some first.`,
              { max: MAX_LOCKS_PER_HOLDER },
            );
          }
          const lock = await this.locks.insert(tx, {
            id: newLockId(),
            subject,
            changeSetId,
            holder,
          });
          if (lock) {
            await this.auditLog.record(tx, actor, {
              action: 'lock.acquire',
              subject: subjectKey(subject),
              data: { lockId: lock.id, changeSetId },
            });
            return { lock, created: true };
          }
          // Taken by a concurrent transaction since the read above: read
          // the lock that won (or, if it is gone again already, try again).
        }
        throw new ConflictError(
          'lock-contended',
          'The subject is being locked and released by others; try again.',
        );
      },
    );
    if ('heldByOther' in result) {
      const held = result.heldByOther;
      if (!(await seesLock(this.openSnapshot, actor, held))) throw locked();
      // What the holding change set did is extra: failing to read it never
      // turns the refusal into a 500 that hides the lock.
      const holding = await this.holding
        .describe(held.changeSetId, held.subject)
        .catch(() => undefined);
      throw locked(held, holding);
    }
    return result;
  }
}

const NOT_THE_AUTHOR = 'Only its author may take locks for a change set.';

/** 409 `invalid-state` unless the change set takes locks. */
function checkState(changeSet: ChangeSet): void {
  if (!LOCKING_STATES.includes(changeSet.state)) {
    throw new ConflictError(
      'invalid-state',
      `The change set is ${changeSet.state}; only a draft takes locks.`,
      { state: changeSet.state },
    );
  }
}

/**
 * The refusal of a held subject: who holds it (`lock`) only for an actor
 * who may know of the lock anyway (`seesLock`: it would be listed to them).
 */
function locked(lock?: Lock, holding?: HoldingChangeSet): ConflictError {
  if (!lock) {
    return new ConflictError('locked', 'Someone else holds the lock.');
  }
  return new ConflictError(
    'locked',
    `${lock.holder.kind === 'user' ? 'User' : 'Service'} "${lock.holder.id}" holds the lock, for change set ${lock.changeSetId}.`,
    lockedMeta(lock, holding),
  );
}
