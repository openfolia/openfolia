import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { StoredReleaseDiff } from '../core/release-changes.js';

/**
 * Release diffs (#478): what a release changed against the one before it,
 * as `RELEASE_READER` sees both commits (`releaseDiff`), so the changelog
 * and a release's changes are not worked out from Git again after a
 * restart. Rebuildable state: derived from Git alone, never changed for a
 * pair of commits, and any row may be deleted (it is worked out again on
 * the next read). Who may see what of it is decided when it is read.
 */
export const releaseDiffs = pgTable(
  'release_diffs',
  {
    /** The release's commit (a full commit ID). */
    headCommit: text('head_commit').notNull(),
    /** The commit it is counted from; `''` for a product's first release. */
    baseCommit: text('base_commit').notNull(),
    /** `RELEASE_DIFF_FORMAT` when it was worked out: another is not read. */
    format: integer('format').notNull(),
    /** `StoredReleaseDiff`: the diff, or `"too-many-changes"`. */
    diff: jsonb('diff').$type<StoredReleaseDiff>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.headCommit, t.baseCommit] }),
    check(
      'release_diffs_head_commit',
      sql`${t.headCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      'release_diffs_base_commit',
      sql`${t.baseCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})?$'`,
    ),
  ],
);
