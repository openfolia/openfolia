import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import {
  type DrizzleTx,
  drizzleOf,
} from '../../database/drizzle-unit-of-work.js';
import {
  type GroupMapping,
  type GroupMappingFilter,
  GroupMappings,
  type GroupRoleChange,
} from '../core/group-mappings.js';
import {
  MAX_SESSIONS_PER_USER,
  SessionStore,
  type StoredSession,
} from '../core/sessions.js';
import { UserIdentities } from '../core/user-identities.js';
import { GLOBAL_PERMISSIONS } from '../core/permissions.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { userPasswords } from './passwords.tables.js';
import { groupRoles, sessions, userIdentities } from './sign-in.tables.js';
import { emailCodeSignIns } from './email-codes.tables.js';
import { scimGroupMembers, scimGroups } from '../../scim/repos/scim.tables.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `SessionStore` over the `sessions` table. */
@Injectable()
export class DrizzleSessionStore extends SessionStore {
  constructor(private readonly database: Database) {
    super();
  }

  async find(hash: string): Promise<StoredSession | undefined> {
    const [row] = await this.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hash));
    return row && { ...row, hash: row.tokenHash };
  }

  async create(
    tx: Transaction,
    session: {
      readonly hash: string;
      readonly userId: string;
      readonly provider: string;
      readonly endedBefore: Date;
    },
  ): Promise<void> {
    const db = drizzleOf(tx);
    // Sessions that have ended go; they authenticate nothing any more.
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, session.userId),
          or(
            isNotNull(sessions.revokedAt),
            lt(sessions.createdAt, session.endedBefore),
          ),
        ),
      );
    // Past the most per user, the oldest end, so the new one is within it.
    const running = await db
      .select({ hash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, session.userId))
      .orderBy(desc(sessions.createdAt))
      .offset(MAX_SESSIONS_PER_USER - 1);
    if (running.length > 0) {
      await db.delete(sessions).where(
        inArray(
          sessions.tokenHash,
          running.map((r) => r.hash),
        ),
      );
    }
    await db.insert(sessions).values({
      tokenHash: session.hash,
      userId: session.userId,
      provider: session.provider,
    });
  }

  async touch(hash: string, at: Date): Promise<void> {
    await this.database.db
      .update(sessions)
      .set({ lastSeenAt: at })
      .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)));
  }

  async revoke(hash: string, tx?: Transaction): Promise<boolean> {
    const ended = await (tx ? drizzleOf(tx) : this.database.db)
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)))
      .returning({ hash: sessions.tokenHash });
    return ended.length > 0;
  }

  async revokeAllOf(
    tx: Transaction,
    userId: string,
    exceptHash?: string,
  ): Promise<number> {
    const ended = await drizzleOf(tx)
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptHash === undefined
            ? undefined
            : ne(sessions.tokenHash, exceptHash),
        ),
      )
      .returning({ hash: sessions.tokenHash });
    return ended.length;
  }
}

/** `UserIdentities` over the `user_identities` table. */
@Injectable()
export class DrizzleUserIdentities extends UserIdentities {
  async userOf(
    tx: Transaction,
    issuer: string,
    subject: string,
  ): Promise<string | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.issuer, issuer),
          eq(userIdentities.subject, subject),
        ),
      );
    return row?.userId;
  }

  async hasAnyIdentity(tx: Transaction, userId: string): Promise<boolean> {
    const [row] = await drizzleOf(tx)
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .limit(1);
    if (row !== undefined) return true;
    const [password] = await drizzleOf(tx)
      .select({ userId: userPasswords.userId })
      .from(userPasswords)
      .where(eq(userPasswords.userId, userId))
      .limit(1);
    if (password !== undefined) return true;
    const [byCode] = await drizzleOf(tx)
      .select({ userId: emailCodeSignIns.userId })
      .from(emailCodeSignIns)
      .where(eq(emailCodeSignIns.userId, userId))
      .limit(1);
    return byCode !== undefined;
  }

  async recordCodeSignIn(tx: Transaction, userId: string): Promise<void> {
    await drizzleOf(tx)
      .insert(emailCodeSignIns)
      .values({ userId })
      .onConflictDoNothing();
  }

  async hasIdentityAt(
    tx: Transaction,
    userId: string,
    issuer: string,
  ): Promise<boolean> {
    const [row] = await drizzleOf(tx)
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.userId, userId),
          eq(userIdentities.issuer, issuer),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async userWithEmail(
    tx: Transaction,
    email: string,
  ): Promise<string | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    return row?.id;
  }

  async link(
    tx: Transaction,
    identity: {
      readonly issuer: string;
      readonly subject: string;
      readonly userId: string;
      readonly groups: readonly string[];
    },
  ): Promise<void> {
    await drizzleOf(tx)
      .insert(userIdentities)
      .values({ ...identity, groups: [...identity.groups] });
  }

  async recordSignIn(
    tx: Transaction,
    issuer: string,
    subject: string,
    groups: readonly string[],
  ): Promise<void> {
    await drizzleOf(tx)
      .update(userIdentities)
      .set({ groups: [...groups], lastSignInAt: sql`now()` })
      .where(
        and(
          eq(userIdentities.issuer, issuer),
          eq(userIdentities.subject, subject),
        ),
      );
  }
}

function whereMappings({ group, role }: GroupMappingFilter): SQL | undefined {
  return and(
    group === undefined ? undefined : eq(groupRoles.group, group),
    role === undefined ? undefined : eq(groupRoles.roleId, role),
  );
}

/** `GroupMappings` over the `group_roles`, `user_identities` and `role_assignments` tables. */
@Injectable()
export class DrizzleGroupMappings extends GroupMappings {
  constructor(private readonly database: Database) {
    super();
  }

  async list(
    page: PageRequest,
    filter: GroupMappingFilter = {},
  ): Promise<Paginated<GroupMapping>> {
    const where = whereMappings(filter);
    // One snapshot, so the total matches the page.
    return this.database.db.transaction(
      async (tx) => {
        const [counted] = await tx
          .select({ total: count() })
          .from(groupRoles)
          .where(where);
        const items = await tx
          .select()
          .from(groupRoles)
          .where(where)
          .orderBy(
            sql`${groupRoles.group} collate "C"`,
            sql`${groupRoles.roleId} collate "C"`,
          )
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        return { items, total: counted?.total ?? 0 };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async find(id: string, tx?: Transaction): Promise<GroupMapping | undefined> {
    // Not a UUID: no such mapping, without a query (Postgres would refuse it).
    if (!UUID.test(id)) return undefined;
    const [row] = await (tx ? drizzleOf(tx) : this.database.db)
      .select()
      .from(groupRoles)
      .where(eq(groupRoles.id, id));
    return row;
  }

  async insert(
    tx: Transaction,
    group: string,
    roleId: string,
  ): Promise<GroupMapping | undefined> {
    const [row] = await drizzleOf(tx)
      .insert(groupRoles)
      .values({ group, roleId })
      .onConflictDoNothing({ target: [groupRoles.group, groupRoles.roleId] })
      .returning();
    return row;
  }

  async delete(tx: Transaction, id: string): Promise<GroupMapping | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .delete(groupRoles)
      .where(eq(groupRoles.id, id))
      .returning();
    return row;
  }

  async countForRole(tx: Transaction, roleId: string): Promise<number> {
    const [row] = await drizzleOf(tx)
      .select({ total: count() })
      .from(groupRoles)
      .where(eq(groupRoles.roleId, roleId));
    return row?.total ?? 0;
  }

  async groupsForRole(
    tx: Transaction,
    roleId: string,
  ): Promise<readonly string[]> {
    const rows = await drizzleOf(tx)
      .select({ group: groupRoles.group })
      .from(groupRoles)
      .where(eq(groupRoles.roleId, roleId));
    return rows.map((r) => r.group).sort();
  }

  async usersInGroup(
    tx: Transaction,
    group: string,
  ): Promise<readonly string[]> {
    const db = drizzleOf(tx);
    const signedIn = await db
      .selectDistinct({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(arrayContains(userIdentities.groups, [group]));
    // And the members of the SCIM group of that name (#377).
    const provisioned = await db
      .select({ userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
      .where(eq(scimGroups.displayName, group));
    return [
      ...new Set([...signedIn, ...provisioned].map((r) => r.userId)),
    ].sort();
  }

  applyGroupRoles(tx: Transaction, userId: string): Promise<GroupRoleChange> {
    return applyGroupRolesIn(drizzleOf(tx), userId);
  }
}

/**
 * `GroupMappings.applyGroupRoles` in `db`: the roles the user's identities'
 * groups and its SCIM groups (#377) map to are held `via_groups`, the others not; a row neither
 * direct nor through a group is removed. Answers what changed through groups.
 */
export async function applyGroupRolesIn(
  db: DrizzleTx,
  userId: string,
): Promise<GroupRoleChange> {
  const wanted = await db
    .selectDistinct({ roleId: groupRoles.roleId })
    .from(groupRoles)
    .where(
      or(
        sql`${groupRoles.group} in (select unnest(${userIdentities.groups}) from ${userIdentities} where ${userIdentities.userId} = ${userId})`,
        // A SCIM group of that name the user is in (#377), for a role holding no global
        // permission: a directory's token never makes an admin.
        and(
          sql`${groupRoles.group} in (select ${scimGroups.displayName} from ${scimGroups} join ${scimGroupMembers} on ${scimGroupMembers.groupId} = ${scimGroups.id} where ${scimGroupMembers.userId} = ${userId})`,
          sql`${groupRoles.roleId} not in (select ${roles.id} from ${roles} where ${roles.permissions} && array[${sql.join(
            [...GLOBAL_PERMISSIONS].map((p) => sql`${p}`),
            sql`, `,
          )}]::text[])`,
        ),
      ),
    );
  const want = new Set(wanted.map((r) => r.roleId));
  const held = await db
    .select({
      roleId: roleAssignments.roleId,
      viaGroups: roleAssignments.viaGroups,
    })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const through = new Set(held.filter((r) => r.viaGroups).map((r) => r.roleId));
  const assigned = [...want].filter((id) => !through.has(id)).sort();
  const unassigned = [...through].filter((id) => !want.has(id)).sort();
  if (assigned.length > 0) {
    await db
      .insert(roleAssignments)
      .values(
        assigned.map((roleId) => ({
          userId,
          roleId,
          direct: false,
          viaGroups: true,
        })),
      )
      .onConflictDoUpdate({
        target: [roleAssignments.userId, roleAssignments.roleId],
        set: { viaGroups: true },
      });
  }
  if (unassigned.length > 0) {
    const these = and(
      eq(roleAssignments.userId, userId),
      inArray(roleAssignments.roleId, unassigned),
    );
    await db
      .delete(roleAssignments)
      .where(and(these, eq(roleAssignments.direct, false)));
    await db.update(roleAssignments).set({ viaGroups: false }).where(these);
  }
  return { assigned, unassigned };
}
