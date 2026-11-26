import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database, type Drizzle } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { type Actor, Role, UserId } from '../core/actor.js';
import { heldPermissions } from '../core/effective-permissions.js';
import { Permission } from '../core/permissions.js';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import {
  type User,
  UserDirectory,
  type UserFilter,
} from '../core/user-directory.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { signInLinks, userPasswords } from './passwords.tables.js';
import { secondFactors } from './second-factors.tables.js';
import { userIdentities } from './sign-in.tables.js';

/**
 * Stored data that breaks the model (an unknown permission, a malformed
 * scope). A bug or a bad manual edit, never the client's fault: the API
 * answers it with a 500 and logs this message.
 */
export class InvalidStoredDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoredDataError';
  }
}

/** A `roles` row as the model's `Role`; throws `InvalidStoredDataError` when it is not one. */
export function toRole(row: typeof roles.$inferSelect): Role {
  const scope: Record<string, unknown> = {};
  if (row.languages !== null) scope['languages'] = row.languages;
  if (row.moduleTypes !== null) scope['moduleTypes'] = row.moduleTypes;
  if (row.maxAudience !== null) scope['maxAudience'] = row.maxAudience;
  if (row.facets !== null) scope['facets'] = row.facets;
  const parsed = Role.safeParse({
    id: row.id,
    name: row.name,
    permissions: row.permissions,
    scope,
  });
  if (!parsed.success) {
    const unknown = row.permissions.filter(
      (p) => !Permission.safeParse(p).success,
    );
    throw new InvalidStoredDataError(
      `Role "${row.id}" in the database is invalid` +
        (unknown.length > 0
          ? ` (unknown permissions: ${unknown.map((p) => JSON.stringify(p)).join(', ')})`
          : '') +
        `:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** `UserDirectory` over the `users`, `roles` and `role_assignments` tables. */
@Injectable()
export class DrizzleUserDirectory extends UserDirectory {
  constructor(private readonly database: Database) {
    super();
  }

  async findActor(
    userId: string,
    tx?: Transaction,
  ): Promise<Actor | undefined> {
    // Not a user ID at all: no such user, without a query.
    if (!UserId.safeParse(userId).success) return undefined;
    // One query, so the user and its roles are read together.
    const rows = await (tx ? drizzleOf(tx) : this.database.db)
      .select({ userId: users.id, role: roles })
      .from(users)
      .leftJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .leftJoin(roles, eq(roles.id, roleAssignments.roleId))
      // A deactivated user acts as nobody.
      .where(and(eq(users.id, userId), isNull(users.deactivatedAt)))
      .orderBy(asc(roles.id));
    const [first] = rows;
    if (!first) return undefined;
    return {
      kind: 'user',
      id: first.userId,
      roles: rows.flatMap(({ role }) => (role ? [toRole(role)] : [])),
    };
  }

  async findUser(userId: string): Promise<User | undefined> {
    return findUserIn(this.database.db, userId);
  }

  async listUsers(
    page: PageRequest,
    filter: UserFilter = {},
  ): Promise<Paginated<User>> {
    const where = whereUsers(filter);
    // One snapshot, so the total matches the page.
    return this.database.db.transaction(
      async (tx) => {
        const [counted] = await tx
          .select({ total: count() })
          .from(users)
          .where(where);
        const rows = await tx
          .select(USER_COLUMNS)
          .from(users)
          .where(where)
          // Byte order, as `UserId`s compare in code, whatever the collation.
          .orderBy(sql`${users.id} collate "C"`)
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        const held = await rolesOf(
          tx,
          rows.map((u) => u.id),
        );
        return {
          items: rows.map((u) => ({
            ...asUser(u),
            ...(held.get(u.id) ?? NO_ROLES),
          })),
          total: counted?.total ?? 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

const USER_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  deactivatedAt: users.deactivatedAt,
  // How the person signs in (#610).
  hasPassword: sql<boolean>`exists (select 1 from ${userPasswords} where ${userPasswords.userId} = ${users.id})`,
  hasIdentity: sql<boolean>`exists (select 1 from ${userIdentities} where ${userIdentities.userId} = ${users.id})`,
  secondFactor: sql<boolean>`exists (select 1 from ${secondFactors} where ${secondFactors.userId} = ${users.id} and ${secondFactors.confirmedAt} is not null)`,
  inviteExpiresAt: sql<
    string | null
  >`(select ${signInLinks.expiresAt} from ${signInLinks} where ${signInLinks.userId} = ${users.id} and ${signInLinks.kind} = 'invite')`,
};

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  deactivatedAt: Date | null;
  hasPassword: boolean;
  hasIdentity: boolean;
  secondFactor: boolean;
  inviteExpiresAt: string | Date | null;
};

/** A row of `USER_COLUMNS` as a `User`'s own fields. */
function asUser({
  hasPassword,
  hasIdentity,
  secondFactor,
  inviteExpiresAt,
  ...user
}: UserRow): Pick<User, 'id' | 'name' | 'email' | 'deactivatedAt' | 'signIn'> {
  return {
    ...user,
    signIn: {
      password: hasPassword,
      provider: hasIdentity,
      inviteExpiresAt:
        inviteExpiresAt === null ? null : new Date(inviteExpiresAt),
      secondFactor,
    },
  };
}

/** One user with its role IDs, read with `db` (a transaction or the pool). */
export async function findUserIn(
  db: Pick<Drizzle, 'select'>,
  userId: string,
): Promise<User | undefined> {
  if (!UserId.safeParse(userId).success) return undefined;
  const [user] = await db
    .select(USER_COLUMNS)
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return undefined;
  return {
    ...asUser(user),
    ...((await rolesOf(db, [user.id])).get(user.id) ?? NO_ROLES),
  };
}

/** `%`, `_` and `\` taken literally in a `LIKE` pattern. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

function whereUsers({ role, active, q }: UserFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (active === true) conditions.push(isNull(users.deactivatedAt));
  if (active === false) conditions.push(isNotNull(users.deactivatedAt));
  if (role !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${roleAssignments} where ${roleAssignments.userId} = ${users.id} and ${roleAssignments.roleId} = ${role})`,
    );
  }
  if (q !== undefined && q !== '') {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      or(
        ilike(users.id, pattern),
        ilike(users.name, pattern),
        ilike(users.email, pattern),
      ),
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** What a user without roles holds. */
const NO_ROLES: Pick<User, 'roleIds' | 'groupRoleIds' | 'permissions'> = {
  roleIds: [],
  groupRoleIds: [],
  permissions: [],
};

/**
 * The IDs of the roles each user holds, sorted, and the permissions they
 * hold (`heldPermissions`; one the model does not know is no permission).
 */
async function rolesOf(
  db: Pick<Drizzle, 'select'>,
  userIds: readonly string[],
): Promise<
  Map<string, Pick<User, 'roleIds' | 'groupRoleIds' | 'permissions'>>
> {
  const result = new Map<
    string,
    Pick<User, 'roleIds' | 'groupRoleIds' | 'permissions'>
  >();
  if (userIds.length === 0) return result;
  const rows = await db
    .select({
      userId: roleAssignments.userId,
      roleId: roleAssignments.roleId,
      direct: roleAssignments.direct,
      permissions: roles.permissions,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(inArray(roleAssignments.userId, [...userIds]))
    .orderBy(sql`${roleAssignments.roleId} collate "C"`);
  const byUser = new Map<
    string,
    { id: string; direct: boolean; permissions: string[] }[]
  >();
  for (const { userId, roleId, direct, permissions } of rows) {
    byUser.set(userId, [
      ...(byUser.get(userId) ?? []),
      { id: roleId, direct, permissions },
    ]);
  }
  for (const [userId, held] of byUser) {
    result.set(userId, {
      roleIds: held.map((r) => r.id),
      groupRoleIds: held.filter((r) => !r.direct).map((r) => r.id),
      permissions: heldPermissions(
        held.map((r) => ({
          permissions: r.permissions.filter(
            (p): p is Permission => Permission.safeParse(p).success,
          ),
        })),
      ),
    });
  }
  return result;
}
