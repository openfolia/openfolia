import { AuditLog } from '../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  UnprocessableError,
} from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { AccessAdmin } from './access-admin.js';
import type { Actor } from './actor.js';

/**
 * Starts an access change in `tx`: takes the access lock, then checks that
 * the actor still is an active user holding `admin.roles` now. The policy
 * checked the roles the request was resolved with; this closes the gap to
 * the change itself, so an admin whose role was just taken away, or who was
 * just deactivated, cannot change access in a request already under way.
 */
export async function beginAccessChange(
  admin: AccessAdmin,
  tx: Transaction,
  actor: Actor,
): Promise<void> {
  await admin.lock(tx);
  const user =
    actor.kind === 'user' ? await admin.findUser(tx, actor.id) : undefined;
  if (!user || user.deactivatedAt !== null) {
    throw new ForbiddenError('This needs the admin.roles permission.');
  }
  const held = await admin.heldPermissions(tx, actor.id);
  if (!held.has('admin.roles')) {
    throw new ForbiddenError('This needs the admin.roles permission.');
  }
}

/**
 * Refuses (409 `last-admin`, rolling the change back) when the change made
 * in `tx` so far leaves no active user holding `admin.roles`: someone must
 * always be able to administer access.
 */
export async function keepAnAdmin(
  admin: AccessAdmin,
  tx: Transaction,
): Promise<void> {
  if ((await admin.countActiveAdmins(tx)) === 0) {
    throw new ConflictError(
      'last-admin',
      'This would leave no active user holding admin.roles. Give the role to someone else first.',
    );
  }
}

/** Roles to give a user and roles to take from it. */
export interface RoleChange {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

/**
 * Gives the user `userId` the roles in `add` and takes those in `remove`,
 * inside `tx` (after `beginAccessChange`), each recorded as `role.assign`
 * or `role.unassign` (subject the role, `data.userId` the user). A role it
 * holds already, or does not hold, is left as it is and not recorded. 422
 * `unknown-role` (`meta.roles`) when a role to add does not exist; 409
 * `last-admin` when taking a role leaves no active user holding
 * `admin.roles`.
 */
export async function changeRoles(
  admin: AccessAdmin,
  auditLog: AuditLog,
  tx: Transaction,
  actor: Actor,
  userId: string,
  { add = [], remove = [] }: RoleChange,
): Promise<void> {
  const missing = await admin.missingRoles(tx, add);
  if (missing.length > 0) {
    throw new UnprocessableError(
      'unknown-role',
      `No role ${missing.map((id) => `"${id}"`).join(', ')}.`,
      { roles: missing },
    );
  }
  let tookAdmin = false;
  for (const roleId of remove) {
    if (!(await admin.unassign(tx, userId, roleId))) continue;
    const role = await admin.findRole(roleId, tx);
    if (role?.permissions.includes('admin.roles')) tookAdmin = true;
    await auditLog.record(tx, actor, {
      action: 'role.unassign',
      subject: { type: 'role', id: roleId },
      data: { userId },
    });
  }
  for (const roleId of add) {
    if (!(await admin.assign(tx, userId, roleId))) continue;
    await auditLog.record(tx, actor, {
      action: 'role.assign',
      subject: { type: 'role', id: roleId },
      data: { userId },
    });
  }
  if (tookAdmin) await keepAnAdmin(admin, tx);
}
