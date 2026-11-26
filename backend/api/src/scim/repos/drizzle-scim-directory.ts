import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { users } from '../../access/repos/access.tables.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { ScimDirectory, type ScimUserLink } from '../core/scim-directory.js';
import type { ScimGroup, ScimUser } from '../core/scim-resources.js';
import { scimGroupMembers, scimGroups, scimUsers } from './scim.tables.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = ReturnType<typeof drizzleOf> | Database['db'];

/** `ScimDirectory` in Postgres (`scim_users`, `scim_groups`, `scim_group_members`). */
@Injectable()
export class DrizzleScimDirectory extends ScimDirectory {
  constructor(private readonly database: Database) {
    super();
  }

  private db(tx?: Transaction): Db {
    return tx ? drizzleOf(tx) : this.database.db;
  }

  listUsers(): Promise<ScimUser[]> {
    return this.readUsers(this.database.db);
  }

  async findUser(
    userId: string,
    tx?: Transaction,
  ): Promise<ScimUser | undefined> {
    const [user] = await this.readUsers(this.db(tx), userId);
    return user;
  }

  /** The provisioned users (one, with `userId`), with their groups, by ID. */
  private async readUsers(db: Db, userId?: string): Promise<ScimUser[]> {
    const rows = await db
      .select({
        userId: scimUsers.userId,
        userName: scimUsers.userName,
        externalId: scimUsers.externalId,
        attributes: scimUsers.attributes,
        createdByScim: scimUsers.createdByScim,
        scimDeactivatedAt: scimUsers.scimDeactivatedAt,
        createdAt: scimUsers.createdAt,
        updatedAt: scimUsers.updatedAt,
        deactivatedAt: users.deactivatedAt,
      })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .where(
        and(
          isNull(scimUsers.unlinkedAt),
          userId === undefined ? undefined : eq(scimUsers.userId, userId),
        ),
      )
      .orderBy(sql`${scimUsers.userId} collate "C"`);
    if (rows.length === 0) return [];
    const memberships = await db
      .select({
        userId: scimGroupMembers.userId,
        id: scimGroups.id,
        displayName: scimGroups.displayName,
      })
      .from(scimGroupMembers)
      .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
      .where(
        userId === undefined ? undefined : eq(scimGroupMembers.userId, userId),
      )
      .orderBy(sql`${scimGroups.displayName} collate "C"`);
    const groups = new Map<string, { id: string; displayName: string }[]>();
    for (const m of memberships) {
      const list = groups.get(m.userId) ?? [];
      list.push({ id: m.id, displayName: m.displayName });
      groups.set(m.userId, list);
    }
    return rows.map((row) => ({
      ...row,
      groups: groups.get(row.userId) ?? [],
    }));
  }

  async userNamed(
    tx: Transaction,
    userName: string,
  ): Promise<string | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(
        and(
          isNull(scimUsers.unlinkedAt),
          sql`lower(${scimUsers.userName}) = lower(${userName})`,
        ),
      );
    return row?.userId;
  }

  async link(
    tx: Transaction,
    link: ScimUserLink & { readonly createdByScim: boolean },
  ): Promise<void> {
    // A link let go is taken up again, as new but for who made the user and who deactivated it.
    await drizzleOf(tx)
      .insert(scimUsers)
      .values(link)
      .onConflictDoUpdate({
        target: scimUsers.userId,
        set: {
          userName: link.userName,
          externalId: link.externalId,
          attributes: link.attributes,
          unlinkedAt: null,
          updatedAt: sql`now()`,
        },
        setWhere: isNotNull(scimUsers.unlinkedAt),
      });
  }

  async formerLink(tx: Transaction, userId: string) {
    const [row] = await drizzleOf(tx)
      .select({
        createdByScim: scimUsers.createdByScim,
        scimDeactivatedAt: scimUsers.scimDeactivatedAt,
      })
      .from(scimUsers)
      .where(
        and(eq(scimUsers.userId, userId), isNotNull(scimUsers.unlinkedAt)),
      );
    return row;
  }

  async markDeactivated(
    tx: Transaction,
    userId: string,
    at: Date | null,
  ): Promise<void> {
    await drizzleOf(tx)
      .update(scimUsers)
      .set({ scimDeactivatedAt: at })
      .where(eq(scimUsers.userId, userId));
  }

  async update(tx: Transaction, link: ScimUserLink): Promise<void> {
    await drizzleOf(tx)
      .update(scimUsers)
      .set({
        userName: link.userName,
        externalId: link.externalId,
        attributes: link.attributes,
        updatedAt: sql`now()`,
      })
      .where(eq(scimUsers.userId, link.userId));
  }

  async unlink(tx: Transaction, userId: string): Promise<void> {
    const db = drizzleOf(tx);
    await db
      .delete(scimGroupMembers)
      .where(eq(scimGroupMembers.userId, userId));
    await db
      .update(scimUsers)
      .set({ unlinkedAt: sql`now()` })
      .where(eq(scimUsers.userId, userId));
  }

  async provisioned(
    tx: Transaction,
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await drizzleOf(tx)
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(
        and(
          isNull(scimUsers.unlinkedAt),
          inArray(scimUsers.userId, [...userIds]),
        ),
      );
    return rows.map((r) => r.userId);
  }

  listGroups(): Promise<ScimGroup[]> {
    return this.readGroups(this.database.db);
  }

  async findGroup(
    id: string,
    tx?: Transaction,
  ): Promise<ScimGroup | undefined> {
    // Not a UUID: no such group, without a query (Postgres would refuse it).
    if (!UUID.test(id)) return undefined;
    const [group] = await this.readGroups(this.db(tx), id);
    return group;
  }

  /** The groups (one, with `id`), with their members, by name. */
  private async readGroups(db: Db, id?: string): Promise<ScimGroup[]> {
    const rows = await db
      .select()
      .from(scimGroups)
      .where(id === undefined ? undefined : eq(scimGroups.id, id))
      .orderBy(sql`${scimGroups.displayName} collate "C"`);
    if (rows.length === 0) return [];
    const members = await db
      .select({
        groupId: scimGroupMembers.groupId,
        userId: scimGroupMembers.userId,
        name: users.name,
      })
      .from(scimGroupMembers)
      .innerJoin(users, eq(users.id, scimGroupMembers.userId))
      .where(id === undefined ? undefined : eq(scimGroupMembers.groupId, id))
      .orderBy(asc(scimGroupMembers.userId));
    const byGroup = new Map<string, { userId: string; name: string }[]>();
    for (const m of members) {
      const list = byGroup.get(m.groupId) ?? [];
      list.push({ userId: m.userId, name: m.name });
      byGroup.set(m.groupId, list);
    }
    return rows.map((row) => ({ ...row, members: byGroup.get(row.id) ?? [] }));
  }

  async groupNamed(
    tx: Transaction,
    displayName: string,
  ): Promise<string | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ id: scimGroups.id })
      .from(scimGroups)
      .where(eq(scimGroups.displayName, displayName));
    return row?.id;
  }

  async insertGroup(
    tx: Transaction,
    group: { readonly displayName: string; readonly externalId: string | null },
  ): Promise<string> {
    const [row] = await drizzleOf(tx)
      .insert(scimGroups)
      .values({ displayName: group.displayName, externalId: group.externalId })
      .returning({ id: scimGroups.id });
    if (!row) throw new Error('The group was not inserted.');
    return row.id;
  }

  async updateGroup(
    tx: Transaction,
    id: string,
    group: { readonly displayName: string; readonly externalId: string | null },
  ): Promise<void> {
    await drizzleOf(tx)
      .update(scimGroups)
      .set({
        displayName: group.displayName,
        externalId: group.externalId,
        updatedAt: sql`now()`,
      })
      .where(eq(scimGroups.id, id));
  }

  async setMembers(
    tx: Transaction,
    id: string,
    userIds: readonly string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const db = drizzleOf(tx);
    const current = new Set(
      (
        await db
          .select({ userId: scimGroupMembers.userId })
          .from(scimGroupMembers)
          .where(eq(scimGroupMembers.groupId, id))
      ).map((r) => r.userId),
    );
    const wanted = new Set(userIds);
    const added = [...wanted].filter((u) => !current.has(u)).sort();
    const removed = [...current].filter((u) => !wanted.has(u)).sort();
    // In slices, so a large group stays within Postgres's bound on parameters.
    for (let at = 0; at < added.length; at += 1000) {
      await db
        .insert(scimGroupMembers)
        .values(
          added.slice(at, at + 1000).map((userId) => ({ groupId: id, userId })),
        );
    }
    for (let at = 0; at < removed.length; at += 1000) {
      await db
        .delete(scimGroupMembers)
        .where(
          and(
            eq(scimGroupMembers.groupId, id),
            inArray(scimGroupMembers.userId, removed.slice(at, at + 1000)),
          ),
        );
    }
    if (added.length > 0 || removed.length > 0) {
      await db
        .update(scimGroups)
        .set({ updatedAt: sql`now()` })
        .where(eq(scimGroups.id, id));
    }
    return { added, removed };
  }

  async deleteGroup(tx: Transaction, id: string): Promise<string[]> {
    const db = drizzleOf(tx);
    const members = await db
      .delete(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, id))
      .returning({ userId: scimGroupMembers.userId });
    await db.delete(scimGroups).where(eq(scimGroups.id, id));
    return members.map((m) => m.userId).sort();
  }
}
