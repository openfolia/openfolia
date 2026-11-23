import { createHash } from 'node:crypto';
import type { Actor, Role, Scope } from '../../access/core/actor.js';

/**
 * The scopes a reader reads released content in: those of their roles
 * holding `content.read`, each as canonical JSON (keys and values
 * sorted), each once, sorted. Two readers with the same list see exactly
 * the same chunks; it is all the feed keeps of who someone was.
 */
export function readerScopes(actor: Actor): string[] {
  return [
    ...new Set(
      actor.roles
        .filter((role) => role.permissions.includes('content.read'))
        .map((role) => canonical(role.scope)),
    ),
  ].sort();
}

/** SHA-256 hex over `readerScopes`: what a cursor names a scope by. */
export function scopeDigest(scopes: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['change-feed-scopes:v1', ...scopes]))
    .digest('hex');
}

/**
 * A reader of released content in exactly these scopes, and nothing
 * else: how the feed reads what someone saw (or sees), whoever they are.
 * A service ID outside the `UserId` format, so no user is ever it.
 */
export function readerOf(scopes: readonly string[]): Actor {
  return Object.freeze({
    kind: 'service',
    id: 'service:change-feed',
    roles: Object.freeze(
      scopes.map((scope, i): Role =>
        Object.freeze({
          id: `feed-scope-${i}`,
          name: 'Change feed (read-only)',
          permissions: ['content.read' as const],
          scope: JSON.parse(scope) as Scope,
        }),
      ),
    ),
  }) as Actor;
}

/**
 * Port: the scopes behind a digest (`change_feed_scopes`), kept so a
 * cursor need only name its digest. Content-addressed and only added to.
 */
export abstract class FeedScopes {
  /** Keeps `scopes` under their digest; nothing when they are kept already. */
  abstract save(digest: string, scopes: readonly string[]): Promise<void>;

  /** The scopes kept under `digest`; undefined for none. */
  abstract find(digest: string): Promise<readonly string[] | undefined>;
}

function canonical(scope: Scope): string {
  return JSON.stringify(sortKeys(scope));
}

/** The scope with its keys and its lists sorted (an object stays an object, so `JSON.parse` gives a `Scope` back). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sortKeys)
      .sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
