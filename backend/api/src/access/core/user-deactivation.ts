import type { AuditLog } from '../../audit/core/audit-log.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { subjectKey } from '../../change-sets/core/lock.js';
import type { LockStore } from '../../change-sets/core/lock-store.js';
import type { AccessAdmin } from './access-admin.js';
import { keepAnAdmin } from './access-changes.js';
import type { Actor } from './actor.js';
import type { WaysIn } from './ways-in.js';

/** What deactivating a user needs: the ports it writes through. */
export interface Deactivation {
  readonly admin: AccessAdmin;
  readonly locks: LockStore;
  readonly waysIn: WaysIn;
  readonly auditLog: AuditLog;
}

/**
 * Deactivates the active user `userId` inside `tx` (after the access lock): from its next
 * request on it cannot act, every lock it holds is released (each a `lock.release`, `reason`
 * `user.deactivate`), and its sessions, links to set a password and open code by email end
 * (`WaysIn.endAll`). Its roles, change sets and comments stay. 409 `last-admin` when it was the
 * last active user holding `admin.roles`. Recorded as `user.deactivate`, with `data` added
 * (`via`, say). Answers when it was deactivated and how many locks it lost. Shared by the admin
 * screens (`DeactivateUserAction`) and provisioning (#377).
 */
export async function deactivateUserIn(
  { admin, locks, waysIn, auditLog }: Deactivation,
  tx: Transaction,
  actor: Actor,
  userId: string,
  data: Record<string, unknown> = {},
): Promise<{ deactivatedAt: Date | null; locksReleased: number }> {
  const deactivatedAt = await admin.setDeactivated(tx, userId, true);
  await keepAnAdmin(admin, tx);
  const released = await locks.removeAllHeldBy(tx, {
    kind: 'user',
    id: userId,
  });
  const sessionsEnded = await waysIn.endAll(tx, userId);
  await auditLog.record(tx, actor, {
    action: 'user.deactivate',
    subject: { type: 'user', id: userId },
    data: { ...data, locksReleased: released.length, sessionsEnded },
  });
  for (const lock of released) {
    await auditLog.record(tx, actor, {
      action: 'lock.release',
      subject: subjectKey(lock.subject),
      data: {
        lockId: lock.id,
        changeSetId: lock.changeSetId,
        reason: 'user.deactivate',
        holder: { kind: 'user', id: userId },
      },
    });
  }
  return { deactivatedAt, locksReleased: released.length };
}

/**
 * Lets the deactivated user `userId` act again, with the roles it had, inside `tx` (after the
 * access lock). Recorded as `user.reactivate`, with `data` added.
 */
export async function reactivateUserIn(
  admin: AccessAdmin,
  auditLog: AuditLog,
  tx: Transaction,
  actor: Actor,
  userId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await admin.setDeactivated(tx, userId, false);
  await auditLog.record(tx, actor, {
    action: 'user.reactivate',
    subject: { type: 'user', id: userId },
    ...(data && { data }),
  });
}
