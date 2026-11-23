import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Change sets: drafts on their own Git branch. Git holds the content; this
 * row holds who started it, from where, and where it is in its life. The
 * formats are `core/change-set.ts`'s, held here too.
 */
export const changeSets = pgTable(
  'change_sets',
  {
    /** A UUID version 7, made by the server (its time leads). */
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    authorKind: text('author_kind').notNull(),
    authorId: text('author_id').notNull(),
    baseRef: text('base_ref').notNull(),
    baseCommit: text('base_commit').notNull(),
    /** Whether the base commit was released content then (#126). */
    baseReleased: boolean('base_released').notNull().default(false),
    branch: text('branch').notNull(),
    state: text('state').notNull(),
    /** The commit submitted for review; null while a draft (#21). */
    reviewHead: text('review_head'),
    /** Where its base branch was once merged: the merge commit (#21). */
    mergeCommit: text('merge_commit'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('change_sets_title', sql`char_length(${t.title}) between 1 and 200`),
    check(
      'change_sets_description',
      sql`${t.description} is null or char_length(${t.description}) between 1 and 10000`,
    ),
    check(
      'change_sets_author_kind',
      sql`${t.authorKind} in ('user', 'service')`,
    ),
    check(
      'change_sets_author_id',
      sql`char_length(${t.authorId}) between 1 and 200`,
    ),
    check(
      'change_sets_base_ref',
      sql`char_length(${t.baseRef}) between 1 and 256 and ${t.baseRef} not like 'change-sets/%'`,
    ),
    check(
      'change_sets_base_commit',
      sql`${t.baseCommit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    // The branch is named from the ID, never by a client.
    check(
      'change_sets_branch',
      sql`${t.branch} = 'change-sets/' || ${t.id}::text`,
    ),
    check(
      'change_sets_state',
      sql`${t.state} in ('draft', 'in-review', 'approved', 'merged', 'abandoned')`,
    ),
    check(
      'change_sets_review_head',
      sql`${t.reviewHead} is null or ${t.reviewHead} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'change_sets_merge_commit',
      sql`${t.mergeCommit} is null or ${t.mergeCommit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    // Under review, approved and merged change sets have the commit
    // reviewed; a draft has none.
    check(
      'change_sets_review_state',
      sql`(${t.state} in ('in-review', 'approved', 'merged')) = (${t.reviewHead} is not null) or ${t.state} = 'abandoned'`,
    ),
    check(
      'change_sets_merged',
      sql`(${t.state} = 'merged') = (${t.mergeCommit} is not null)`,
    ),
    uniqueIndex('change_sets_branch_idx').on(t.branch),
    // The list's filters, each with its order (newest first).
    index('change_sets_created_idx').on(t.createdAt, t.id),
    index('change_sets_state_idx').on(t.state, t.createdAt, t.id),
    index('change_sets_author_idx').on(t.authorId, t.createdAt, t.id),
  ],
);
