import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
 * Approvals of change sets in review (#21): who met which requirement
 * (`review`, or `sign-off/<module type>`) for which review head. One per
 * change set, requirement and approver; removed when the change set is
 * returned to draft (the audit log keeps every one). `self`: its author
 * gave it, as the installation's self-approval rule allowed (#588).
 */
export const changeSetApprovals = pgTable(
  'change_set_approvals',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    requirement: text('requirement').notNull(),
    approverKind: text('approver_kind').notNull(),
    approverId: text('approver_id').notNull(),
    head: text('head').notNull(),
    // Given by the change set's own author, as the self-approval rule allowed then (#588).
    self: boolean('self').notNull().default(false),
    approvedAt: timestamp('approved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('change_set_approvals_unique').on(
      t.changeSetId,
      t.requirement,
      t.approverKind,
      t.approverId,
    ),
    index('change_set_approvals_change_set_idx').on(t.changeSetId, t.id),
    check(
      'change_set_approvals_requirement',
      sql`${t.requirement} = 'review' or ${t.requirement} ~ '^sign-off/[a-z][a-z0-9-]{0,63}$'`,
    ),
    check(
      'change_set_approvals_approver_kind',
      sql`${t.approverKind} in ('user', 'service')`,
    ),
    check(
      'change_set_approvals_approver_id',
      sql`char_length(${t.approverId}) between 1 and 200`,
    ),
    check(
      'change_set_approvals_head',
      sql`${t.head} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
  ],
);
