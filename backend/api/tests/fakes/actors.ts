import type { Actor, Scope } from '../../src/access/core/actor.js';
import type { Permission } from '../../src/access/core/permissions.js';

/** A user holding `permissions` in one role with `scope` (everywhere by default). */
export const actorWith = (
  permissions: readonly Permission[],
  scope: Scope = {},
): Actor => ({
  kind: 'user',
  id: `holds-${permissions.join('-') || 'nothing'}`,
  roles: permissions.length
    ? [
        {
          id: 'test-role',
          name: 'Test role',
          permissions: [...permissions],
          scope,
        },
      ]
    : [],
});

/** Reads released content everywhere. */
export const READER = actorWith(['content.read']);

/** A user with no role at all: may act, but holds no permission. */
export const NOBODY = actorWith([]);
