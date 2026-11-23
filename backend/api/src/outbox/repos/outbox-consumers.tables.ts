import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { xid8 } from '../../change-sets/repos/outbox.tables.js';

/**
 * Each outbox consumer's cursor (`OutboxFeed`): the last outbox row it
 * has recorded, as `(last_tx_id, last_outbox_id)`, the order it reads in.
 * One row per consumer (`notifications`, `webhooks`), made on its first
 * read at the start of the outbox; the change feed's (`change-feed`) holds
 * only its `blocked` latch, as its readers keep their own positions.
 *
 * `blocked` (#619, migration `0053_outbox_restore`): set once the cursor,
 * or an outbox row, was found past every transaction this database has
 * handed out (restored from another server, whose count they carry). The
 * consumer reads nothing until the operator's recipe (README, "Outbox",
 * "After a restore") renumbers the rows and clears it.
 */
export const outboxConsumers = pgTable(
  'outbox_consumers',
  {
    name: text('name').primaryKey(),
    lastTxId: xid8('last_tx_id')
      .notNull()
      .default(sql`'0'::xid8`),
    lastOutboxId: bigint('last_outbox_id', { mode: 'number' })
      .notNull()
      .default(0),
    blocked: boolean('blocked').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'outbox_consumers_name',
      sql`${t.name} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.name}) <= 100`,
    ),
    check('outbox_consumers_last_outbox_id', sql`${t.lastOutboxId} >= 0`),
  ],
);
