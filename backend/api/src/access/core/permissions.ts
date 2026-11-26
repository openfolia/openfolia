import { z } from 'zod';
import { REGISTERED_PERMISSIONS } from '../../permissions.js';

/**
 * Every permission there is, in the order the components registered them (`src/permissions.ts`,
 * each component's `<component>.permissions.ts`). Permissions are code (an action checks one by
 * name); roles, which bundle them with a scope, are data.
 *
 * Renaming or removing one also needs a migration of the roles that hold it, since a role holding
 * a permission not registered fails to load (`toRole`, `repos/drizzle-user-directory.ts`).
 */
export const PERMISSIONS = Object.freeze(
  REGISTERED_PERMISSIONS.map((p) => p.key),
);

export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

/** A set nothing can add to or take from once made: these decide where a scope applies. */
function fixedSet(keys: readonly Permission[]): ReadonlySet<Permission> {
  const set = new Set(keys);
  const refuse = (): never => {
    throw new TypeError('The registered permissions cannot be changed');
  };
  set.add = refuse;
  set.delete = refuse;
  set.clear = refuse;
  return Object.freeze(set);
}

/**
 * Permissions about the system rather than about content: a role's scope
 * does not apply to them.
 */
export const GLOBAL_PERMISSIONS = fixedSet(
  REGISTERED_PERMISSIONS.filter((p) => p.global).map((p) => p.key),
);

/**
 * Permissions that only read. A scope admits a read of a module shared with
 * content outside it; every other permission needs the module wholly inside
 * the scope (`allows`).
 */
export const READ_PERMISSIONS = fixedSet(
  REGISTERED_PERMISSIONS.filter((p) => p.read).map((p) => p.key),
);
