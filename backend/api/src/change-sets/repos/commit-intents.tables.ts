import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from './change-sets.tables.js';

/**
 * Commit intents (#154): what a save point is about to commit, written and
 * committed in a transaction of its own before the Git write: the change
 * set, the actor, the branch head it commits on (`parent`) and the tree it
 * commits. Recovery after a crash between Git and the database records
 * only a commit whose first parent and tree match an intent, as that
 * intent's actor, never from what a commit says about itself (trailers,
 * author). Consumed (deleted) when its commit is recorded; one whose
 * commit never landed expires.
 */
export const commitIntents = pgTable(
  'commit_intents',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    /** The branch head the commit is made on. */
    parent: text('parent').notNull(),
    /** The tree the commit has. */
    tree: text('tree').notNull(),
    /**
     * `{ written, deleted, consumes, message? }`: the subjects (as the
     * audit log names them), the working copies it commits at their
     * versions, and the client's message.
     */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('commit_intents_change_set_idx').on(t.changeSetId, t.parent, t.tree),
    index('commit_intents_created_idx').on(t.createdAt),
    check(
      'commit_intents_actor_kind',
      sql`${t.actorKind} in ('user', 'service')`,
    ),
    check(
      'commit_intents_actor_id',
      sql`char_length(${t.actorId}) between 1 and 200`,
    ),
    check(
      'commit_intents_parent',
      sql`${t.parent} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'commit_intents_tree',
      sql`${t.tree} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check('commit_intents_payload', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);
