import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { ChangeSetEvents } from '../change-set-events.js';
import { type Lock, subjectKey } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { lockBreakEvent } from './break-locks.action.js';

export interface BreakLockInput {
  readonly actor: Actor;
  readonly id: string;
  /** Why, for the audit log: required. */
  readonly comment: string;
}

/**
 * An admin breaks someone's lock (a holder who is away, a change set left
 * open): removed, with a `lock.break` audit event naming the holder and
 * the admin's comment, in one transaction. The lock is named by its ID, so
 * a lock released and taken again meanwhile (a new ID) is not broken by
 * mistake. A `lock.break` outbox row (keyed by the lock: it is broken
 * once) tells its holder (#252). Needs `admin.roles` (until the open
 * question on who may break locks says otherwise).
 */
@Injectable()
export class BreakLockAction extends ActorAction<BreakLockInput, Lock> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly locks: LockStore,
    private readonly auditLog: AuditLog,
    private readonly events: ChangeSetEvents,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, id, comment }: BreakLockInput): Promise<Lock> {
    return runContended(
      this.unit,
      async (tx) => {
        const lock = await this.locks.lock(tx, id);
        if (!lock) throw new NotFoundError(`No lock "${id}".`);
        await this.locks.remove(tx, id);
        await this.auditLog.record(tx, actor, {
          action: 'lock.break',
          subject: subjectKey(lock.subject),
          comment,
          data: {
            lockId: lock.id,
            changeSetId: lock.changeSetId,
            holder: { kind: lock.holder.kind, id: lock.holder.id },
          },
        });
        await this.events.emit(tx, lockBreakEvent(actor, [lock], lock.id));
        return lock;
      },
      BOUNDED,
    );
  }
}
