import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  isMaintenanceLineId,
  type MaintenanceLine,
  type MaintenanceLineFilter,
} from '../core/maintenance-line.js';
import { MaintenanceLineStore } from '../core/maintenance-line-store.js';
import { isReleaseId } from '../core/release.js';
import {
  maintenanceLineReleases,
  maintenanceLines,
} from './maintenance-lines.tables.js';
import { releases } from './releases.tables.js';

type Row = typeof maintenanceLines.$inferSelect;

/** `MaintenanceLineStore` over `maintenance_lines` and `maintenance_line_releases`. */
@Injectable()
export class DrizzleMaintenanceLineStore extends MaintenanceLineStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insert(tx: Transaction, line: MaintenanceLine): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .insert(maintenanceLines)
      .values({
        id: line.id,
        product: line.product,
        revision: line.revision,
        baseRelease: line.baseRelease,
        baseCommit: line.baseCommit,
        branch: line.branch,
        createdByKind: line.createdBy.kind,
        createdById: line.createdBy.id,
        createdAt: line.createdAt,
        closedAt: line.closedAt,
        closedByKind: line.closedBy?.kind ?? null,
        closedById: line.closedBy?.id ?? null,
      })
      // Any unique index: the release, the revision or the branch is held.
      .onConflictDoNothing()
      .returning({ id: maintenanceLines.id });
    return rows.length > 0;
  }

  async find(id: string): Promise<MaintenanceLine | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isMaintenanceLineId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(maintenanceLines)
      .where(eq(maintenanceLines.id, id));
    return row && toLine(row);
  }

  async findByBranch(branch: string): Promise<MaintenanceLine | undefined> {
    const [row] = await this.database.db
      .select()
      .from(maintenanceLines)
      // In any case, as the unique index holds it: a case-insensitive
      // file system reads another case as the same branch.
      .where(sql`lower(${maintenanceLines.branch}) = lower(${branch})`);
    return row && toLine(row);
  }

  async findByRelease(releaseId: string): Promise<MaintenanceLine | undefined> {
    if (!isMaintenanceLineId(releaseId)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(maintenanceLines)
      .where(eq(maintenanceLines.baseRelease, releaseId));
    return row && toLine(row);
  }

  async lock(
    tx: Transaction,
    id: string,
    mode: 'update' | 'share',
  ): Promise<MaintenanceLine | undefined> {
    if (!isMaintenanceLineId(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .select()
      .from(maintenanceLines)
      .where(eq(maintenanceLines.id, id))
      .for(mode);
    return row && toLine(row);
  }

  async close(
    tx: Transaction,
    id: string,
    closing: { readonly by: ChangeSetAuthor; readonly at: Date },
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(maintenanceLines)
      .set({
        closedAt: closing.at,
        closedByKind: closing.by.kind,
        closedById: closing.by.id,
      })
      .where(
        and(eq(maintenanceLines.id, id), isNull(maintenanceLines.closedAt)),
      )
      .returning({ id: maintenanceLines.id });
    return rows.length > 0;
  }

  async list(
    filter: MaintenanceLineFilter,
    page: PageRequest,
  ): Promise<Paginated<MaintenanceLine>> {
    const where = and(...conditions(filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(maintenanceLines)
          .where(where)
          .orderBy(desc(maintenanceLines.createdAt), desc(maintenanceLines.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(maintenanceLines).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toLine) };
  }

  async linkRelease(
    tx: Transaction,
    lineId: string,
    releaseId: string,
  ): Promise<void> {
    await drizzleOf(tx)
      .insert(maintenanceLineReleases)
      .values({ lineId, releaseId });
  }

  async lineOfRelease(releaseId: string): Promise<MaintenanceLine | undefined> {
    if (!isReleaseId(releaseId)) return undefined;
    const [row] = await this.database.db
      .select({ lineId: maintenanceLineReleases.lineId })
      .from(maintenanceLineReleases)
      .where(eq(maintenanceLineReleases.releaseId, releaseId));
    return row && this.find(row.lineId);
  }

  async releasesOf(
    lineId: string,
    page: PageRequest,
  ): Promise<Paginated<string>> {
    if (!isMaintenanceLineId(lineId)) return { total: 0, items: [] };
    const where = and(
      eq(maintenanceLineReleases.lineId, lineId),
      isNotNull(releases.tagObject),
    );
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select({ id: releases.id })
          .from(maintenanceLineReleases)
          .innerJoin(
            releases,
            eq(releases.id, maintenanceLineReleases.releaseId),
          )
          .where(where)
          .orderBy(desc(releases.publishedAt), desc(releases.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx
          .select({ total: count() })
          .from(maintenanceLineReleases)
          .innerJoin(
            releases,
            eq(releases.id, maintenanceLineReleases.releaseId),
          )
          .where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map((r) => r.id) };
  }
}

function conditions(filter: MaintenanceLineFilter): SQL[] {
  return [
    ...(filter.product !== undefined
      ? [eq(maintenanceLines.product, filter.product)]
      : []),
    ...(filter.state === 'open' ? [isNull(maintenanceLines.closedAt)] : []),
    ...(filter.state === 'closed'
      ? [isNotNull(maintenanceLines.closedAt)]
      : []),
  ];
}

function toLine(row: Row): MaintenanceLine {
  const kind = (k: string) => k as ChangeSetAuthor['kind'];
  return {
    id: row.id,
    product: row.product,
    revision: row.revision,
    baseRelease: row.baseRelease,
    baseCommit: row.baseCommit,
    branch: row.branch,
    createdBy: { kind: kind(row.createdByKind), id: row.createdById },
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    closedBy:
      row.closedByKind !== null && row.closedById !== null
        ? { kind: kind(row.closedByKind), id: row.closedById }
        : null,
  };
}
