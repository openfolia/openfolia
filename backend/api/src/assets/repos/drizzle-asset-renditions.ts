import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { isSha256 } from '../../blobs/core/blob-store.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type AssetRendition,
  type NewAssetRendition,
  RENDITION_WIDTHS,
  type RenditionWidth,
} from '../core/asset-rendition.js';
import { AssetRenditions } from '../core/asset-renditions.js';
import { assetRenditions } from './asset-renditions.tables.js';

type Row = typeof assetRenditions.$inferSelect;

/** `AssetRenditions` over the `asset_renditions` table. */
@Injectable()
export class DrizzleAssetRenditions extends AssetRenditions {
  constructor(private readonly database: Database) {
    super();
  }

  async find(
    sourceSha256: string,
    width: RenditionWidth,
  ): Promise<AssetRendition | undefined> {
    if (!isSha256(sourceSha256)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(assetRenditions)
      .where(
        and(
          eq(assetRenditions.sourceSha256, sourceSha256),
          eq(assetRenditions.width, width),
        ),
      );
    return row && toRendition(row);
  }

  async record(tx: Transaction, rendition: NewAssetRendition): Promise<void> {
    await drizzleOf(tx)
      .insert(assetRenditions)
      .values({ ...rendition, createdAt: sql`now()` })
      .onConflictDoUpdate({
        target: [assetRenditions.sourceSha256, assetRenditions.width],
        set: {
          sha256: rendition.sha256,
          size: rendition.size,
          createdAt: sql`now()`,
        },
      });
  }

  async removeAllOf(
    tx: Transaction,
    sourceSha256: string,
  ): Promise<AssetRendition[]> {
    const rows = await drizzleOf(tx)
      .delete(assetRenditions)
      .where(eq(assetRenditions.sourceSha256, sourceSha256))
      .returning();
    return rows.map(toRendition);
  }

  async isRendition(tx: Transaction, sha256: string): Promise<boolean> {
    const [row] = await drizzleOf(tx)
      .select({ sha256: assetRenditions.sha256 })
      .from(assetRenditions)
      .where(eq(assetRenditions.sha256, sha256))
      .limit(1);
    return row !== undefined;
  }

  async renditionHashes(): Promise<Set<string>> {
    const rows = await this.database.db
      .selectDistinct({ sha256: assetRenditions.sha256 })
      .from(assetRenditions);
    return new Set(rows.map((row) => row.sha256));
  }
}

function toRendition(row: Row): AssetRendition {
  const width = RENDITION_WIDTHS.find((w) => w === row.width);
  if (width === undefined) {
    // The database checks it: a 500, never a record passed on unchecked.
    throw new Error(`The rendition of ${row.sourceSha256} has no known width.`);
  }
  return {
    sourceSha256: row.sourceSha256,
    width,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.createdAt,
  };
}
