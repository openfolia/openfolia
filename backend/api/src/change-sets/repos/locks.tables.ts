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
import { changeSets } from './change-sets.tables.js';

/**
 * Locks on modules and manuals: while one exists, only its change set may
 * change its subject. One per subject (`locks_subject_idx`), so of two
 * transactions taking the same subject at once exactly one succeeds. The
 * formats are `core/lock.ts`'s, held here too.
 */
export const locks = pgTable(
  'locks',
  {
    /** A UUID version 7, made by the server for each lock taken. */
    id: uuid('id').primaryKey(),
    /** `module` or `manual`, as the audit log names them. */
    subjectType: text('subject_type').notNull(),
    /** `<lang>/<moduleId>` for a module, the manual's ID for a manual. */
    subjectId: text('subject_id').notNull(),
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    holderKind: text('holder_kind').notNull(),
    holderId: text('holder_id').notNull(),
    since: timestamp('since', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'locks_subject',
      sql`(${t.subjectType} = 'module' and ${t.subjectId} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'manual' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'config' and ${t.subjectId} = 'ccms.yaml') or (${t.subjectType} = 'term' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'design' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'template' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*/([A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$')`,
    ),
    check('locks_subject_id', sql`char_length(${t.subjectId}) <= 200`),
    check('locks_holder_kind', sql`${t.holderKind} in ('user', 'service')`),
    check('locks_holder_id', sql`char_length(${t.holderId}) between 1 and 200`),
    // One lock per subject: the database decides who gets it.
    uniqueIndex('locks_subject_idx').on(t.subjectType, t.subjectId),
    // The list's filters, each with its order (newest first).
    index('locks_since_idx').on(t.since, t.id),
    index('locks_change_set_idx').on(t.changeSetId, t.since, t.id),
    index('locks_holder_idx').on(t.holderId, t.since, t.id),
  ],
);
