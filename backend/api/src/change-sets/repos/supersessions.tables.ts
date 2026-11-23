import { index, pgTable, uuid } from 'drizzle-orm/pg-core';
import { changeSets } from './change-sets.tables.js';

/**
 * Which change set supersedes which (#471): one row per change set made
 * by moving another's own changes onto its rewritten base's current head.
 * Written in the transaction that records the new change set and closes
 * the old one; never changed after (trigger `change_set_supersessions_immutable`).
 */
export const changeSetSupersessions = pgTable(
  'change_set_supersessions',
  {
    /** The new change set (on the base's current head). */
    changeSetId: uuid('change_set_id')
      .primaryKey()
      .references(() => changeSets.id),
    /** The change set whose changes it holds. */
    supersededId: uuid('superseded_id')
      .notNull()
      .references(() => changeSets.id),
  },
  (t) => [index('change_set_supersessions_superseded_idx').on(t.supersededId)],
);
