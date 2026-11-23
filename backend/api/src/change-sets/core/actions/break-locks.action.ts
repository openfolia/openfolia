import { randomUUID } from 'node:crypto';
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
import { type ChangeSetEvent, ChangeSetEvents } from '../change-set-events.js';
import { ChangeSetStore } from '../change-set-store.js';
import { type Lock, type LockHolder, subjectKey } from '../lock.js';
import { LockStore } from '../lock-store.js';

/** Which locks to break: all of one change set, or all of one holder. */
export type BreakLocksTarget =
  | { readonly changeSetId: string; readonly holder?: undefined }
  | { readonly holder: LockHolder; readonly changeSetId?: undefined };

export type BreakLocksInput = {
  readonly actor: Actor;
  /** Why, for the audit log: required. */
  readonly comment: string;
} & BreakLocksTarget;

/**
 * An admin breaks every lock of a change set, or of a holder (who left,
 * or lost `content.edit` and so cannot release), in one transaction, and
 * is told how many there were. Each lock gets its own `lock.break` audit
 * event, as breaking one does (and as abandoning a change set audits each
 * release), so `filter[subject]` on the audit log shows a subject's whole
 * lock history; the comment is on each. One `lock.break` outbox row per
 * change set whose locks it broke tells each holder once (#252). Needs
 * `admin.roles`.
 *
 * Bounded: one holder holds at most `MAX_LOCKS_PER_HOLDER` locks (the
 * acquire path counts them), and a change set has one holder, so a call
 * breaks at most that many.
 *
 * It cannot race with taking a lock: by change set it locks the change
 * set's row, as acquire does from its check to its end; by holder it takes
 * the per-holder lock acquire counts under. A lock taken after this ends
 * is a new one, and stays.
 */
@Injectable()
export class BreakLocksAction extends ActorAction<BreakLocksInput, number> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly auditLog: AuditLog,
    private readonly events: ChangeSetEvents,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    comment,
    ...target
  }: BreakLocksInput): Promise<number> {
    return runContended(
      this.unit,
      async (tx) => {
        let broken;
        let scope: Record<string, unknown>;
        if (target.holder) {
          const holder = { kind: target.holder.kind, id: target.holder.id };
          broken = await this.locks.removeAllHeldBy(tx, holder);
          scope = { bulk: 'holder' };
        } else {
          const id = target.changeSetId ?? '';
          if (!(await this.changeSets.lock(tx, id))) {
            throw new NotFoundError(`No change set "${id}".`);
          }
          broken = await this.locks.removeAllOf(tx, id);
          scope = { bulk: 'change-set' };
        }
        for (const lock of broken) {
          await this.auditLog.record(tx, actor, {
            action: 'lock.break',
            subject: subjectKey(lock.subject),
            comment,
            data: {
              lockId: lock.id,
              changeSetId: lock.changeSetId,
              holder: { kind: lock.holder.kind, id: lock.holder.id },
              ...scope,
            },
          });
        }
        const byChangeSet = Map.groupBy(broken, (lock) => lock.changeSetId);
        for (const [changeSetId, locks] of byChangeSet) {
          await this.events.emit(
            tx,
            lockBreakEvent(actor, locks, `${changeSetId}/${randomUUID()}`),
          );
        }
        return broken.length;
      },
      BOUNDED,
    );
  }
}

/**
 * The outbox row of breaking `locks`, all of one change set (and so of one
 * holder, its author): `lock.break`, with the change set, the holder, the
 * admin, the subjects (as the audit log names them) and how many.
 */
export function lockBreakEvent(
  actor: Actor,
  locks: readonly Lock[],
  key: string,
): ChangeSetEvent {
  const [first] = locks;
  if (!first) throw new Error('No lock to report broken.');
  return {
    topic: 'lock.break',
    key,
    payload: {
      changeSetId: first.changeSetId,
      actor: { kind: actor.kind, id: actor.id },
      holder: { kind: first.holder.kind, id: first.holder.id },
      subjects: locks.map((lock) => {
        const { type, id } = subjectKey(lock.subject);
        return `${type}/${id}`;
      }),
      count: locks.length,
    },
  };
}
