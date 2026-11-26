import { AccessAdmin } from '../../access/core/access-admin.js';
import type { Actor } from '../../access/core/actor.js';
import { ServiceAccountStore } from '../../access/core/service-accounts.js';
import { ForbiddenError } from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';

/** The permission every SCIM route needs (#377). */
export const SCIM_PERMISSION = 'scim.provision';

const refused = () =>
  new ForbiddenError(
    `Provisioning needs a service account's token whose roles hold ${SCIM_PERMISSION}.`,
  );

/**
 * Refuses (403 `forbidden`) an actor that is not a service account: a directory acts through a
 * service account's token, never as a person, whatever a person's roles hold.
 */
export function directoryOnly(actor: Actor): void {
  if (actor.kind !== 'service') throw refused();
}

/**
 * Starts a provisioning change in `tx`: takes the access lock (`AccessAdmin.lock`, so it and the
 * admin screens change access one at a time), then checks that the actor still is an active
 * service account with a role holding `scim.provision` now, as `beginAccessChange` does for an
 * admin: a token whose account was just deactivated, or whose role was just taken, cannot change
 * anything in a request already under way.
 */
export async function beginScimChange(
  admin: AccessAdmin,
  accounts: ServiceAccountStore,
  tx: Transaction,
  actor: Actor,
): Promise<void> {
  directoryOnly(actor);
  await admin.lock(tx);
  const account = await accounts.find(actor.id, tx);
  if (!account || account.deactivatedAt !== null) throw refused();
  for (const roleId of account.roleIds) {
    const role = await admin.findRole(roleId, tx);
    if (role?.permissions.includes(SCIM_PERMISSION)) return;
  }
  throw refused();
}
