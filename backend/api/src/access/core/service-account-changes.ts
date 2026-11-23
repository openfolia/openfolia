import { AuditLog } from '../../audit/core/audit-log.js';
import { NotFoundError, UnprocessableError } from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { AccessAdmin } from './access-admin.js';
import type { RoleChange } from './access-changes.js';
import type { Actor } from './actor.js';
import {
  type ServiceAccount,
  ServiceAccountStore,
} from './service-accounts.js';

/** 404 `not-found` for no such service account. */
export const noServiceAccount = (id: string) =>
  new NotFoundError(`No service account "${id}".`);

/** The service account `id`, read inside `tx`; 404 when there is none. */
export async function serviceAccountIn(
  store: ServiceAccountStore,
  tx: Transaction,
  id: string,
): Promise<ServiceAccount> {
  const account = await store.find(id, tx);
  if (!account) throw noServiceAccount(id);
  return account;
}

/**
 * Gives the service account `id` the roles in `add` and takes those in
 * `remove`, inside `tx` (after `beginAccessChange`), each recorded as
 * `role.assign` or `role.unassign` (subject the role,
 * `data.serviceAccountId` the account). A role it holds already, or does
 * not hold, is left as it is and not recorded. 422 `unknown-role`
 * (`meta.roles`) when a role to add does not exist, 422
 * `admin-role-for-service-account` (`meta.roles`) for a role holding
 * `admin.roles`: least privilege, a machine never reads or breaks what
 * only administrators may (users' email addresses, the audit log, locks). No `last-admin` check:
 * a service account never counts as an admin (only people administer
 * access, `beginAccessChange`).
 */
export async function changeServiceAccountRoles(
  admin: AccessAdmin,
  store: ServiceAccountStore,
  auditLog: AuditLog,
  tx: Transaction,
  actor: Actor,
  id: string,
  { add = [], remove = [] }: RoleChange,
): Promise<void> {
  const missing = await admin.missingRoles(tx, add);
  if (missing.length > 0) {
    throw new UnprocessableError(
      'unknown-role',
      `No role ${missing.map((r) => `"${r}"`).join(', ')}.`,
      { roles: missing },
    );
  }
  const administering: string[] = [];
  for (const roleId of add) {
    const role = await admin.findRole(roleId, tx);
    if (role?.permissions.includes('admin.roles')) administering.push(roleId);
  }
  if (administering.length > 0) {
    throw new UnprocessableError(
      'admin-role-for-service-account',
      `A service account cannot hold a role with admin.roles (${administering.map((r) => `"${r}"`).join(', ')}): access is administered by people.`,
      { roles: administering },
    );
  }
  for (const roleId of remove) {
    if (!(await store.unassign(tx, id, roleId))) continue;
    await auditLog.record(tx, actor, {
      action: 'role.unassign',
      subject: { type: 'role', id: roleId },
      data: { serviceAccountId: id },
    });
  }
  for (const roleId of add) {
    if (!(await store.assign(tx, id, roleId))) continue;
    await auditLog.record(tx, actor, {
      action: 'role.assign',
      subject: { type: 'role', id: roleId },
      data: { serviceAccountId: id },
    });
  }
}
