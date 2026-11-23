import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { releases } from './releases.tables.js';

/**
 * Maintenance lines (#60): one row per line, next to its branch in Git.
 * Never deleted; closing it (`closed_at`, `closed_by_*`) is its only
 * change. The formats are `core/maintenance-line.ts`'s, held here too.
 */
export const maintenanceLines = pgTable(
  'maintenance_lines',
  {
    /** A UUID version 7, made by the server (its time leads). */
    id: uuid('id').primaryKey(),
    product: text('product').notNull(),
    revision: text('revision').notNull(),
    /** The release it started from. */
    baseRelease: uuid('base_release')
      .notNull()
      .references(() => releases.id),
    baseCommit: text('base_commit').notNull(),
    branch: text('branch').notNull(),
    createdByKind: text('created_by_kind').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByKind: text('closed_by_kind'),
    closedById: text('closed_by_id'),
  },
  (t) => [
    check(
      'maintenance_lines_product',
      sql`${t.product} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.product}) <= 64`,
    ),
    check(
      'maintenance_lines_revision',
      sql`${t.revision} ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'`,
    ),
    check(
      'maintenance_lines_base_commit',
      sql`${t.baseCommit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'maintenance_lines_branch',
      sql`char_length(${t.branch}) between 1 and 256 and lower(${t.branch}) !~ '^(refs|change-sets)/'`,
    ),
    check(
      'maintenance_lines_created_by_kind',
      sql`${t.createdByKind} in ('user', 'service')`,
    ),
    check(
      'maintenance_lines_created_by_id',
      sql`char_length(${t.createdById}) between 1 and 200`,
    ),
    // Closed exactly when all three are set.
    check(
      'maintenance_lines_closed',
      sql`(${t.closedAt} is null and ${t.closedByKind} is null and ${t.closedById} is null) or (${t.closedAt} is not null and ${t.closedByKind} in ('user', 'service') and char_length(${t.closedById}) between 1 and 200)`,
    ),
    // One line per release, per product revision and per branch (in any
    // case, as Git on a case-insensitive file system would see it).
    uniqueIndex('maintenance_lines_base_release_idx').on(t.baseRelease),
    uniqueIndex('maintenance_lines_name_idx').on(t.product, t.revision),
    uniqueIndex('maintenance_lines_branch_idx').on(sql`lower(${t.branch})`),
    // The list, newest first, and its product filter.
    index('maintenance_lines_created_idx').on(t.createdAt, t.id),
    index('maintenance_lines_product_idx').on(t.product, t.createdAt, t.id),
  ],
);

/**
 * Which releases were cut from which line (#60): written with the
 * release's reservation, so a reservation dropped takes it along; a
 * published release is never deleted, and neither is this row then.
 */
export const maintenanceLineReleases = pgTable(
  'maintenance_line_releases',
  {
    releaseId: uuid('release_id')
      .primaryKey()
      .references(() => releases.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => maintenanceLines.id),
  },
  (t) => [index('maintenance_line_releases_line_idx').on(t.lineId)],
);
