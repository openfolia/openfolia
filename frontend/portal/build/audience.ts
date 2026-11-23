import { AudienceError } from '../src/lib/modules.ts';
import { audienceRank } from '../src/lib/snapshot.ts';

/**
 * The build's audience rule: nothing above the build's audience level reaches the site. It is
 * held three times over, so no one mistake leaks: the token must read no more than the
 * audience (`checkReader`, before anything is fetched), every manual and every module the API
 * gives must be within it (`checkManual`, `checkModules`), and the pages check the snapshot
 * again (`parseSnapshot`).
 */
export { AudienceError, modulesOf } from '../src/lib/modules.ts';

export interface Level {
  readonly id: string;
}

interface Role {
  readonly id?: unknown;
  readonly permissions?: unknown;
  readonly scope?: { readonly maxAudience?: unknown };
}

/**
 * Refuses a token that may read more than the build's audience, or do more than read released
 * content: its every role holds `content.read` and nothing else, with a `maxAudience` at most
 * the build's. A role with no `maxAudience` reads every level, so it is refused too.
 */
export function checkReader(
  me: { attributes: Record<string, unknown> },
  audiences: readonly Level[],
  audience: string,
): void {
  const limit = rankOf(audiences, audience);
  if (me.attributes['kind'] !== 'service')
    throw new AudienceError('the token does not act as a service account');
  const roles = me.attributes['roles'];
  if (!Array.isArray(roles) || roles.length === 0)
    throw new AudienceError('the token holds no role');
  for (const role of roles as Role[]) {
    const name = typeof role.id === 'string' ? role.id : '?';
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    const other = permissions.filter((p) => p !== 'content.read');
    if (other.length > 0)
      throw new AudienceError(
        `the token's role "${name}" holds ${other.join(', ')}: a portal token holds only content.read`,
      );
    if (!permissions.includes('content.read'))
      throw new AudienceError(
        `the token's role "${name}" does not hold content.read`,
      );
    const max = role.scope?.maxAudience;
    if (typeof max !== 'string')
      throw new AudienceError(
        `the token's role "${name}" reads every audience level: give it a maxAudience of at most "${audience}"`,
      );
    const rank = audienceRank(audiences, max);
    if (rank === undefined || rank > limit)
      throw new AudienceError(
        `the token's role "${name}" reads up to "${max}", above the build's audience "${audience}"`,
      );
  }
}

/** A manual without an audience counts as the most restricted level, as the API reads it. */
export function checkManual(
  manual: { id: string; audience: string | undefined },
  audiences: readonly Level[],
  audience: string,
): string {
  const limit = rankOf(audiences, audience);
  const own = manual.audience ?? audiences[audiences.length - 1]?.id;
  const rank = audienceRank(audiences, own);
  if (own === undefined || rank === undefined || rank > limit)
    throw new AudienceError(
      `manual ${manual.id} is for "${own ?? 'no audience'}", above the build's audience "${audience}": the token reads more than it should`,
    );
  return own;
}

/**
 * The audience of each module the manual holds, checked: a module the token cannot list (so
 * its audience is unknown) or one above the build's audience refuses the build.
 */
export function checkModules(
  manualId: string,
  modules: Iterable<string>,
  audienceOf: (module: string) => string | undefined,
  audiences: readonly Level[],
  audience: string,
): Record<string, string> {
  const limit = rankOf(audiences, audience);
  const seen: Record<string, string> = {};
  for (const module of [...modules].sort()) {
    const own = audienceOf(module);
    if (own === undefined)
      throw new AudienceError(
        `manual ${manualId} holds module ${module}, whose audience the token cannot read`,
      );
    const rank = audienceRank(audiences, own);
    if (rank === undefined || rank > limit)
      throw new AudienceError(
        `manual ${manualId} holds module ${module} for "${own}", above the build's audience "${audience}"`,
      );
    seen[module] = own;
  }
  return seen;
}

function rankOf(audiences: readonly Level[], audience: string): number {
  const rank = audienceRank(audiences, audience);
  if (rank === undefined)
    throw new AudienceError(
      `the build's audience "${audience}" is not a configured audience level (${audiences.map((a) => a.id).join(', ')})`,
    );
  return rank;
}
