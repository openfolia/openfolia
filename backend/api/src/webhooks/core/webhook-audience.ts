import type { Actor } from '../../access/core/actor.js';

/**
 * `owner` as a subscriber with an audience limit (#254) reads: every role's
 * `maxAudience` narrowed to `max` where it reaches further, so the
 * subscriber hears only of content at `max` or a less restricted level,
 * and never of more than its owner may read. `audiences` is the
 * configuration's order, least to most restricted.
 *
 * Fails closed, as `allows` does: a `max` the configuration does not hold
 * becomes every role's limit, which matches nothing; a role's own level the
 * configuration does not hold is kept (it matches nothing already).
 */
export function capAudience(
  owner: Actor,
  max: string,
  audiences: readonly string[],
): Actor {
  const cap = audiences.indexOf(max);
  return {
    kind: owner.kind,
    id: owner.id,
    roles: owner.roles.map((role) => {
      const own = role.scope.maxAudience;
      const ownAt = own === undefined ? -1 : audiences.indexOf(own);
      const keepOwn =
        own !== undefined && (ownAt === -1 || (cap !== -1 && ownAt <= cap));
      return {
        ...role,
        scope: { ...role.scope, maxAudience: keepOwn ? own : max },
      };
    }),
  };
}
