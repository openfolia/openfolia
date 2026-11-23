import { z } from 'zod';

/**
 * Every permission there is. Permissions are code (an action checks one by
 * name); roles, which bundle them with a scope, are data.
 *
 * Adding one is a code change here; renaming or removing one also needs a
 * migration of the roles that hold it, since a role holding a permission
 * not listed here fails to load (`toRole`, `repos/drizzle-user-directory.ts`).
 */
export const PERMISSIONS = [
  /** Read released content (`main` and release tags). */
  'content.read',
  /** Read anything else: drafts on other branches and commits. */
  'content.read.draft',
  /** Change content (open and edit change sets). */
  'content.edit',
  /** Review a change. */
  'content.review',
  /** Sign off a change; restricted module types need it. */
  'content.approve',
  /** Cut a release. */
  'release.publish',
  /** Order and accept translations. */
  'translation.manage',
  /** Configure webhooks. */
  'webhook.manage',
  /** Define roles and assign them. */
  'admin.roles',
  /** Set the platform's branding: name, logos, icons and colours (#169). */
  'admin.branding',
  /** Configure the instance's backups, see their runs and hold the backup key (#529). */
  'admin.backups',
] as const;

export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

/**
 * Permissions about the system rather than about content: a role's scope
 * does not apply to them.
 */
export const GLOBAL_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'webhook.manage',
  'admin.roles',
  'admin.branding',
  'admin.backups',
]);

/**
 * Permissions that only read. A scope admits a read of a module shared with
 * content outside it; every other permission needs the module wholly inside
 * the scope (`allows`).
 */
export const READ_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'content.read',
  'content.read.draft',
]);
