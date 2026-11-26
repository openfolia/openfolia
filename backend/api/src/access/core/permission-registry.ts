/**
 * One permission, as the component that checks it registers it. Permissions are code (an action
 * checks one by key); roles, which bundle them with a scope, are data.
 */
export interface PermissionDefinition {
  /** What roles store and actions check, e.g. `content.read`. Never renamed without a migration. */
  readonly key: string;
  /**
   * Its text in the editor's translations: the key the editor's `PERMISSION_TEXTS` gives it for
   * Admin › Roles, and the permissions reference shows, in every language.
   */
  readonly labelKey: string;
  /** What it allows, for whoever reads the code. */
  readonly description: string;
  /**
   * About the system rather than about content: a role's scope does not apply to it. Only ever a
   * literal `true` (or left out; an explicit `undefined` is refused at start too), so what skips
   * scope checks is plain to see.
   */
  readonly global?: true;
  /**
   * It only reads: a scope admits a read of a module shared with content outside it; every other
   * permission needs the module wholly inside the scope (`allows`). A literal `true` or left out.
   */
  readonly read?: true;
}

/** A component's permissions (`definePermissions`), under the component's name as their group. */
export interface PermissionGroup<
  P extends readonly PermissionDefinition[] = readonly PermissionDefinition[],
> {
  readonly group: string;
  readonly permissions: P;
}

/** A registered permission: its definition and the group that registered it. */
export type RegisteredPermission<K extends string = string> =
  PermissionDefinition & { readonly key: K; readonly group: string };

/**
 * A component's permissions under its name, for `src/permissions.ts` to register. The keys stay
 * literal types, so a check of a key nobody registered does not compile.
 */
export function definePermissions<
  const P extends readonly PermissionDefinition[],
>(group: string, permissions: P): PermissionGroup<P> {
  return { group, permissions };
}

/**
 * Every group's permissions in the order given, each frozen, the list too. Refuses a key twice
 * (within a group or across two), so a component can neither replace another's permission nor
 * widen it (make it global or read-only), and a `global` or `read` that is not `true`: the API
 * does not start.
 *
 * A `<component>.permissions.ts` imports nothing but this file: `access/core/permissions.ts`
 * reads the registry as it is imported, so a permissions file that reached it would be a cycle.
 */
export function registerPermissions<const G extends readonly PermissionGroup[]>(
  groups: G,
): readonly RegisteredPermission<G[number]['permissions'][number]['key']>[] {
  const owner = new Map<string, string>();
  const registered: RegisteredPermission<
    G[number]['permissions'][number]['key']
  >[] = [];
  for (const { group, permissions } of groups)
    for (const permission of permissions) {
      const first = owner.get(permission.key);
      if (first !== undefined)
        throw new Error(
          `The permission "${permission.key}" is registered by ${first} and by ${group}`,
        );
      for (const flag of ['global', 'read'] as const)
        if (flag in permission && permission[flag] !== true)
          throw new Error(
            `The permission "${permission.key}" of ${group} has ${flag} set to something other than true`,
          );
      owner.set(permission.key, group);
      registered.push(Object.freeze({ ...permission, group }));
    }
  return Object.freeze(registered);
}
