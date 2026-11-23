import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Where files are used (#476): per commit, the file hashes its module files
 * mention (`AssetReferenceIndex`), one row per commit (a row per hash took
 * 300 MB for 187 commits of 3,000 files). A rebuildable index: derived from
 * Git alone, dropped and built again with the same result
 * (`pnpm nx run api:index-rebuild`). A commit's row is written once.
 */
export const assetReferenceCommits = pgTable(
  'asset_reference_commits',
  {
    /** A full commit ID (40 or 64 lowercase hex characters). */
    commit: text('commit').primaryKey(),
    /** The hashes, each once, sorted (64 lowercase hex characters each). */
    hashes: text('hashes').array().notNull(),
    builtAt: timestamp('built_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'asset_reference_commits_commit',
      sql`${t.commit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      'asset_reference_commits_hashes',
      sql`array_position(${t.hashes}, null) is null and array_to_string(${t.hashes}, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'`,
    ),
    // Commits no ref points to any more are dropped oldest first.
    index('asset_reference_commits_built_at_idx').on(t.builtAt),
  ],
);
