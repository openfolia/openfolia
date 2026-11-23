import { Injectable } from '@nestjs/common';
import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type ImportFailure,
  type ImportProgress,
  type ImportRecord,
  type ImportReport,
  type ImportState,
  isImportId,
} from '../core/import.js';
import { type ImportChange, ImportStore } from '../core/import-store.js';
import { imports } from './imports.tables.js';

type Row = typeof imports.$inferSelect;

const toRecord = (row: Row): ImportRecord => ({
  id: row.id,
  importerId: row.importerId,
  options: row.options as Record<string, unknown>,
  updateExisting: row.updateExisting,
  baseRef: row.baseRef,
  baseCommit: row.baseCommit,
  createdBy: {
    kind: row.createdByKind as ImportRecord['createdBy']['kind'],
    id: row.createdById,
  },
  fileName: row.fileName,
  upload: {
    sha256: row.uploadSha256,
    size: row.uploadSize,
    created: row.uploadCreated,
  },
  state: row.state as ImportState,
  report: row.report as ImportReport,
  changeSetId: row.changeSetId,
  progress: row.progress as ImportProgress,
  failure: (row.failure as ImportFailure | null) ?? null,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** `ImportStore` over the `imports` table. */
@Injectable()
export class DrizzleImportStore extends ImportStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insert(tx: Transaction, record: ImportRecord): Promise<void> {
    await drizzleOf(tx).insert(imports).values({
      id: record.id,
      importerId: record.importerId,
      options: record.options,
      updateExisting: record.updateExisting,
      baseRef: record.baseRef,
      baseCommit: record.baseCommit,
      createdByKind: record.createdBy.kind,
      createdById: record.createdBy.id,
      fileName: record.fileName,
      uploadSha256: record.upload.sha256,
      uploadSize: record.upload.size,
      uploadCreated: record.upload.created,
      state: record.state,
      report: record.report,
      changeSetId: record.changeSetId,
      progress: record.progress,
      failure: record.failure,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    });
  }

  async find(id: string): Promise<ImportRecord | undefined> {
    if (!isImportId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(imports)
      .where(eq(imports.id, id));
    return row && toRecord(row);
  }

  async lock(tx: Transaction, id: string): Promise<ImportRecord | undefined> {
    if (!isImportId(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .select()
      .from(imports)
      .where(eq(imports.id, id))
      .for('update');
    return row && toRecord(row);
  }

  async update(
    tx: Transaction,
    id: string,
    change: ImportChange,
  ): Promise<void> {
    if (Object.keys(change).length === 0) return;
    await drizzleOf(tx)
      .update(imports)
      .set({
        ...(change.state !== undefined && { state: change.state }),
        ...(change.changeSetId !== undefined && {
          changeSetId: change.changeSetId,
        }),
        ...(change.progress !== undefined && { progress: change.progress }),
        ...(change.failure !== undefined && { failure: change.failure }),
        ...(change.startedAt !== undefined && { startedAt: change.startedAt }),
        ...(change.finishedAt !== undefined && {
          finishedAt: change.finishedAt,
        }),
        ...(change.expiresAt !== undefined && { expiresAt: change.expiresAt }),
      })
      .where(eq(imports.id, id));
  }

  async expired(now: Date, limit: number): Promise<ImportRecord[]> {
    const rows = await this.database.db
      .select()
      .from(imports)
      .where(and(lte(imports.expiresAt, now), ne(imports.state, 'applying')))
      .orderBy(asc(imports.expiresAt), asc(imports.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    await drizzleOf(tx).delete(imports).where(eq(imports.id, id));
  }

  async othersWithUpload(
    tx: Transaction,
    sha256: string,
    except: string,
  ): Promise<string[]> {
    const rows = await drizzleOf(tx)
      .select({ id: imports.id })
      .from(imports)
      .where(and(eq(imports.uploadSha256, sha256), ne(imports.id, except)))
      .orderBy(asc(imports.id));
    return rows.map((r) => r.id);
  }

  async takeOverUpload(tx: Transaction, id: string): Promise<void> {
    await drizzleOf(tx)
      .update(imports)
      .set({ uploadCreated: sql`true` })
      .where(eq(imports.id, id));
  }
}
