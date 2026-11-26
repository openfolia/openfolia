import { readFileSync } from 'node:fs';

/** A group a composition file imports, with the folder of its file and what it registers. */
export interface DefinedGroup {
  readonly folder: string;
  readonly group: string;
  /** Its events' types, its actions, its notification kinds or its settings' names. */
  readonly members: readonly string[];
  /** The group itself, so a spec can compare what it defines with what is registered. */
  readonly value: GroupValue;
}

/** What a group registers, by the list it holds them in. */
export interface GroupValue {
  readonly group?: unknown;
  readonly events?: readonly { readonly type: string }[];
  readonly actions?: readonly string[];
  readonly kinds?: readonly { readonly kind: string }[];
  readonly names?: readonly string[];
  readonly shape?: Readonly<Record<string, unknown>>;
}

const DEFINITION_FILE =
  /\.(webhook-events|audit-actions|notification-kinds|settings)$/;

/**
 * Every group a composition file (`src/webhook-events.ts`, `src/audit-actions.ts`,
 * `src/notification-kinds.ts`, `src/settings.ts`) imports from a component's definition file
 * (`<component>.webhook-events.ts`, `.audit-actions.ts`, `.notification-kinds.ts`,
 * `.settings.ts`): a registry trusts the name a group gives itself, so the specs hold each name to
 * its component's folder, and compare what these groups hold with what is registered, so a group
 * this does not find (an import of another form, a group defined elsewhere) fails too.
 */
export async function definedGroups(
  composition: string,
): Promise<DefinedGroup[]> {
  const src = new URL(`../src/${composition}`, import.meta.url);
  const imports = [
    ...readFileSync(src, 'utf8').matchAll(
      /from '\.\/([a-z0-9-]+)\/([a-z0-9.-]+)\.js'/g,
    ),
  ];
  const found: DefinedGroup[] = [];
  for (const [, folder = '', file = ''] of imports) {
    if (!DEFINITION_FILE.test(file)) continue;
    const module = (await import(
      new URL(`../src/${folder}/${file}.js`, import.meta.url).href
    )) as Record<string, GroupValue | undefined>;
    for (const value of Object.values(module))
      if (typeof value?.group === 'string') {
        const list =
          value.events ?? value.actions ?? value.kinds ?? value.names;
        // A group nobody can change: a hand-built one could be added to after this check.
        if (
          !Object.isFrozen(value) ||
          !Object.isFrozen(list) ||
          (value.shape !== undefined && !Object.isFrozen(value.shape)) ||
          ![...(value.events ?? []), ...(value.kinds ?? [])].every((e) =>
            Object.isFrozen(e),
          )
        )
          throw new Error(
            `The group ${value.group} in ${folder}/${file} is not frozen`,
          );
        found.push({
          folder,
          group: value.group,
          members:
            value.events?.map((e) => e.type) ??
            value.kinds?.map((k) => k.kind) ??
            value.actions ??
            value.names ??
            [],
          value,
        });
      }
  }
  return found;
}
