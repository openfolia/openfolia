import type { z } from 'zod';

/** A check across a group's settings, for `Env.superRefine`: it adds an issue per problem. */
export type SettingsCheck<E> = (env: E, ctx: z.RefinementCtx) => void;

/** A component's settings (`defineSettings`), under the component's name as their group. */
export interface SettingsGroup<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly group: string;
  /** Its settings' names, as the environment and `.env.example` spell them. */
  readonly names: readonly (keyof S & string)[];
  readonly shape: Readonly<S>;
  readonly check?: SettingsCheck<z.infer<z.ZodObject<S>>>;
}

/** Any group, whatever its settings (a check of some settings is no check of all). */
interface AnySettingsGroup {
  readonly group: string;
  readonly names: readonly string[];
  readonly shape: Readonly<z.ZodRawShape>;
  readonly check?: SettingsCheck<never>;
}

/** All the groups' shapes as one: each group's names with their schemas' types. */
type Merged<G extends readonly AnySettingsGroup[]> = (
  G[number] extends infer U
    ? U extends { readonly shape: infer S }
      ? (shape: S) => void
      : never
    : never
) extends (shape: infer I) => void
  ? I & z.ZodRawShape
  : never;

/** Every group's settings together (`registerSettings`). */
export interface RegisteredSettings<S extends z.ZodRawShape> {
  /** Each setting's name and the group that registered it, in the order given. */
  readonly names: readonly { readonly name: string; readonly group: string }[];
  /** The settings' schemas, by name, for `Env`. */
  readonly shape: Readonly<S>;
  /** Each group's check, in the order given. */
  readonly checks: readonly SettingsCheck<z.infer<z.ZodObject<S>>>[];
}

/**
 * A component's settings (`env`, a schema of `CCMS_*` names) and its check across them, under
 * its name, for `src/settings.ts` to register, frozen so no other module changes them first.
 */
export function defineSettings<S extends z.ZodRawShape>(
  group: string,
  env: z.ZodObject<S>,
  check?: SettingsCheck<z.infer<z.ZodObject<S>>>,
): SettingsGroup<S> {
  // A refinement of the whole object would be lost here: it goes in `check`.
  if (env._zod.def.checks?.length)
    throw new Error(
      `The settings of ${group} are refined as a whole: pass the check as defineSettings' check`,
    );
  const shape = Object.freeze({ ...env.shape });
  return Object.freeze({
    group,
    names: Object.freeze(Object.keys(shape) as (keyof S & string)[]),
    shape,
    ...(check && { check }),
  });
}

/** A component's setting's name, as `.env.example` documents it. */
const SETTING_NAME = /^CCMS_[A-Z0-9_]+$/;

/**
 * Every group's settings, frozen. The API does not start when a setting is no `CCMS_` name or
 * is registered twice
 * (within a group or across two), so no component replaces another's setting or its check;
 * `config/env.ts` refuses one the platform reads itself.
 *
 * A `<component>.settings.ts` imports nothing that reaches `config/env.ts`: `config/env.ts` reads
 * the registry as it is imported, so a settings file that reached it would be a cycle.
 */
export function registerSettings<const G extends readonly AnySettingsGroup[]>(
  groups: G,
): RegisteredSettings<Merged<G>> {
  const owner = new Map<string, string>();
  const names: { readonly name: string; readonly group: string }[] = [];
  const shape: Record<string, unknown> = {};
  const checks: unknown[] = [];
  for (const { group, names: own, shape: schemas, check } of groups) {
    for (const name of own) {
      if (
        typeof name !== 'string' ||
        !SETTING_NAME.test(name) ||
        !Object.hasOwn(schemas, name)
      )
        throw new Error(
          `The setting ${String(name)} of ${group} is no CCMS_ name with a schema`,
        );
      const first = owner.get(name);
      if (first !== undefined)
        throw new Error(
          `The setting ${name} is registered by ${first} and by ${group}`,
        );
      owner.set(name, group);
      names.push(Object.freeze({ name, group }));
      shape[name] = schemas[name];
    }
    if (check) checks.push(check);
  }
  return Object.freeze({
    names: Object.freeze(names),
    shape: Object.freeze(shape) as Readonly<Merged<G>>,
    checks: Object.freeze(checks) as RegisteredSettings<Merged<G>>['checks'],
  });
}
