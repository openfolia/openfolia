import { index, pgTable, uuid } from 'drizzle-orm/pg-core';
import { changeSets } from './change-sets.tables.js';

/**
 * Which change set carries which forward (#60): one row per change set
 * made by carrying another (merged into a maintenance line) to `main`.
 * Written in the transaction that records the new change set.
 */
export const changeSetCarryForwards = pgTable(
  'change_set_carry_forwards',
  {
    /** The new change set (on `main`). */
    changeSetId: uuid('change_set_id')
      .primaryKey()
      .references(() => changeSets.id),
    /** The change set it carries forward. */
    sourceId: uuid('source_id')
      .notNull()
      .references(() => changeSets.id),
  },
  (t) => [index('change_set_carry_forwards_source_idx').on(t.sourceId)],
);
