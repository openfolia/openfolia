import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { brandingImages } from '../../branding/repos/branding.tables.js';
import { imports } from '../../imports/repos/imports.tables.js';
import { type BlobHolder, HeldBlobs } from '../core/held-blobs.js';

/**
 * `HeldBlobs` over the `imports` table (the uploads of the imports kept) and
 * `branding_images` (every image uploaded for the branding).
 */
@Injectable()
export class DrizzleHeldBlobs extends HeldBlobs {
  constructor(private readonly database: Database) {
    super();
  }

  async held(): Promise<{ sha256: string; by: BlobHolder }[]> {
    const db = this.database.db;
    const [bundles, images] = await Promise.all([
      db.selectDistinct({ sha256: imports.uploadSha256 }).from(imports),
      db.select({ sha256: brandingImages.sha256 }).from(brandingImages),
    ]);
    return [
      ...bundles.map((row) => ({ sha256: row.sha256, by: 'import' as const })),
      ...images.map((row) => ({ sha256: row.sha256, by: 'branding' as const })),
    ];
  }

  async holds(
    tx: Transaction,
    sha256: string,
    by?: BlobHolder,
  ): Promise<BlobHolder | null> {
    const db = drizzleOf(tx);
    if (by === undefined || by === 'import') {
      const [bundle] = await db
        .select({ sha256: imports.uploadSha256 })
        .from(imports)
        .where(eq(imports.uploadSha256, sha256))
        .limit(1);
      if (bundle) return 'import';
      if (by === 'import') return null;
    }
    const [image] = await db
      .select({ sha256: brandingImages.sha256 })
      .from(brandingImages)
      .where(eq(brandingImages.sha256, sha256))
      .limit(1);
    return image ? 'branding' : null;
  }
}
