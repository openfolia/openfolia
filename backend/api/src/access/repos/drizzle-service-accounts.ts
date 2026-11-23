import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database, type Drizzle } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type NewServiceAccount,
  type NewServiceToken,
  type ServiceAccount,
  ServiceAccountId,
  type ServiceAccountFilter,
  ServiceAccountStore,
  type ServiceToken,
  type TokenCredential,
} from '../core/service-accounts.js';
import { SERVICE_TOKEN_ID_PATTERN } from '../core/service-token.js';
import { roles } from './access.tables.js';
import { toRole } from './drizzle-user-directory.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from './service-accounts.tables.js';

const ACCOUNT_COLUMNS = {
  id: serviceAccounts.id,
  name: serviceAccounts.name,
  description: serviceAccounts.description,
  deactivatedAt: serviceAccounts.deactivatedAt,
  createdAt: serviceAccounts.createdAt,
};

/** Every column but the hash: what lists and admin reads see. */
const TOKEN_COLUMNS = {
  id: serviceTokens.id,
  serviceAccountId: serviceTokens.serviceAccountId,
  name: serviceTokens.name,
  createdAt: serviceTokens.createdAt,
  expiresAt: serviceTokens.expiresAt,
  lastUsedAt: serviceTokens.lastUsedAt,
  revokedAt: serviceTokens.revokedAt,
};

/** `%`, `_` and `\` taken literally in a `LIKE` pattern. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** `ServiceAccountStore` over `service_accounts`, `service_account_roles` and `service_tokens`. */
@Injectable()
export class DrizzleServiceAccountStore extends ServiceAccountStore {
  constructor(private readonly database: Database) {
    super();
  }

  async list(
    page: PageRequest,
    filter: ServiceAccountFilter = {},
  ): Promise<Paginated<ServiceAccount>> {
    const where = whereAccounts(filter);
    // One snapshot, so the total matches the page.
    return this.database.db.transaction(
      async (tx) => {
        const [counted] = await tx
          .select({ total: count() })
          .from(serviceAccounts)
          .where(where);
        const rows = await tx
          .select(ACCOUNT_COLUMNS)
          .from(serviceAccounts)
          .where(where)
          .orderBy(sql`${serviceAccounts.id} collate "C"`)
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        const roleIds = await roleIdsOf(
          tx,
          rows.map((a) => a.id),
        );
        return {
          items: rows.map((a) => ({ ...a, roleIds: roleIds.get(a.id) ?? [] })),
          total: counted?.total ?? 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async find(
    id: string,
    tx?: Transaction,
  ): Promise<ServiceAccount | undefined> {
    if (!ServiceAccountId.safeParse(id).success) return undefined;
    const db = this.db(tx);
    const [account] = await db
      .select(ACCOUNT_COLUMNS)
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, id));
    if (!account) return undefined;
    return { ...account, roleIds: (await roleIdsOf(db, [id])).get(id) ?? [] };
  }

  async insert(tx: Transaction, account: NewServiceAccount): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(serviceAccounts)
      .values({
        id: account.id,
        name: account.name,
        description: account.description,
      })
      .onConflictDoNothing({ target: serviceAccounts.id })
      .returning({ id: serviceAccounts.id });
    return inserted.length > 0;
  }

  async update(
    tx: Transaction,
    id: string,
    changes: { readonly name: string; readonly description: string | null },
  ): Promise<void> {
    await drizzleOf(tx)
      .update(serviceAccounts)
      .set({ name: changes.name, description: changes.description })
      .where(eq(serviceAccounts.id, id));
  }

  async assign(tx: Transaction, id: string, roleId: string): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(serviceAccountRoles)
      .values({ serviceAccountId: id, roleId })
      .onConflictDoNothing()
      .returning({ roleId: serviceAccountRoles.roleId });
    return inserted.length > 0;
  }

  async unassign(
    tx: Transaction,
    id: string,
    roleId: string,
  ): Promise<boolean> {
    const removed = await drizzleOf(tx)
      .delete(serviceAccountRoles)
      .where(
        and(
          eq(serviceAccountRoles.serviceAccountId, id),
          eq(serviceAccountRoles.roleId, roleId),
        ),
      )
      .returning({ roleId: serviceAccountRoles.roleId });
    return removed.length > 0;
  }

  async setDeactivated(
    tx: Transaction,
    id: string,
    deactivated: boolean,
  ): Promise<Date | null> {
    const [row] = await drizzleOf(tx)
      .update(serviceAccounts)
      .set({ deactivatedAt: deactivated ? sql`now()` : null })
      .where(eq(serviceAccounts.id, id))
      .returning({ deactivatedAt: serviceAccounts.deactivatedAt });
    return row?.deactivatedAt ?? null;
  }

  async listTokens(
    id: string,
    page: PageRequest,
  ): Promise<Paginated<ServiceToken>> {
    const where = eq(serviceTokens.serviceAccountId, id);
    return this.database.db.transaction(
      async (tx) => {
        const [counted] = await tx
          .select({ total: count() })
          .from(serviceTokens)
          .where(where);
        const items = await tx
          .select(TOKEN_COLUMNS)
          .from(serviceTokens)
          .where(where)
          .orderBy(desc(serviceTokens.createdAt), asc(serviceTokens.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        return { items, total: counted?.total ?? 0 };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findToken(
    tx: Transaction,
    id: string,
    tokenId: string,
  ): Promise<ServiceToken | undefined> {
    if (!SERVICE_TOKEN_ID_PATTERN.test(tokenId)) return undefined;
    const [row] = await drizzleOf(tx)
      .select(TOKEN_COLUMNS)
      .from(serviceTokens)
      .where(
        and(
          eq(serviceTokens.id, tokenId),
          eq(serviceTokens.serviceAccountId, id),
        ),
      );
    return row;
  }

  async countActiveTokens(tx: Transaction, id: string): Promise<number> {
    const [row] = await drizzleOf(tx)
      .select({ active: count() })
      .from(serviceTokens)
      .where(
        and(
          eq(serviceTokens.serviceAccountId, id),
          isNull(serviceTokens.revokedAt),
          gt(serviceTokens.expiresAt, sql`now()`),
        ),
      );
    return row?.active ?? 0;
  }

  async insertToken(
    tx: Transaction,
    token: NewServiceToken,
  ): Promise<ServiceToken | undefined> {
    const [row] = await drizzleOf(tx)
      .insert(serviceTokens)
      .values({
        id: token.id,
        serviceAccountId: token.serviceAccountId,
        name: token.name,
        secretHash: token.secretHash,
        expiresAt: token.expiresAt,
      })
      .onConflictDoNothing({ target: serviceTokens.id })
      .returning(TOKEN_COLUMNS);
    return row;
  }

  async revokeToken(tx: Transaction, tokenId: string): Promise<Date> {
    const [row] = await drizzleOf(tx)
      .update(serviceTokens)
      .set({ revokedAt: sql`now()` })
      .where(eq(serviceTokens.id, tokenId))
      .returning({ revokedAt: serviceTokens.revokedAt });
    if (!row?.revokedAt) throw new Error(`No token "${tokenId}" to revoke.`);
    return row.revokedAt;
  }

  async credential(tokenId: string): Promise<TokenCredential | undefined> {
    if (!SERVICE_TOKEN_ID_PATTERN.test(tokenId)) return undefined;
    // One statement, so the token, its account and the roles are read together.
    const rows = await this.database.db
      .select({
        token: { ...TOKEN_COLUMNS, secretHash: serviceTokens.secretHash },
        accountDeactivatedAt: serviceAccounts.deactivatedAt,
        role: roles,
      })
      .from(serviceTokens)
      .innerJoin(
        serviceAccounts,
        eq(serviceAccounts.id, serviceTokens.serviceAccountId),
      )
      .leftJoin(
        serviceAccountRoles,
        eq(serviceAccountRoles.serviceAccountId, serviceAccounts.id),
      )
      .leftJoin(roles, eq(roles.id, serviceAccountRoles.roleId))
      .where(eq(serviceTokens.id, tokenId))
      .orderBy(asc(roles.id));
    const [first] = rows;
    if (!first) return undefined;
    return {
      token: first.token,
      account: {
        id: first.token.serviceAccountId,
        deactivatedAt: first.accountDeactivatedAt,
      },
      roles: rows.flatMap(({ role }) => (role ? [toRole(role)] : [])),
    };
  }

  async touch(tokenId: string, at: Date): Promise<void> {
    await this.database.db
      .update(serviceTokens)
      .set({ lastUsedAt: at })
      .where(
        and(
          eq(serviceTokens.id, tokenId),
          or(
            isNull(serviceTokens.lastUsedAt),
            lt(serviceTokens.lastUsedAt, new Date(at.getTime() - 60_000)),
          ),
        ),
      );
  }

  private db(tx?: Transaction): Pick<Drizzle, 'select'> {
    return tx ? drizzleOf(tx) : this.database.db;
  }
}

function whereAccounts({
  role,
  active,
  q,
}: ServiceAccountFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (active === true) conditions.push(isNull(serviceAccounts.deactivatedAt));
  if (active === false) {
    conditions.push(isNotNull(serviceAccounts.deactivatedAt));
  }
  if (role !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${serviceAccountRoles} where ${serviceAccountRoles.serviceAccountId} = ${serviceAccounts.id} and ${serviceAccountRoles.roleId} = ${role})`,
    );
  }
  if (q !== undefined && q !== '') {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      or(
        ilike(serviceAccounts.id, pattern),
        ilike(serviceAccounts.name, pattern),
      ),
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** The IDs of the roles each service account holds, sorted. */
async function roleIdsOf(
  db: Pick<Drizzle, 'select'>,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      id: serviceAccountRoles.serviceAccountId,
      roleId: serviceAccountRoles.roleId,
    })
    .from(serviceAccountRoles)
    .where(inArray(serviceAccountRoles.serviceAccountId, [...ids]))
    .orderBy(sql`${serviceAccountRoles.roleId} collate "C"`);
  for (const { id, roleId } of rows) {
    result.set(id, [...(result.get(id) ?? []), roleId]);
  }
  return result;
}
