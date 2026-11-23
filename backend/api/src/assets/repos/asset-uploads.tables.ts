import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from '../../change-sets/repos/change-sets.tables.js';

/**
 * Files uploaded into change sets: images (#25) and attachments (#236): one row per change set and hash,
 * so uploading the same image again adds nothing. The bytes are in the
 * blob store; this is what retention reads to keep a blob within its
 * grace period while no commit refers to it yet. The formats are
 * `core/asset-upload.ts`'s, held here too.
 */
export const assetUploads = pgTable(
  'asset_uploads',
  {
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    /** The SHA-256 of the stored bytes, 64 lowercase hex characters. */
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    /**
     * The file's name as uploaded, made a valid `FileName` (#236): what an
     * attachment downloads as, and what `GET /assets` finds an upload by.
     * Null when the client sent none that could be kept.
     */
    fileName: text('file_name'),
    uploadedByKind: text('uploaded_by_kind').notNull(),
    uploadedById: text('uploaded_by_id').notNull(),
    /** The first recording transaction's time, as the audit event's `at`. */
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    /**
     * The latest upload's time: the same image uploaded again moves it, so
     * retention's grace period runs from the reference handed out last.
     */
    lastUploadedAt: timestamp('last_uploaded_at', {
      withTimezone: true,
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.changeSetId, t.sha256] }),
    check('asset_uploads_sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('asset_uploads_size', sql`${t.size} >= 0`),
    // Any media type since #236 (attachments): lowercase type/subtype, as the blob store keeps it.
    check(
      'asset_uploads_content_type',
      sql`${t.contentType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$'`,
    ),
    check(
      'asset_uploads_file_name',
      sql`${t.fileName} is null or char_length(${t.fileName}) between 1 and 255`,
    ),
    check(
      'asset_uploads_uploaded_by_kind',
      sql`${t.uploadedByKind} in ('user', 'service')`,
    ),
    check(
      'asset_uploads_uploaded_by_id',
      sql`char_length(${t.uploadedById}) between 1 and 200`,
    ),
    // Retention: the uploads of a hash, and those older than its grace period.
    index('asset_uploads_sha256_idx').on(t.sha256),
    index('asset_uploads_last_uploaded_at_idx').on(t.lastUploadedAt),
  ],
);
