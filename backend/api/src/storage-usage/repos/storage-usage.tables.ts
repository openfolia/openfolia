import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  smallint,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The storage an instance uses (#404), kept as totals in one row (`id` 1,
 * which the migration inserts): moved on every upload and delete in the
 * transaction making it, replaced by the periodic recount. Bytes and file
 * counts never go below 0. `limit_bytes` is the storage limit last
 * recorded (`CCMS_STORAGE_LIMIT_BYTES`; null: none), so a change of the
 * setting is audited once. While a recount is claimed, the `*_added_*`
 * columns gather what uploads add meanwhile, which the recount's listing
 * may have missed; the recount adds them to what it found, so a change
 * made while it counts is counted at worst twice (refusing a little
 * early), never lost (letting uploads past the limit).
 */
export const storageUsage = pgTable(
  'storage_usage',
  {
    id: smallint('id').primaryKey(),
    mediaBytes: bigint('media_bytes', { mode: 'number' }).notNull(),
    mediaFiles: bigint('media_files', { mode: 'number' }).notNull(),
    pdfBytes: bigint('pdf_bytes', { mode: 'number' }).notNull(),
    pdfFiles: bigint('pdf_files', { mode: 'number' }).notNull(),
    mediaAddedBytes: bigint('media_added_bytes', { mode: 'number' })
      .notNull()
      .default(0),
    mediaAddedFiles: bigint('media_added_files', { mode: 'number' })
      .notNull()
      .default(0),
    pdfAddedBytes: bigint('pdf_added_bytes', { mode: 'number' })
      .notNull()
      .default(0),
    pdfAddedFiles: bigint('pdf_added_files', { mode: 'number' })
      .notNull()
      .default(0),
    /** The content repository on disk, as of the last recount; for information. */
    gitBytes: bigint('git_bytes', { mode: 'number' }),
    /** The database, as of the last recount; for information. */
    databaseBytes: bigint('database_bytes', { mode: 'number' }),
    recountedAt: timestamp('recounted_at', { withTimezone: true }),
    /** When a server claimed the recount under way (`claimRecount`). */
    recountClaimedAt: timestamp('recount_claimed_at', { withTimezone: true }),
    limitBytes: bigint('limit_bytes', { mode: 'number' }),
  },
  (t) => [
    check('storage_usage_one_row', sql`${t.id} = 1`),
    check(
      'storage_usage_counts',
      sql`${t.mediaBytes} >= 0 and ${t.mediaFiles} >= 0 and ${t.pdfBytes} >= 0 and ${t.pdfFiles} >= 0 and ${t.mediaAddedBytes} >= 0 and ${t.mediaAddedFiles} >= 0 and ${t.pdfAddedBytes} >= 0 and ${t.pdfAddedFiles} >= 0`,
    ),
    check(
      'storage_usage_sizes',
      sql`(${t.gitBytes} is null or ${t.gitBytes} >= 0) and (${t.databaseBytes} is null or ${t.databaseBytes} >= 0)`,
    ),
    check(
      'storage_usage_limit',
      sql`${t.limitBytes} is null or ${t.limitBytes} > 0`,
    ),
  ],
);
