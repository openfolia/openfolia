/**
 * How a person hears of one kind of notification (#884): `off` (neither the bell nor email),
 * `app` (the bell only), `email` (the bell and an email at once) or `digest` (the bell and the
 * daily summary email).
 */
export const DELIVERY_CHOICES = Object.freeze([
  'off',
  'app',
  'email',
  'digest',
] as const);

/** A kind a person chooses how to hear of. */
export interface ChosenKindDefinition {
  /** The outbox topic it is made from, e.g. `change-set.submit`. Never renamed: choices store it. */
  readonly kind: string;
  /** The group of the settings page it is shown in (`src/notification-kinds.ts` lists them). */
  readonly section: string;
  /** What a person who chose nothing gets. */
  readonly defaultChoice: (typeof DELIVERY_CHOICES)[number];
  readonly chosen?: never;
}

/**
 * A kind nobody chooses about: it cannot be turned off, and is in the bell whatever a person
 * set. Only ever a literal `false`, so what nobody can turn off is plain to see.
 */
export interface UnchosenKindDefinition {
  readonly kind: string;
  readonly chosen: false;
  readonly section?: never;
  readonly defaultChoice?: never;
}

export type NotificationKindDefinition =
  ChosenKindDefinition | UnchosenKindDefinition;

/** A component's notification kinds (`defineNotificationKinds`), under the component's name. */
export interface NotificationKindGroup<
  K extends readonly NotificationKindDefinition[] =
    readonly NotificationKindDefinition[],
> {
  readonly group: string;
  readonly kinds: K;
}

/** A registered notification kind: its definition and the group that registered it. */
export type RegisteredNotificationKind<
  D extends NotificationKindDefinition = NotificationKindDefinition,
> = D & { readonly group: string };

/**
 * A component's notification kinds under its name, for `src/notification-kinds.ts` to register,
 * frozen so no other module adds to them first. The kinds stay literal types.
 */
export function defineNotificationKinds<
  const K extends readonly NotificationKindDefinition[],
>(group: string, kinds: K): NotificationKindGroup<K> {
  return Object.freeze({
    group,
    kinds: Object.freeze(kinds.map((k) => Object.freeze({ ...k }))) as K,
  });
}

/** An outbox topic's name: lowercase words joined by `-`, in at least two parts joined by `.`. */
const KIND_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Every group's kinds in the order given, each frozen, the list too. The API does not start when
 * a kind is registered twice (within a group or across two), so no component replaces another's
 * kind or changes whether it can be turned off; nor when a kind is no topic name, its `chosen` anything but
 * `false`, when a kind nobody chooses about has a section or a default, or when a chosen one's
 * section is not one of `sections` or its default not a delivery choice.
 *
 * A `<component>.notification-kinds.ts` imports nothing but this file: `core/notification.ts`
 * reads the registry as it is imported, so a kinds file that reached it would be a cycle.
 */
export function registerNotificationKinds<
  const G extends readonly NotificationKindGroup[],
>(
  groups: G,
  sections: readonly string[],
): readonly RegisteredNotificationKind<G[number]['kinds'][number]>[] {
  const owner = new Map<string, string>();
  const registered: RegisteredNotificationKind<G[number]['kinds'][number]>[] =
    [];
  for (const { group, kinds } of groups)
    for (const given of kinds) {
      // What is checked is what is registered: the definition's own fields, copied once, so
      // nothing inherited or computed reads one way here and another in the copy.
      const definition = { ...given };
      const { kind } = definition;
      if (typeof kind !== 'string' || !KIND_NAME.test(kind))
        throw new Error(
          `The notification kind "${String(kind)}" of ${group} is no topic name`,
        );
      const first = owner.get(kind);
      if (first !== undefined)
        throw new Error(
          `The notification kind "${kind}" is registered by ${first} and by ${group}`,
        );
      const problem = Object.hasOwn(definition, 'chosen')
        ? definition.chosen !== false
          ? 'has chosen set to something other than false'
          : Object.hasOwn(definition, 'section') ||
              Object.hasOwn(definition, 'defaultChoice')
            ? 'is chosen by nobody but has a section or a default'
            : undefined
        : !sections.includes(definition.section ?? '')
          ? `has the section "${definition.section}", which is not listed`
          : !(DELIVERY_CHOICES as readonly string[]).includes(
                definition.defaultChoice ?? '',
              )
            ? `has the default "${definition.defaultChoice}", which is no delivery choice`
            : undefined;
      if (problem !== undefined)
        throw new Error(
          `The notification kind "${kind}" of ${group} ${problem}`,
        );
      owner.set(kind, group);
      registered.push(
        Object.freeze({ ...definition, group }) as RegisteredNotificationKind<
          G[number]['kinds'][number]
        >,
      );
    }
  return Object.freeze(registered);
}
