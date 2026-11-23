import { and, arrayOverlaps, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../database/database.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import { Role, RoleId, UserEmail, UserId } from '../core/actor.js';
import { GroupName } from '../core/group-mappings.js';
import { addressReplaced, WaysIn } from '../core/ways-in.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleEmailCodes } from './drizzle-email-codes.js';
import { DrizzleSignInLinks } from './drizzle-passwords.js';
import { applyGroupRolesIn, DrizzleSessionStore } from './drizzle-sign-in.js';
import { groupRoles, userIdentities } from './sign-in.tables.js';

const unique = (ids: string[]) => new Set(ids).size === ids.length;

/**
 * Roles and users to put into the database (`pnpm nx run api:db-seed -- --example | <file.json>`):
 * the bundled example (`example-seed.ts`) or a JSON file of this shape.
 */
export const Seed = z
  .strictObject({
    roles: z
      .array(Role)
      .refine((items) => unique(items.map((r) => r.id)), 'duplicate role id'),
    users: z
      .array(
        z.strictObject({
          id: UserId,
          name: z.string().trim().min(1).max(200),
          email: UserEmail.optional(),
          roles: z.array(RoleId).refine(unique, 'duplicate role'),
        }),
      )
      .refine((items) => unique(items.map((u) => u.id)), 'duplicate user id'),
    /**
     * Groups whose members hold a role (#37), e.g. the provider's admin
     * group: added when missing, never removed (an admin removes one).
     */
    groupMappings: z
      .array(z.strictObject({ group: GroupName, role: RoleId }))
      .refine(
        (items) => unique(items.map((m) => `${m.group}\u0000${m.role}`)),
        'duplicate group mapping',
      )
      .optional(),
  })
  .superRefine((seed, ctx) => {
    const known = new Set(seed.roles.map((r) => r.id));
    seed.users.forEach((user, index) => {
      for (const role of user.roles) {
        if (!known.has(role)) {
          ctx.addIssue({
            code: 'custom',
            message: `role "${role}" is not in the seed's roles`,
            path: ['users', index, 'roles'],
          });
        }
      }
    });
    seed.groupMappings?.forEach((mapping, index) => {
      if (!known.has(mapping.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `role "${mapping.role}" is not in the seed's roles`,
          path: ['groupMappings', index, 'role'],
        });
      }
    });
  });
export type Seed = z.infer<typeof Seed>;

/**
 * Writes the seed, in one transaction: each role and user is created or
 * updated to match it, and each seeded user holds exactly the seed's roles.
 * Running it again changes nothing; roles and users it does not name are
 * left alone. An address it replaces ends what was emailed to the old one
 * (#646, `WaysIn.endMailed`: the links and the open code), as an admin's
 * change does.
 */
export async function seedAccess(
  database: Database,
  seed: Seed,
): Promise<void> {
  const waysIn = new WaysIn(
    new DrizzleSessionStore(database),
    new DrizzleSignInLinks(database),
    new DrizzleEmailCodes(database),
  );
  await new DrizzleUnitOfWork(database).run(async (transaction) => {
    const tx = drizzleOf(transaction);
    for (const role of seed.roles) {
      const columns = {
        name: role.name,
        permissions: role.permissions,
        languages: role.scope.languages ?? null,
        moduleTypes: role.scope.moduleTypes ?? null,
        maxAudience: role.scope.maxAudience ?? null,
        facets: role.scope.facets ?? null,
      };
      await tx
        .insert(roles)
        .values({ id: role.id, ...columns })
        .onConflictDoUpdate({ target: roles.id, set: columns });
    }
    for (const user of seed.users) {
      const [before] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      await tx
        .insert(users)
        .values({ id: user.id, name: user.name, email: user.email ?? null })
        .onConflictDoUpdate({
          target: users.id,
          // A seed without an email address keeps the one an admin set.
          set: {
            name: user.name,
            ...(user.email !== undefined && { email: user.email }),
          },
        });
      if (
        before &&
        user.email !== undefined &&
        addressReplaced(before.email, user.email)
      ) {
        await waysIn.endMailed(transaction, user.id);
      }
      // Exactly the seed's roles directly; a role also held through a group stays held that way (#37).
      const notSeeded = and(
        eq(roleAssignments.userId, user.id),
        // Empty: every role of the user (Drizzle makes it `true`).
        notInArray(roleAssignments.roleId, user.roles),
      );
      await tx
        .delete(roleAssignments)
        .where(and(notSeeded, eq(roleAssignments.viaGroups, false)));
      await tx.update(roleAssignments).set({ direct: false }).where(notSeeded);
      if (user.roles.length > 0) {
        await tx
          .insert(roleAssignments)
          .values(
            user.roles.map((roleId) => ({
              userId: user.id,
              roleId,
              direct: true,
            })),
          )
          .onConflictDoUpdate({
            target: [roleAssignments.userId, roleAssignments.roleId],
            set: { direct: true },
          });
      }
    }
    const mappings = seed.groupMappings ?? [];
    if (mappings.length > 0) {
      await tx
        .insert(groupRoles)
        .values(mappings.map(({ group, role }) => ({ group, roleId: role })))
        .onConflictDoNothing({ target: [groupRoles.group, groupRoles.roleId] });
      // People who signed in in those groups hold the roles at once.
      const members = await tx
        .selectDistinct({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          arrayOverlaps(
            userIdentities.groups,
            mappings.map((m) => m.group),
          ),
        );
      for (const { userId } of members) await applyGroupRolesIn(tx, userId);
    }
  });
}
