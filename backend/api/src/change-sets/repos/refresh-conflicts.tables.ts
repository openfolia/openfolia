import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from './change-sets.tables.js';

/**
 * The conflicts an update from the base reported (#437): one row per
 * change set and subject, written when the update answers
 * `refresh-conflict` (or `refresh-unresolved`), with the base head it was
 * reported against; `saved_at` is set by the first working-copy save after
 * it. "Update again" keeps a subject's file only once it is set (or by the
 * author's explicit choice). Cleared when an update goes through. The
 * subject's format is `locks`'s.
 */
export const refreshConflicts = pgTable(
  'refresh_conflicts',
  {
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    /** The base branch's head the conflict was reported against. */
    base: text('base').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
    /** The first working-copy save since the report; null while none. */
    savedAt: timestamp('saved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.changeSetId, t.subjectType, t.subjectId] }),
    check(
      'refresh_conflicts_subject',
      sql`(${t.subjectType} = 'module' and ${t.subjectId} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'manual' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'config' and ${t.subjectId} = 'ccms.yaml') or (${t.subjectType} = 'term' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'design' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'template' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*/([A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$')`,
    ),
    check(
      'refresh_conflicts_subject_id',
      sql`char_length(${t.subjectId}) <= 200`,
    ),
    check(
      'refresh_conflicts_base',
      sql`${t.base} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
  ],
);
