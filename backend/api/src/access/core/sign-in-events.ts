import type { AuditLog } from '../../audit/core/audit-log.js';
import type { Transaction } from '../../base/core/unit-of-work.js';

/** Port: what sign-ins tell others of, written in the sign-in's transaction (the outbox). */
export abstract class SignInEvents {
  /**
   * The break-glass account was used (#378): those who are administrators now are told, whatever
   * becomes of their roles after, by an email queued at once and a notification
   * (`sign-in.break-glass`) nobody turns off.
   */
  abstract breakGlassUsed(tx: Transaction, userId: string): Promise<void>;
}

/** Records a use of the break-glass account, and tells the administrators. */
export async function recordBreakGlassUse(
  auditLog: AuditLog,
  events: SignInEvents,
  tx: Transaction,
  userId: string,
): Promise<void> {
  await auditLog.record(
    tx,
    { kind: 'user', id: userId, roles: [] },
    {
      action: 'user.break-glass-sign-in',
      subject: { type: 'user', id: userId },
    },
  );
  await events.breakGlassUsed(tx, userId);
}
