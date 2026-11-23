import { Injectable } from '@nestjs/common';
import { asc, countDistinct, desc, eq, max, sql } from 'drizzle-orm';
import { FileName, MediaType } from '@openfolia/content-model';
import { assetRenditions } from '../../assets/repos/asset-renditions.tables.js';
import { assetUploads } from '../../assets/repos/asset-uploads.tables.js';
import { imports } from '../../imports/repos/imports.tables.js';
import { releaseOutputs } from '../../releases/repos/releases.tables.js';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type CategoryUsage,
  type MediaExclusion,
  type StorageCategory,
  type StorageCount,
  type StorageTotals,
  type StoredFile,
  StorageUsage,
} from '../core/storage-usage.js';
import { storageUsage } from './storage-usage.tables.js';

const ROW = 1;
const byRow = eq(storageUsage.id, ROW);

type Row = typeof storageUsage.$inferSelect;

/** `StorageUsage` over the one row of `storage_usage`, and `asset_uploads` for the largest files. */
@Injectable()
export class DrizzleStorageUsage extends StorageUsage {
  constructor(private readonly database: Database) {
    super();
  }

  async read(tx: Transaction): Promise<StorageTotals> {
    const [row] = await drizzleOf(tx).select().from(storageUsage).where(byRow);
    return toTotals(row);
  }

  async adjust(
    tx: Transaction,
    category: StorageCategory,
    change: CategoryUsage,
  ): Promise<StorageTotals> {
    const add = (column: AnyPgColumn, by: number) =>
      sql`greatest(0, ${column} + ${by}::bigint)`;
    // While a recount is claimed, what is added is also gathered apart,
    // for the recount to add to what it found (`recounted`).
    const meanwhile = (column: AnyPgColumn, by: number) =>
      sql`case when ${storageUsage.recountClaimedAt} is null then ${column} else ${column} + greatest(0, ${by}::bigint) end`;
    const set =
      category === 'media'
        ? {
            mediaBytes: add(storageUsage.mediaBytes, change.bytes),
            mediaFiles: add(storageUsage.mediaFiles, change.files),
            mediaAddedBytes: meanwhile(
              storageUsage.mediaAddedBytes,
              change.bytes,
            ),
            mediaAddedFiles: meanwhile(
              storageUsage.mediaAddedFiles,
              change.files,
            ),
          }
        : {
            pdfBytes: add(storageUsage.pdfBytes, change.bytes),
            pdfFiles: add(storageUsage.pdfFiles, change.files),
            pdfAddedBytes: meanwhile(storageUsage.pdfAddedBytes, change.bytes),
            pdfAddedFiles: meanwhile(storageUsage.pdfAddedFiles, change.files),
          };
    const [row] = await drizzleOf(tx)
      .update(storageUsage)
      .set(set)
      .where(byRow)
      .returning();
    return toTotals(row);
  }

  async claimRecount(
    tx: Transaction,
    now: Date,
    { everyMs, claimMs }: { everyMs: number; claimMs: number },
  ): Promise<boolean> {
    const due = new Date(now.getTime() - everyMs);
    const stale = new Date(now.getTime() - claimMs);
    const rows = await drizzleOf(tx)
      .update(storageUsage)
      .set({
        recountClaimedAt: now,
        mediaAddedBytes: 0,
        mediaAddedFiles: 0,
        pdfAddedBytes: 0,
        pdfAddedFiles: 0,
      })
      .where(
        sql`${byRow} and (${storageUsage.recountedAt} is null or ${storageUsage.recountedAt} <= ${due.toISOString()}::timestamptz) and (${storageUsage.recountClaimedAt} is null or ${storageUsage.recountClaimedAt} <= ${stale.toISOString()}::timestamptz)`,
      )
      .returning({ id: storageUsage.id });
    return rows.length > 0;
  }

  async recounted(
    tx: Transaction,
    count: StorageCount,
    now: Date,
  ): Promise<void> {
    await drizzleOf(tx)
      .update(storageUsage)
      .set({
        // What was added while it counted, which its listing may have missed.
        mediaBytes: sql`${count.media.bytes}::bigint + ${storageUsage.mediaAddedBytes}`,
        mediaFiles: sql`${count.media.files}::bigint + ${storageUsage.mediaAddedFiles}`,
        pdfBytes: sql`${count.pdfs.bytes}::bigint + ${storageUsage.pdfAddedBytes}`,
        pdfFiles: sql`${count.pdfs.files}::bigint + ${storageUsage.pdfAddedFiles}`,
        mediaAddedBytes: 0,
        mediaAddedFiles: 0,
        pdfAddedBytes: 0,
        pdfAddedFiles: 0,
        gitBytes: count.gitBytes,
        databaseBytes: count.databaseBytes,
        recountedAt: now,
        recountClaimedAt: null,
      })
      .where(
        sql`${byRow} and ${storageUsage.recountClaimedAt} = ${now.toISOString()}::timestamptz`,
      );
  }

  async lockLimit(tx: Transaction): Promise<number | null> {
    const [row] = await drizzleOf(tx)
      .select({ limitBytes: storageUsage.limitBytes })
      .from(storageUsage)
      .where(byRow)
      .for('update');
    if (!row) throw new Error('The storage_usage row is missing.');
    return row.limitBytes;
  }

  async recordLimit(tx: Transaction, limit: number | null): Promise<void> {
    await drizzleOf(tx)
      .update(storageUsage)
      .set({ limitBytes: limit })
      .where(byRow);
  }

  async apartFromMedia(
    tx: Transaction,
    sha256: string,
  ): Promise<MediaExclusion | undefined> {
    // The media meter's exclusions (`BlobStoreMediaMeter`), for one hash.
    const result = await drizzleOf(tx).execute<{
      apart: MediaExclusion | null;
    }>(
      sql`select case
        when exists (select 1 from ${releaseOutputs} where ${releaseOutputs.sha256} = ${sha256} and ${releaseOutputs.state} = 'done') then 'pdf'
        when exists (select 1 from ${assetRenditions} where ${assetRenditions.sha256} = ${sha256}) then 'rendition'
        when exists (select 1 from ${imports} where ${imports.uploadSha256} = ${sha256}) then 'bundle'
      end as apart`,
    );
    return result.rows[0]?.apart ?? undefined;
  }

  async largestFiles(page: PageRequest): Promise<Paginated<StoredFile>> {
    const db = this.database.db;
    const size = max(assetUploads.size);
    const [rows, [total]] = await Promise.all([
      db
        .select({
          sha256: assetUploads.sha256,
          size,
          lastUploadedAt: max(assetUploads.lastUploadedAt),
          contentType: sql<string>`(array_agg(${assetUploads.contentType} order by ${assetUploads.uploadedAt}, ${assetUploads.changeSetId}))[1]`,
          fileName: sql<
            string | null
          >`(array_agg(${assetUploads.fileName} order by ${assetUploads.uploadedAt}, ${assetUploads.changeSetId}) filter (where ${assetUploads.fileName} is not null))[1]`,
        })
        .from(assetUploads)
        .groupBy(assetUploads.sha256)
        .orderBy(desc(size), asc(assetUploads.sha256))
        .limit(page.size)
        .offset((page.number - 1) * page.size),
      db.select({ n: countDistinct(assetUploads.sha256) }).from(assetUploads),
    ]);
    return {
      total: total?.n ?? 0,
      items: rows.map((row) => {
        if (
          row.size === null ||
          row.lastUploadedAt === null ||
          !MediaType.safeParse(row.contentType).success ||
          (row.fileName !== null && !FileName.safeParse(row.fileName).success)
        ) {
          throw new Error(`The uploads of ${row.sha256} are malformed.`);
        }
        return {
          sha256: row.sha256,
          size: row.size,
          contentType: row.contentType,
          ...(row.fileName !== null ? { fileName: row.fileName } : {}),
          lastUploadedAt: row.lastUploadedAt,
        };
      }),
    };
  }
}

function toTotals(row: Row | undefined): StorageTotals {
  // The migration inserts it, and nothing deletes it.
  if (!row) throw new Error('The storage_usage row is missing.');
  return {
    media: { bytes: row.mediaBytes, files: row.mediaFiles },
    pdfs: { bytes: row.pdfBytes, files: row.pdfFiles },
    gitBytes: row.gitBytes,
    databaseBytes: row.databaseBytes,
    recountedAt: row.recountedAt,
  };
}
