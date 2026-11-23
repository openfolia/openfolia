import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from '../../change-sets/repos/change-sets.tables.js';

/**
 * Comments on blocks of a change set's modules (#24). A thread's first
 * comment anchors it (`thread_id` is its own ID); a reply names it in
 * `thread_id`, and the database holds the reply to the same change set
 * and anchor (the composite foreign key). Only a thread's first comment
 * carries a resolution, and only it stays once deleted (without its
 * text, for its replies; #268). Operational state: never in Git. The formats are
 * `core/comment.ts`'s, held here too.
 */
export const comments = pgTable(
  'comments',
  {
    /** A UUID version 7, made by the server (its time leads). */
    id: uuid('id').primaryKey(),
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    /** The thread's first comment: this comment's own ID for a thread. */
    threadId: uuid('thread_id').notNull(),
    /** `module`, as the audit log names it. */
    subjectType: text('subject_type').notNull(),
    /** `<lang>/<moduleId>`, the language in its canonical case. */
    subjectId: text('subject_id').notNull(),
    blockId: text('block_id').notNull(),
    /** The change set's head the comment was written on. */
    commit: text('commit').notNull(),
    authorKind: text('author_kind').notNull(),
    authorId: text('author_id').notNull(),
    /** The text; null once its author deleted it (a thread start kept for its replies). */
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** When its author last changed the text; null while never edited. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /**
     * When its author deleted it: only a thread's first comment with
     * replies stays (as "deleted", without its text); any other is removed.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByKind: text('resolved_by_kind'),
    resolvedById: text('resolved_by_id'),
  },
  (t) => [
    check(
      'comments_subject',
      sql`${t.subjectType} = 'module' and ${t.subjectId} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${t.subjectId}) <= 200`,
    ),
    check(
      'comments_block_id',
      sql`${t.blockId} ~ '^[a-z_][a-z0-9_-]*$' and char_length(${t.blockId}) <= 64`,
    ),
    check(
      'comments_commit',
      sql`${t.commit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check('comments_author_kind', sql`${t.authorKind} in ('user', 'service')`),
    check(
      'comments_author_id',
      sql`char_length(${t.authorId}) between 1 and 200`,
    ),
    // A text of 1 to 10,000 characters, or none once deleted (and only
    // then); only a thread's first comment stays deleted.
    check(
      'comments_body',
      sql`(${t.deletedAt} is null and ${t.body} is not null and char_length(${t.body}) between 1 and 10000) or (${t.deletedAt} is not null and ${t.body} is null and ${t.threadId} = ${t.id})`,
    ),
    // A resolution is complete or absent, and only on a thread's first
    // comment (`is not null` spelled out: a null makes a check pass).
    check(
      'comments_resolution',
      sql`(${t.resolvedAt} is null and ${t.resolvedByKind} is null and ${t.resolvedById} is null) or (${t.resolvedAt} is not null and ${t.resolvedByKind} is not null and ${t.resolvedById} is not null and ${t.resolvedByKind} in ('user', 'service') and char_length(${t.resolvedById}) between 1 and 200 and ${t.threadId} = ${t.id})`,
    ),
    // What a reply's foreign key names: its thread, in the same change set, on the same anchor.
    unique('comments_anchor_key').on(
      t.id,
      t.changeSetId,
      t.subjectId,
      t.blockId,
    ),
    foreignKey({
      name: 'comments_thread_fk',
      columns: [t.threadId, t.changeSetId, t.subjectId, t.blockId],
      foreignColumns: [t.id, t.changeSetId, t.subjectId, t.blockId],
    }).onDelete('restrict'),
    // The list, in thread order, and its module filter.
    index('comments_thread_idx').on(t.changeSetId, t.threadId, t.id),
    index('comments_subject_idx').on(t.changeSetId, t.subjectId, t.blockId),
  ],
);
