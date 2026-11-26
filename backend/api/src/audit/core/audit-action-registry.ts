/** A component's audit actions (`defineAuditActions`), under the component's name as their group. */
export interface AuditActionGroup<
  A extends readonly string[] = readonly string[],
> {
  readonly group: string;
  readonly actions: A;
}

/** A registered audit action and the group that registered it. */
export interface RegisteredAuditAction<A extends string = string> {
  readonly action: A;
  readonly group: string;
}

/**
 * The actions a component writes to the audit log, as `<subject>.<verb>`, under its name, for
 * `src/audit-actions.ts` to register. They stay literal types, so recording an action nobody
 * registered does not compile.
 */
export function defineAuditActions<const A extends readonly string[]>(
  group: string,
  actions: A,
): AuditActionGroup<A> {
  // Frozen, so no other module adds to a component's actions before they are registered.
  return Object.freeze({ group, actions: Object.freeze([...actions]) as A });
}

/**
 * Every group's actions, each frozen, the list too. The API does not start when an action is
 * registered twice (within a group or across two): each action has one component that writes
 * it, and none takes over another's.
 *
 * A `<component>.audit-actions.ts` imports nothing but this file: `core/audit-actions.ts` reads
 * the registry as it is imported, so an actions file that reached it would be a cycle.
 */
export function registerAuditActions<
  const G extends readonly AuditActionGroup[],
>(groups: G): readonly RegisteredAuditAction<G[number]['actions'][number]>[] {
  const owner = new Map<string, string>();
  const registered: RegisteredAuditAction<G[number]['actions'][number]>[] = [];
  for (const { group, actions } of groups)
    for (const action of actions) {
      const first = owner.get(action);
      if (first !== undefined)
        throw new Error(
          `The audit action "${action}" is registered by ${first} and by ${group}`,
        );
      owner.set(action, group);
      registered.push(Object.freeze({ action, group }));
    }
  return Object.freeze(registered);
}
