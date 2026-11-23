import { createHash } from 'node:crypto';
import type { Actor, Scope } from './actor.js';
import { allows, ANYWHERE } from './allows.js';
import type { Permission } from './permissions.js';

/**
 * A key for everything that decides what `actor` sees reading with
 * `permission`: the scopes of the roles holding it, and whether it holds
 * `content.read.draft` (which shows what was left out). Two actors with the
 * same key see exactly the same; two that might see differently never share
 * one. Hex SHA-256, for cache keys and ETags.
 */
export function readingKey(actor: Actor, permission: Permission): string {
  const scopes = [
    ...new Set(
      actor.roles
        .filter((role) => role.permissions.includes(permission))
        .map((role) => canonical(role.scope)),
    ),
  ].sort();
  const notes = allows(actor, 'content.read.draft', ANYWHERE);
  return createHash('sha256')
    .update(JSON.stringify({ permission, scopes, notes }))
    .digest('hex');
}

/**
 * The same JSON for the same scope, whatever the order of its keys and
 * values; generic, so a dimension added to `Scope` later is part of it.
 */
function canonical(scope: Scope): string {
  return JSON.stringify(sortDeep(scope));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep).sort();
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]);
  }
  return value ?? null;
}
