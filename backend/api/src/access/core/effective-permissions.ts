import type { Actor, Scope } from './actor.js';
import {
  GLOBAL_PERMISSIONS,
  type Permission,
  PERMISSIONS,
} from './permissions.js';

/**
 * Per permission the actor holds, the scopes it holds it in (one per role;
 * `{}` for everywhere, which then stands alone). Global permissions are
 * always `[{}]`: a scope does not apply to them. In `PERMISSIONS` order;
 * permissions it does not hold are left out. For clients deciding what to offer; an action still
 * checks the target with `allows`.
 */
export interface EffectivePermission {
  readonly permission: Permission;
  readonly scopes: readonly Scope[];
}

/**
 * The permissions some of `roles` holds, in any scope, in `PERMISSIONS`
 * order, each once.
 */
export function heldPermissions(
  roles: readonly { readonly permissions: readonly Permission[] }[],
): Permission[] {
  return PERMISSIONS.filter((permission) =>
    roles.some((role) => role.permissions.includes(permission)),
  );
}

export function effectivePermissions(actor: Actor): EffectivePermission[] {
  const result: EffectivePermission[] = [];
  for (const permission of PERMISSIONS) {
    const holding = actor.roles.filter((role) =>
      role.permissions.includes(permission),
    );
    if (holding.length === 0) continue;
    const scopes = holding.map((role) => role.scope);
    if (
      GLOBAL_PERMISSIONS.has(permission) ||
      scopes.some((scope) => Object.keys(scope).length === 0)
    ) {
      result.push({ permission, scopes: [{}] });
      continue;
    }
    const seen = new Set<string>();
    const distinct = scopes.filter((scope) => {
      const key = JSON.stringify(scope);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    result.push({ permission, scopes: distinct });
  }
  return result;
}
