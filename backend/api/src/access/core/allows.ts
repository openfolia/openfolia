import type { ModuleMeta, ProjectConfig } from '@openfolia/content-model';
import type { Actor, Role, Scope } from './actor.js';
import {
  GLOBAL_PERMISSIONS,
  type Permission,
  READ_PERMISSIONS,
} from './permissions.js';

/**
 * The content a permission is checked against: what a module says about
 * itself, and the audience order of the configuration it was read with.
 * Every key is required, so a caller states "none" (`undefined`, `{}`)
 * rather than forgetting a dimension.
 */
export interface ContentTarget {
  /** The configuration's audience levels, least to most restricted. */
  readonly audiences: readonly string[];
  /** The configuration's facet IDs: a scope's facet not among them matches nothing. */
  readonly facetIds: readonly string[];
  readonly lang: string | undefined;
  readonly moduleType: string | undefined;
  /** Missing: the most restricted configured level ("internal" by default). */
  readonly audience: string | undefined;
  /** The module's facet values; a facet it does not name applies to all its values. */
  readonly facets: Readonly<Record<string, readonly string[]>>;
}

/**
 * Whether some role grants the permission at all, whatever the scope: for
 * deciding whether to offer something. An action on content checks the
 * content itself.
 */
export const ANYWHERE = 'anywhere';

/** The target for one module, read with `config`. */
export function moduleTarget(
  meta: Pick<ModuleMeta, 'lang' | 'type' | 'audience' | 'facets'>,
  config: Pick<ProjectConfig, 'audiences' | 'facets'>,
): ContentTarget {
  return {
    audiences: config.audiences.map((a) => a.id),
    facetIds: config.facets.map((f) => f.id),
    lang: meta.lang,
    moduleType: meta.type,
    audience: meta.audience,
    facets: meta.facets,
  };
}

/**
 * Whether `actor` may use `permission` on `target`: one of its roles holds
 * the permission and, unless the permission is global (`GLOBAL_PERMISSIONS`),
 * the target lies within that same role's scope. Pure; fails closed on
 * anything it cannot place (an unknown audience, a dimension the target
 * leaves out).
 */
export function allows(
  actor: Actor,
  permission: Permission,
  target: ContentTarget | typeof ANYWHERE,
): boolean {
  return actor.roles.some(
    (role) =>
      role.permissions.includes(permission) &&
      (target === ANYWHERE ||
        GLOBAL_PERMISSIONS.has(permission) ||
        inScope(role, target, READ_PERMISSIONS.has(permission))),
  );
}

/**
 * Within a scope, per dimension it restricts:
 * - language, module type: the target's is one of the scope's (none: outside);
 * - audience: the target's level (none: the most restricted) is at most the
 *   scope's `maxAudience`; a level not configured is outside;
 * - each facet: one the configuration does not define is outside; to
 *   read, the target names none of that facet's values (it
 *   applies to all) or shares one with the scope; for anything else it names
 *   at least one and all of them are the scope's, so a change never reaches
 *   content outside it.
 */
function inScope(role: Role, target: ContentTarget, read: boolean): boolean {
  const scope: Scope = role.scope;
  if (scope.languages && !includes(scope.languages, target.lang)) return false;
  if (scope.moduleTypes && !includes(scope.moduleTypes, target.moduleType)) {
    return false;
  }
  if (scope.maxAudience !== undefined) {
    const max = target.audiences.indexOf(scope.maxAudience);
    const level =
      target.audience === undefined
        ? target.audiences.length - 1
        : target.audiences.indexOf(target.audience);
    if (max < 0 || level < 0 || level > max) return false;
  }
  for (const [facet, allowed] of Object.entries(scope.facets ?? {})) {
    // A facet the configuration does not define (renamed, mistyped) would
    // otherwise be named by no module, so apply to all: fail closed.
    if (!target.facetIds.includes(facet)) return false;
    const named = Object.hasOwn(target.facets, facet)
      ? (target.facets[facet] ?? [])
      : [];
    const inside = read
      ? named.length === 0 || named.some((value) => allowed.includes(value))
      : named.length > 0 && named.every((value) => allowed.includes(value));
    if (!inside) return false;
  }
  return true;
}

function includes(list: readonly string[], value: string | undefined): boolean {
  return value !== undefined && list.includes(value);
}

/**
 * Whether some role grants `permission` on everything in language `lang`:
 * its scope restricts nothing but languages, and those include `lang`. For
 * content whose other dimensions cannot be known (a file that cannot be
 * read): only such an actor may learn anything about it.
 */
export function allowsAllIn(
  actor: Actor,
  permission: Permission,
  lang: string,
): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes(permission) &&
      (GLOBAL_PERMISSIONS.has(permission) ||
        (Object.entries(scope).every(
          ([dimension, value]) =>
            dimension === 'languages' || value === undefined,
        ) &&
          (scope.languages === undefined || scope.languages.includes(lang)))),
  );
}

/**
 * Whether one role grants `permission` on everything in each of `langs`
 * at once (`'every'`: in every language): its scope restricts nothing but
 * languages, and those include all of them. Roles never combine. For
 * content that has languages but no type, audience or facets (a term).
 */
export function allowsAllInEach(
  actor: Actor,
  permission: Permission,
  langs: readonly string[] | 'every',
): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes(permission) &&
      (GLOBAL_PERMISSIONS.has(permission) ||
        (Object.entries(scope).every(
          ([dimension, value]) =>
            dimension === 'languages' || value === undefined,
        ) &&
          (scope.languages === undefined ||
            (langs !== 'every' &&
              langs.every((lang) => scope.languages?.includes(lang)))))),
  );
}

/** Whether some role holds `permission` with a scope that restricts nothing. */
export function allowsUnrestricted(
  actor: Actor,
  permission: Permission,
): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes(permission) &&
      (GLOBAL_PERMISSIONS.has(permission) ||
        Object.values(scope).every((value) => value === undefined)),
  );
}

/**
 * What a manual is checked against: its audience, with the configuration's
 * order, and the language it is read in (`undefined`: any one). A manual is
 * not classified by module type or facets; those decide which of its
 * modules a reader sees, not whether they see the manual.
 */
export interface ManualTarget {
  readonly audiences: readonly string[];
  /** Missing: the most restricted configured level, as for a module. */
  readonly audience: string | undefined;
  readonly lang: string | undefined;
}

/**
 * Whether `actor` may use `permission` on a manual: one of its roles holds
 * the permission, and that same role's `maxAudience` covers the manual's
 * audience and its `languages` the language (when one is given). Fails
 * closed on an audience that is not configured.
 */
export function allowsManual(
  actor: Actor,
  permission: Permission,
  target: ManualTarget,
): boolean {
  return actor.roles.some(({ permissions, scope }) => {
    if (!permissions.includes(permission)) return false;
    if (GLOBAL_PERMISSIONS.has(permission)) return true;
    if (
      target.lang !== undefined &&
      scope.languages &&
      !scope.languages.includes(target.lang)
    ) {
      return false;
    }
    if (scope.maxAudience === undefined) return true;
    const max = target.audiences.indexOf(scope.maxAudience);
    const level =
      target.audience === undefined
        ? target.audiences.length - 1
        : target.audiences.indexOf(target.audience);
    return max >= 0 && level >= 0 && level <= max;
  });
}
