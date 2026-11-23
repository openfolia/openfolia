import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Postgres's 64-bit transaction ID (`xid8`), read and written as decimal
 * text: it does not wrap around, so it orders transactions for good.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * The outbox: events written in the same transaction as the change they
 * report, for consumers that act on them later (an index, webhooks), in
 * `id` order. One row per `topic` and `key`: a commit on a change-set
 * branch is `change-set.commit` with the commit ID as its key, so it is
 * recorded once however often recording it is tried. `delivered_at` is
 * unused: consumers keep their own cursors (`outbox_consumers`, #252).
 *
 * `tx_id` is the top-level transaction that wrote the row
 * (`pg_current_xact_id()`, since `0014_notifications`): consumers read in
 * `(tx_id, id)` order and only rows of transactions older than every one
 * still running, since an `id` is taken at insert time, not at commit, and
 * a cursor on `id` alone could step over a row committed late
 * (`OutboxFeed`, `src/outbox/`).
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    topic: text('topic').notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    txId: xid8('tx_id')
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    uniqueIndex('outbox_topic_key').on(t.topic, t.key),
    index('outbox_tx_id').on(t.txId, t.id),
    // The change feed's rows (#43, #558, `src/changes/`), read in the same order.
    index('outbox_change_feed')
      .on(t.txId, t.id)
      .where(
        sql`${t.topic} in ('release.published', 'release.withdrawn', 'module.deprecated', 'manual.deprecated')`,
      ),
    check(
      'outbox_topic',
      sql`${t.topic} ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$' and char_length(${t.topic}) <= 100`,
    ),
    check('outbox_key', sql`char_length(${t.key}) between 1 and 200`),
    check('outbox_payload', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);
