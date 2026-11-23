import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  max,
  sql,
} from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { isSha256 } from '../../blobs/core/blob-store.js';
import {
  type ChangeSetAuthor,
  isChangeSetId,
} from '../../change-sets/core/change-set.js';
import { changeSets } from '../../change-sets/repos/change-sets.tables.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { FileName, MediaType } from '@openfolia/content-model';
import {
  type AssetUpload,
  MAX_UPLOADS_PER_CHANGE_SET,
  type NewAssetUpload,
} from '../core/asset-upload.js';
import { AssetUploads, type UploadedFile } from '../core/asset-uploads.js';
import { assetDeletions } from './asset-deletions.tables.js';
import { assetUploads } from './asset-uploads.tables.js';

type Row = typeof assetUploads.$inferSelect;

/**
 * Takes the hash lock of each of `hashes` (`AssetUploads.lockHash`, an
 * advisory lock held until the transaction ends) in one statement and in
 * hash order, so two transactions never wait for each other in a circle.
 * The one place the lock's key is made: another component's adapter that
 * records a file under the same lock (a release output's, #593) takes it
 * here.
 */
export async function lockFileHashes(
  db: ReturnType<typeof drizzleOf>,
  hashes: readonly string[],
): Promise<void> {
  if (hashes.length === 0) return;
  const values = sql.join(
    [...new Set(hashes)].map((hash) => sql`${hash}`),
    sql`, `,
  );
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext('asset-uploads:' || x)) from unnest(array[${values}]::text[]) as x order by x`,
  );
}

/** `AssetUploads` over the `asset_uploads` table. */
@Injectable()
export class DrizzleAssetUploads extends AssetUploads {
  constructor(private readonly database: Database) {
    super();
  }

  async record(
    tx: Transaction,
    upload: NewAssetUpload,
  ): Promise<{ upload: AssetUpload; created: boolean }> {
    // On a hash this change set holds already (or one being recorded by a
    // transaction not yet ended: Postgres waits for it), only the latest
    // upload's time moves. `xmax = 0` holds exactly for a row inserted here.
    const [row] = await drizzleOf(tx)
      .insert(assetUploads)
      .values({
        changeSetId: upload.changeSetId,
        sha256: upload.sha256,
        size: upload.size,
        contentType: upload.contentType,
        fileName: upload.fileName ?? null,
        uploadedByKind: upload.uploadedBy.kind,
        uploadedById: upload.uploadedBy.id,
        uploadedAt: sql`now()`,
        lastUploadedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [assetUploads.changeSetId, assetUploads.sha256],
        set: { lastUploadedAt: sql`now()` },
      })
      .returning({
        ...getTableColumns(assetUploads),
        created: sql<boolean>`(xmax = 0)`,
      });
    if (!row) throw new Error('An upsert returned no row.');
    const { created, ...stored } = row;
    return { upload: toUpload(stored), created };
  }

  async lockHash(tx: Transaction, sha256: string): Promise<void> {
    await lockFileHashes(drizzleOf(tx), [sha256]);
  }

  async lockHashes(tx: Transaction, hashes: readonly string[]): Promise<void> {
    await lockFileHashes(drizzleOf(tx), hashes);
  }

  async recorded(tx: Transaction, sha256: string): Promise<boolean> {
    const [row] = await drizzleOf(tx)
      .select({ sha256: assetUploads.sha256 })
      .from(assetUploads)
      .where(eq(assetUploads.sha256, sha256))
      .limit(1);
    return row !== undefined;
  }

  async count(
    tx: Transaction,
    changeSetId: string,
    topType?: string,
  ): Promise<number> {
    const inChangeSet = eq(assetUploads.changeSetId, changeSetId);
    const [row] = await drizzleOf(tx)
      .select({ n: count() })
      .from(assetUploads)
      .where(
        topType === undefined
          ? inChangeSet
          : and(
              inChangeSet,
              // A media type is lowercase letters, digits and `.+-` (the table's check): no
              // pattern character to escape.
              sql`starts_with(${assetUploads.contentType}, ${`${topType}/`})`,
            ),
      );
    return row?.n ?? 0;
  }

  async find(
    changeSetId: string,
    sha256: string,
  ): Promise<AssetUpload | undefined> {
    // A malformed key would only make Postgres refuse the UUID.
    if (!isChangeSetId(changeSetId) || !isSha256(sha256)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(assetUploads)
      .where(byKey(changeSetId, sha256));
    return row && toUpload(row);
  }

  async list(changeSetId: string): Promise<AssetUpload[]> {
    if (!isChangeSetId(changeSetId)) return [];
    const rows = await this.database.db
      .select()
      .from(assetUploads)
      .where(eq(assetUploads.changeSetId, changeSetId))
      .orderBy(desc(assetUploads.lastUploadedAt), asc(assetUploads.sha256))
      .limit(MAX_UPLOADS_PER_CHANGE_SET);
    return rows.map(toUpload);
  }

  async lastUploaded(
    tx: Transaction,
    sha256: string,
  ): Promise<Date | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ at: max(assetUploads.lastUploadedAt) })
      .from(assetUploads)
      .where(eq(assetUploads.sha256, sha256));
    return row?.at ?? undefined;
  }

  async removeAllOf(tx: Transaction, sha256: string): Promise<number> {
    const rows = await drizzleOf(tx)
      .delete(assetUploads)
      .where(eq(assetUploads.sha256, sha256))
      .returning({ sha256: assetUploads.sha256 });
    return rows.length;
  }

  async files(): Promise<UploadedFile[]> {
    const rows = await this.database.db
      .select({
        sha256: assetUploads.sha256,
        lastUploadedAt: max(assetUploads.lastUploadedAt),
        contentType: sql<string>`(array_agg(${assetUploads.contentType} order by ${assetUploads.uploadedAt}, ${assetUploads.changeSetId}))[1]`,
        fileName: sql<
          string | null
        >`(array_agg(${assetUploads.fileName} order by ${assetUploads.uploadedAt}, ${assetUploads.changeSetId}) filter (where ${assetUploads.fileName} is not null))[1]`,
      })
      .from(assetUploads)
      .groupBy(assetUploads.sha256);
    return rows.map((row) => {
      if (
        row.lastUploadedAt === null ||
        !MediaType.safeParse(row.contentType).success ||
        (row.fileName !== null && !FileName.safeParse(row.fileName).success)
      ) {
        throw new Error(`The uploads of ${row.sha256} are malformed.`);
      }
      return {
        sha256: row.sha256,
        lastUploadedAt: row.lastUploadedAt,
        contentType: row.contentType,
        ...(row.fileName !== null ? { fileName: row.fileName } : {}),
      };
    });
  }

  async uploadedForAuthor(
    author: ChangeSetAuthor,
    hashes: readonly string[],
  ): Promise<string[]> {
    const wanted = [...new Set(hashes.filter(isSha256))];
    if (wanted.length === 0) return [];
    const rows = await this.database.db
      .selectDistinct({ sha256: assetUploads.sha256 })
      .from(assetUploads)
      .innerJoin(changeSets, eq(changeSets.id, assetUploads.changeSetId))
      .where(
        and(
          inArray(assetUploads.sha256, wanted),
          eq(changeSets.authorKind, author.kind),
          eq(changeSets.authorId, author.id),
        ),
      );
    return rows.map((row) => row.sha256).sort();
  }

  async uploadedInto(changeSetIds: readonly string[]): Promise<string[]> {
    if (changeSetIds.length === 0) return [];
    const rows = await this.database.db
      .selectDistinct({ sha256: assetUploads.sha256 })
      .from(assetUploads)
      .where(inArray(assetUploads.changeSetId, [...changeSetIds]));
    return rows.map((row) => row.sha256);
  }

  async markDeleted(tx: Transaction, sha256: string): Promise<void> {
    await drizzleOf(tx)
      .insert(assetDeletions)
      .values({ sha256, markedAt: sql`now()` })
      .onConflictDoUpdate({
        target: assetDeletions.sha256,
        set: { markedAt: sql`now()` },
      });
  }

  async clearDeleted(tx: Transaction, sha256: string): Promise<void> {
    await drizzleOf(tx)
      .delete(assetDeletions)
      .where(eq(assetDeletions.sha256, sha256));
  }

  async deletedAmong(
    tx: Transaction,
    hashes: readonly string[],
  ): Promise<string[]> {
    if (hashes.length === 0) return [];
    const rows = await drizzleOf(tx)
      .select({ sha256: assetDeletions.sha256 })
      .from(assetDeletions)
      .where(inArray(assetDeletions.sha256, [...hashes]));
    return rows.map((row) => row.sha256).sort();
  }
}

const byKey = (changeSetId: string, sha256: string) =>
  and(
    eq(assetUploads.changeSetId, changeSetId),
    eq(assetUploads.sha256, sha256),
  );

function toUpload(row: Row): AssetUpload {
  if (
    !MediaType.safeParse(row.contentType).success ||
    (row.fileName !== null && !FileName.safeParse(row.fileName).success) ||
    (row.uploadedByKind !== 'user' && row.uploadedByKind !== 'service')
  ) {
    // The database checks these (the file name's form only by its length;
    // nothing else writes it): a 500, never a record passed on unchecked.
    throw new Error(
      `The upload of ${row.sha256} into change set ${row.changeSetId} is malformed.`,
    );
  }
  return {
    changeSetId: row.changeSetId,
    sha256: row.sha256,
    size: row.size,
    contentType: row.contentType,
    ...(row.fileName !== null ? { fileName: row.fileName } : {}),
    uploadedBy: { kind: row.uploadedByKind, id: row.uploadedById },
    uploadedAt: row.uploadedAt,
    lastUploadedAt: row.lastUploadedAt,
  };
}
