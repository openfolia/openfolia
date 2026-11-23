import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  isReleaseId,
  type NewRelease,
  type Release,
  type ReleaseFilter,
  type ReleaseWithdrawal,
} from '../core/release.js';
import { ReleaseStore, type StoredRelease } from '../core/release-store.js';
import { maintenanceLineReleases } from './maintenance-lines.tables.js';
import { releases, releaseWithdrawals } from './releases.tables.js';

type Row = typeof releases.$inferSelect;
type Withdrawal = typeof releaseWithdrawals.$inferSelect;
type Joined = { releases: Row; release_withdrawals: Withdrawal | null };

/** `ReleaseStore` over the `releases` table. */
@Injectable()
export class DrizzleReleaseStore extends ReleaseStore {
  constructor(private readonly database: Database) {
    super();
  }

  async reserve(tx: Transaction, release: NewRelease): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .insert(releases)
      .values({
        id: release.id,
        product: release.product,
        productFacet: release.productFacet,
        revision: release.revision,
        tag: release.tag,
        tagObject: null,
        commit: release.commit,
        notes: release.notes,
        notesByLanguage: { ...release.notesByLanguage },
        major: release.major,
        publishedByKind: release.publishedBy.kind,
        publishedById: release.publishedBy.id,
        publishedAt: release.publishedAt,
      })
      // Either unique index: the name is held already.
      .onConflictDoNothing()
      .returning({ id: releases.id });
    return rows.length > 0;
  }

  async publish(
    tx: Transaction,
    id: string,
    tagObject: string,
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(releases)
      .set({ tagObject })
      .where(and(eq(releases.id, id), isNull(releases.tagObject)))
      .returning({ id: releases.id });
    return rows.length > 0;
  }

  async discard(tx: Transaction, id: string): Promise<void> {
    await drizzleOf(tx)
      .delete(releases)
      .where(and(eq(releases.id, id), isNull(releases.tagObject)));
  }

  async findByName(
    product: string,
    revision: string,
    tag: string,
  ): Promise<StoredRelease | undefined> {
    const [row] = await this.database.db
      .select()
      .from(releases)
      .where(
        or(
          and(eq(releases.product, product), eq(releases.revision, revision)),
          eq(sql`lower(${releases.tag})`, tag.toLowerCase()),
        ),
      )
      .orderBy(releases.id)
      .limit(1);
    return row && toStored(row);
  }

  async find(id: string): Promise<Release | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isReleaseId(id)) return undefined;
    const [row] = await this.joined(
      this.database.db,
      and(eq(releases.id, id), isNotNull(releases.tagObject)),
    );
    return row && toRelease(row);
  }

  async findByRevision(
    product: string,
    revision: string,
  ): Promise<Release | undefined> {
    const [row] = await this.joined(
      this.database.db,
      and(
        eq(releases.product, product),
        eq(releases.revision, revision),
        isNotNull(releases.tagObject),
      ),
    ).limit(1);
    return row && toRelease(row);
  }

  async latest(product: string): Promise<Release | undefined> {
    const [row] = await this.joined(
      this.database.db,
      and(
        eq(releases.product, product),
        isNotNull(releases.tagObject),
        isNull(releaseWithdrawals.releaseId),
        notExists(
          this.database.db
            .select({ one: sql`1` })
            .from(maintenanceLineReleases)
            .where(eq(maintenanceLineReleases.releaseId, releases.id)),
        ),
      ),
    )
      .orderBy(desc(releases.publishedAt), desc(releases.id))
      .limit(1);
    return row && toRelease(row);
  }

  async latestOfEach(): Promise<Release[]> {
    // One row per product (`distinct on`): the newest that stands and is `main`'s.
    const rows = await this.database.db
      .selectDistinctOn([releases.product])
      .from(releases)
      .leftJoin(
        releaseWithdrawals,
        eq(releaseWithdrawals.releaseId, releases.id),
      )
      .where(
        and(
          isNotNull(releases.tagObject),
          isNull(releaseWithdrawals.releaseId),
          notExists(this.lineRelease()),
        ),
      )
      .orderBy(releases.product, desc(releases.publishedAt), desc(releases.id));
    return rows.map(toRelease);
  }

  async mainLine(
    product: string,
    max: number,
  ): Promise<{ releases: Release[]; truncated: boolean }> {
    const rows = await this.joined(
      this.database.db,
      and(
        eq(releases.product, product),
        isNotNull(releases.tagObject),
        notExists(this.lineRelease()),
      ),
    )
      .orderBy(desc(releases.publishedAt), desc(releases.id))
      .limit(max + 1);
    return {
      releases: rows.slice(0, max).map(toRelease),
      truncated: rows.length > max,
    };
  }

  /** The maintenance line row of the release a row names (#60): a subquery. */
  private lineRelease() {
    return this.database.db
      .select({ one: sql`1` })
      .from(maintenanceLineReleases)
      .where(eq(maintenanceLineReleases.releaseId, releases.id));
  }

  async previous(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    among?: { readonly line: string | null },
  ): Promise<Release | undefined> {
    const onLine = sql`exists (select 1 from ${maintenanceLineReleases} where ${maintenanceLineReleases.releaseId} = ${releases.id}${
      typeof among?.line === 'string'
        ? sql` and ${maintenanceLineReleases.lineId} = ${among.line}`
        : sql``
    })`;
    const [row] = await this.joined(
      this.database.db,
      and(
        among === undefined
          ? undefined
          : among.line === null
            ? sql`not ${onLine}`
            : onLine,
        isNotNull(releases.tagObject),
        isNull(releaseWithdrawals.releaseId),
        eq(releases.product, release.product),
        or(
          lt(releases.publishedAt, release.publishedAt),
          and(
            eq(releases.publishedAt, release.publishedAt),
            lt(releases.id, release.id),
          ),
        ),
      ),
    )
      .orderBy(desc(releases.publishedAt), desc(releases.id))
      .limit(1);
    return row && toRelease(row);
  }

  async after(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ): Promise<Release[]> {
    const rows = await this.joined(
      this.database.db,
      and(
        isNotNull(releases.tagObject),
        eq(releases.product, release.product),
        or(
          gt(releases.publishedAt, release.publishedAt),
          and(
            eq(releases.publishedAt, release.publishedAt),
            gt(releases.id, release.id),
          ),
        ),
      ),
    )
      .orderBy(asc(releases.publishedAt), asc(releases.id))
      .limit(limit);
    return rows.map(toRelease);
  }

  async before(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ): Promise<Release[]> {
    const rows = await this.joined(
      this.database.db,
      and(
        isNotNull(releases.tagObject),
        eq(releases.product, release.product),
        or(
          lt(releases.publishedAt, release.publishedAt),
          and(
            eq(releases.publishedAt, release.publishedAt),
            lt(releases.id, release.id),
          ),
        ),
      ),
    )
      .orderBy(desc(releases.publishedAt), desc(releases.id))
      .limit(limit);
    return rows.map(toRelease).reverse();
  }

  async withdraw(
    tx: Transaction,
    id: string,
    withdrawal: ReleaseWithdrawal,
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .insert(releaseWithdrawals)
      .values({
        releaseId: id,
        withdrawnByKind: withdrawal.by.kind,
        withdrawnById: withdrawal.by.id,
        withdrawnAt: withdrawal.at,
        reason: withdrawal.reason,
      })
      .onConflictDoNothing()
      .returning({ id: releaseWithdrawals.releaseId });
    return rows.length > 0;
  }

  /** The releases matching `where`, each with its withdrawal (if any). */
  private joined(db: Pick<Database['db'], 'select'>, where: SQL | undefined) {
    return db
      .select()
      .from(releases)
      .leftJoin(
        releaseWithdrawals,
        eq(releaseWithdrawals.releaseId, releases.id),
      )
      .where(where);
  }

  async list(
    filter: ReleaseFilter,
    page: PageRequest,
  ): Promise<Paginated<Release>> {
    const where = and(...conditions(filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await this.joined(tx, where)
          .orderBy(desc(releases.publishedAt), desc(releases.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(releases).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toRelease) };
  }
}

function conditions(filter: ReleaseFilter): SQL[] {
  return [
    isNotNull(releases.tagObject),
    ...(filter.product !== undefined
      ? [eq(releases.product, filter.product)]
      : []),
    ...(filter.major !== undefined ? [eq(releases.major, filter.major)] : []),
    ...(filter.withdrawn !== undefined
      ? [(filter.withdrawn ? exists : notExists)(withdrawalOf())]
      : []),
  ];
}

/** The withdrawal of the release a row names: a subquery, so the count needs no join. */
function withdrawalOf() {
  return sql`(select 1 from ${releaseWithdrawals} where ${releaseWithdrawals.releaseId} = ${releases.id})`;
}

function toStored(row: Row): StoredRelease {
  return {
    id: row.id,
    product: row.product,
    productFacet: row.productFacet,
    revision: row.revision,
    tag: row.tag,
    tagObject: row.tagObject,
    commit: row.commit,
    notes: row.notes,
    notesByLanguage: row.notesByLanguage,
    major: row.major,
    publishedBy: {
      kind: row.publishedByKind as 'user' | 'service',
      id: row.publishedById,
    },
    publishedAt: row.publishedAt,
  };
}

function toRelease({
  releases: row,
  release_withdrawals: withdrawn,
}: Joined): Release {
  const stored = toStored(row);
  if (stored.tagObject === null) {
    throw new Error(`The release ${row.id} is not published.`);
  }
  return {
    ...stored,
    tagObject: stored.tagObject,
    withdrawal: withdrawn && {
      by: {
        kind: withdrawn.withdrawnByKind as 'user' | 'service',
        id: withdrawn.withdrawnById,
      },
      at: withdrawn.withdrawnAt,
      reason: withdrawn.reason,
    },
  };
}
