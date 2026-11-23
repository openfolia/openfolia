import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Renditions of images (#255): one WebP per source image and width, made
 * on first request and kept in the blob store. The blob store stays
 * content-addressed, so a rendition's bytes are stored under their own
 * hash; this table is what finds them by the source's hash and the width.
 * Rebuildable: a row whose blob is gone is made again.
 */
export const assetRenditions = pgTable(
  'asset_renditions',
  {
    /** The SHA-256 of the source image, 64 lowercase hex characters. */
    sourceSha256: text('source_sha256').notNull(),
    /** The width asked for, in pixels (`RENDITION_WIDTHS`). */
    width: integer('width').notNull(),
    /** The SHA-256 of the rendition's bytes (a WebP) in the blob store. */
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceSha256, t.width] }),
    check(
      'asset_renditions_source_sha256',
      sql`${t.sourceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('asset_renditions_sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('asset_renditions_width', sql`${t.width} in (320, 640, 1280)`),
    check('asset_renditions_size', sql`${t.size} >= 0`),
    // Whether a blob is a rendition (kept out of the unused files, and not
    // deleted while another source's rendition shares its bytes).
    index('asset_renditions_sha256_idx').on(t.sha256),
  ],
);
