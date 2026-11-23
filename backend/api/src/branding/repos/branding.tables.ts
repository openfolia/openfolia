import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const SHA256 = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;
const HEX = (column: unknown) => sql`${column} ~ '^#[0-9a-f]{6}$'`;

/**
 * The platform's branding (#169), in one row (`id` 1, made by the first
 * change): the product name, the image fields (a blob's SHA-256, one of
 * `branding_images`) and the colours (`#rrggbb`); null is the default.
 * `version` counts the changes (the ETag of `GET /branding`).
 */
export const branding = pgTable(
  'branding',
  {
    id: smallint('id').primaryKey(),
    version: integer('version').notNull(),
    productName: text('product_name'),
    logoLight: text('logo_light'),
    logoDark: text('logo_dark'),
    mark: text('mark'),
    favicon: text('favicon'),
    appIcon: text('app_icon'),
    primary: text('primary_colour'),
    accent: text('accent_colour'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('branding_one_row', sql`${t.id} = 1`),
    check('branding_version', sql`${t.version} >= 0`),
    check(
      'branding_product_name',
      sql`${t.productName} is null or char_length(${t.productName}) between 1 and 80`,
    ),
    check(
      'branding_images',
      sql`(${t.logoLight} is null or ${SHA256(t.logoLight)}) and (${t.logoDark} is null or ${SHA256(t.logoDark)}) and (${t.mark} is null or ${SHA256(t.mark)}) and (${t.favicon} is null or ${SHA256(t.favicon)}) and (${t.appIcon} is null or ${SHA256(t.appIcon)})`,
    ),
    check(
      'branding_colours',
      sql`(${t.primary} is null or ${HEX(t.primary)}) and (${t.accent} is null or ${HEX(t.accent)})`,
    ),
  ],
);

/**
 * The images uploaded for the branding (#169), by hash: one row each, so the
 * same image again adds nothing. The bytes are in the blob store; a field of
 * `branding` may name only a hash recorded here, and only those the branding
 * names are served (`GET /branding/images/:sha256`).
 */
export const brandingImages = pgTable(
  'branding_images',
  {
    sha256: text('sha256').primaryKey(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    uploadedByKind: text('uploaded_by_kind').notNull(),
    uploadedById: text('uploaded_by_id').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('branding_images_sha256', SHA256(t.sha256)),
    check(
      'branding_images_type',
      sql`${t.contentType} in ('image/png', 'image/webp')`,
    ),
    check(
      'branding_images_size',
      sql`${t.size} > 0 and ${t.width} > 0 and ${t.height} > 0`,
    ),
  ],
);
