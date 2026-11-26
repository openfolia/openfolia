import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database, type Drizzle } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  AccessAdmin,
  type NewUser,
  type RoleDefinition,
  type StoredRole,
} from '../core/access-admin.js';
import type { User } from '../core/user-directory.js';
import { installationSettings } from '../../settings/repos/installation-settings.tables.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleRefusedSignIns } from './drizzle-refused-sign-ins.js';
import { serviceAccountRoles } from './service-accounts.tables.js';
import {
  findUserIn,
  InvalidStoredDataError,
  toRole,
} from './drizzle-user-directory.js';

/** Key of the advisory lock every access change holds (`hashtext` of it). */
const ACCESS_LOCK = 'access-admin';

/** Users and service accounts holding the role. */
const holders = sql<number>`((select count(*) from ${roleAssignments} where ${roleAssignments.roleId} = ${roles.id}) + (select count(*) from ${serviceAccountRoles} where ${serviceAccountRoles.roleId} = ${roles.id}))::int`;

function toStoredRole(
  row: typeof roles.$inferSelect,
  holderCount: number,
): StoredRole {
  if (row.description !== null && row.description.trim() === '') {
    throw new InvalidStoredDataError(
      `Role "${row.id}" in the database has a blank description.`,
    );
  }
  return { ...toRole(row), description: row.description, holders: holderCount };
}

function roleColumns(role: RoleDefinition) {
  return {
    name: role.name,
    description: role.description,
    permissions: [...role.permissions],
    languages: role.scope.languages ? [...role.scope.languages] : null,
    moduleTypes: role.scope.moduleTypes ? [...role.scope.moduleTypes] : null,
    maxAudience: role.scope.maxAudience ?? null,
    facets: role.scope.facets ?? null,
  };
}

/** `AccessAdmin` over the `users`, `roles` and `role_assignments` tables. */
@Injectable()
export class DrizzleAccessAdmin extends AccessAdmin {
  constructor(private readonly database: Database) {
    super();
  }

  async lock(tx: Transaction): Promise<void> {
    await drizzleOf(tx).execute(
      sql`select pg_advisory_xact_lock(hashtext(${ACCESS_LOCK}))`,
    );
  }

  async listRoles(page: PageRequest): Promise<Paginated<StoredRole>> {
    // One snapshot, so the total matches the page.
    return this.database.db.transaction(
      async (tx) => {
        const [counted] = await tx.select({ total: count() }).from(roles);
        const rows = await tx
          .select({ role: roles, holders })
          .from(roles)
          .orderBy(asc(roles.name), sql`${roles.id} collate "C"`)
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        return {
          items: rows.map((r) => toStoredRole(r.role, r.holders)),
          total: counted?.total ?? 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findRole(
    roleId: string,
    tx?: Transaction,
  ): Promise<StoredRole | undefined> {
    const [row] = await this.db(tx)
      .select({ role: roles, holders })
      .from(roles)
      .where(eq(roles.id, roleId));
    return row && toStoredRole(row.role, row.holders);
  }

  async missingRoles(
    tx: Transaction,
    roleIds: readonly string[],
  ): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const found = await drizzleOf(tx)
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, [...roleIds]));
    const known = new Set(found.map((r) => r.id));
    return roleIds.filter((id) => !known.has(id));
  }

  async insertRole(tx: Transaction, role: RoleDefinition): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(roles)
      .values({ id: role.id, ...roleColumns(role) })
      .onConflictDoNothing({ target: roles.id })
      .returning({ id: roles.id });
    return inserted.length > 0;
  }

  async updateRole(tx: Transaction, role: RoleDefinition): Promise<void> {
    await drizzleOf(tx)
      .update(roles)
      .set(roleColumns(role))
      .where(eq(roles.id, role.id));
  }

  async deleteRole(tx: Transaction, roleId: string): Promise<void> {
    await drizzleOf(tx).delete(roles).where(eq(roles.id, roleId));
  }

  findUser(tx: Transaction, userId: string): Promise<User | undefined> {
    return findUserIn(drizzleOf(tx), userId);
  }

  async emailTaken(
    tx: Transaction,
    email: string,
    exceptUserId?: string,
  ): Promise<boolean> {
    const [found] = await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${email})`,
          exceptUserId === undefined ? undefined : ne(users.id, exceptUserId),
        ),
      )
      .limit(1);
    return found !== undefined;
  }

  async insertUser(tx: Transaction, user: NewUser): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(users)
      .values({ id: user.id, name: user.name, email: user.email })
      .onConflictDoNothing({ target: users.id })
      .returning({ id: users.id });
    return inserted.length > 0;
  }

  async updateUser(
    tx: Transaction,
    userId: string,
    changes: { readonly name: string; readonly email: string | null },
  ): Promise<void> {
    await drizzleOf(tx)
      .update(users)
      .set({ name: changes.name, email: changes.email })
      .where(eq(users.id, userId));
  }

  async assign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    // A role held only through a group becomes a direct one too (#37).
    const written = await drizzleOf(tx)
      .insert(roleAssignments)
      .values({ userId, roleId, direct: true })
      .onConflictDoUpdate({
        target: [roleAssignments.userId, roleAssignments.roleId],
        set: { direct: true },
        setWhere: eq(roleAssignments.direct, false),
      })
      .returning({ roleId: roleAssignments.roleId });
    return written.length > 0;
  }

  async unassign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    const db = drizzleOf(tx);
    const held = and(
      eq(roleAssignments.userId, userId),
      eq(roleAssignments.roleId, roleId),
      eq(roleAssignments.direct, true),
    );
    // Held through a group too (#37): it stays, as a group's.
    const kept = await db
      .update(roleAssignments)
      .set({ direct: false })
      .where(and(held, eq(roleAssignments.viaGroups, true)))
      .returning({ roleId: roleAssignments.roleId });
    if (kept.length > 0) return true;
    const removed = await db
      .delete(roleAssignments)
      .where(held)
      .returning({ roleId: roleAssignments.roleId });
    return removed.length > 0;
  }

  async setDeactivated(
    tx: Transaction,
    userId: string,
    deactivated: boolean,
  ): Promise<Date | null> {
    const [row] = await drizzleOf(tx)
      .update(users)
      .set({ deactivatedAt: deactivated ? sql`now()` : null })
      .where(eq(users.id, userId))
      .returning({ deactivatedAt: users.deactivatedAt });
    return row?.deactivatedAt ?? null;
  }

  async heldPermissions(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlySet<string>> {
    const rows = await drizzleOf(tx)
      .select({ permissions: roles.permissions })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    return new Set(rows.flatMap((r) => r.permissions));
  }

  async endLostBreakGlass(tx: Transaction): Promise<void> {
    const db = drizzleOf(tx);
    const [named] = await db
      .select({ userId: installationSettings.breakGlassUserId })
      .from(installationSettings)
      .where(ne(installationSettings.singleSignOn, 'optional'));
    if (!named || named.userId === null) return;
    const refused = new DrizzleRefusedSignIns();
    // Held before the roles are read: a sign-in under way holds them too, so it is either seen
    // and ended, or reads the roles after this.
    await refused.hold(tx, named.userId);
    const [direct] = await db
      .select({ id: roles.id })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(
        and(
          eq(roleAssignments.userId, named.userId),
          eq(roleAssignments.direct, true),
          arrayContains(roles.permissions, ['admin.roles']),
        ),
      )
      .limit(1);
    if (!direct) await refused.endPasswordsOf(tx, named.userId);
  }

  async countActiveAdmins(tx: Transaction): Promise<number> {
    const [row] = await drizzleOf(tx)
      .select({ admins: sql<number>`count(distinct ${users.id})::int` })
      .from(users)
      .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(
        and(
          isNull(users.deactivatedAt),
          arrayContains(roles.permissions, ['admin.roles']),
        ),
      );
    return row?.admins ?? 0;
  }

  async serviceAccountHolders(
    tx: Transaction,
    roleId: string,
  ): Promise<number> {
    const [row] = await drizzleOf(tx)
      .select({ holders: count() })
      .from(serviceAccountRoles)
      .where(eq(serviceAccountRoles.roleId, roleId));
    return row?.holders ?? 0;
  }

  private db(tx?: Transaction): Pick<Drizzle, 'select'> {
    return tx ? drizzleOf(tx) : this.database.db;
  }
}
