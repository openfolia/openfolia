import { Injectable } from '@nestjs/common';
import { assetRenditions } from '../../assets/repos/asset-renditions.tables.js';
import { BlobStore } from '../../blobs/core/blob-store.js';
import { Database } from '../../database/database.js';
import { imports } from '../../imports/repos/imports.tables.js';
import { type CategoryUsage, MediaMeter } from '../core/storage-usage.js';
import { archivedPdfHashes } from './drizzle-pdf-archive-meter.js';

/**
 * `MediaMeter` over the blob store's listing (`BlobStore.list`, page by
 * page): every blob but the archived PDFs (counted apart), renditions
 * (made again on request) and the bundles imports keep (removed when the
 * import expires). A blob no upload records (one the old layout's import
 * stored, or an upload whose clean-up failed) counts: it takes room.
 */
@Injectable()
export class BlobStoreMediaMeter extends MediaMeter {
  constructor(
    private readonly blobs: BlobStore,
    private readonly database: Database,
  ) {
    super();
  }

  async measure(signal?: AbortSignal): Promise<CategoryUsage> {
    const db = this.database.db;
    const [pdfs, renditions, bundles] = await Promise.all([
      archivedPdfHashes(db),
      db
        .selectDistinct({ sha256: assetRenditions.sha256 })
        .from(assetRenditions),
      db.selectDistinct({ sha256: imports.uploadSha256 }).from(imports),
    ]);
    const apart = new Set([
      ...pdfs,
      ...renditions.map((row) => row.sha256),
      ...bundles.map((row) => row.sha256),
    ]);
    let bytes = 0;
    let files = 0;
    let after: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.blobs.list(after);
      for (const blob of page.blobs) {
        if (apart.has(blob.sha256)) continue;
        bytes += blob.size;
        files++;
      }
      after = page.next;
    } while (after !== undefined);
    return { bytes, files };
  }
}
