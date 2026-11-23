import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { releaseOutputs } from '../../releases/repos/releases.tables.js';
import { type CategoryUsage, PdfArchiveMeter } from '../core/storage-usage.js';

const archived = and(
  eq(releaseOutputs.state, 'done'),
  isNotNull(releaseOutputs.sha256),
);

/** The hashes of every archived PDF (a `done` release output's), each once. */
export async function archivedPdfHashes(db: Database['db']): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sha256: releaseOutputs.sha256 })
    .from(releaseOutputs)
    .where(archived);
  return rows.flatMap((row) => (row.sha256 === null ? [] : [row.sha256]));
}

/**
 * `PdfArchiveMeter` over `release_outputs`: the files of the `done`
 * outputs, each hash once (an output reusing the previous release's file
 * shares its hash, and is stored once). Kept forever (#241).
 */
@Injectable()
export class DrizzlePdfArchiveMeter extends PdfArchiveMeter {
  constructor(private readonly database: Database) {
    super();
  }

  async measure(): Promise<CategoryUsage> {
    const files = this.database.db
      .selectDistinct({
        sha256: releaseOutputs.sha256,
        size: releaseOutputs.size,
      })
      .from(releaseOutputs)
      .where(archived)
      .as('files');
    const [row] = await this.database.db
      .select({
        bytes: sql<string>`coalesce(sum(${files.size}), 0)`,
        files: sql<string>`count(*)`,
      })
      .from(files);
    return { bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
  }
}
