import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { xid8 } from '../../change-sets/repos/outbox.tables.js';

/**
 * The audit log: one row per recorded event, append-only. The migration
 * that creates it (`0002_audit_events`) also adds a trigger refusing
 * UPDATE, DELETE and TRUNCATE, so no code path, buggy or not, rewrites
 * history (only the table's owner could drop the trigger: a deployment
 * that runs the API as a role without ownership closes that too). Since
 * `0050_audit_sink_retention` one way removes rows: the
 * `audit_events_prune` function (retention, SECURITY DEFINER), which
 * records each removal itself; every other DELETE is still refused.
 * No foreign keys: an event outlives the user or role it names.
 * The formats are `core/audit-event.ts`'s, held here too.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    /** Increasing in the order events were inserted; the list's order. */
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    /** When the recording transaction started (its changes' time). */
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    comment: text('comment'),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * The top-level transaction that recorded it, for the sink's order
     * (`(tx_id, id)`, `AuditSinkCursor`); rows from before the column was
     * added carry the migration's own.
     */
    txId: xid8('tx_id')
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    check(
      'audit_events_actor_kind',
      sql`${t.actorKind} in ('user', 'service')`,
    ),
    check(
      'audit_events_actor_id',
      sql`char_length(${t.actorId}) between 1 and 200`,
    ),
    check(
      'audit_events_action_format',
      sql`char_length(${t.action}) <= 100 and ${t.action} ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$'`,
    ),
    check(
      'audit_events_subject_type_format',
      sql`char_length(${t.subjectType}) <= 64 and ${t.subjectType} ~ '^[a-z][a-z0-9-]*$'`,
    ),
    check(
      'audit_events_subject_id',
      sql`char_length(${t.subjectId}) between 1 and 500`,
    ),
    check(
      'audit_events_comment',
      sql`${t.comment} is null or char_length(${t.comment}) between 1 and 10000`,
    ),
    check('audit_events_data_object', sql`jsonb_typeof(${t.data}) = 'object'`),
    // The filters, each with the order (newest first).
    index('audit_events_subject_idx').on(t.subjectType, t.subjectId, t.id),
    index('audit_events_actor_idx').on(t.actorKind, t.actorId, t.id),
    index('audit_events_action_idx').on(t.action, t.id),
    // The sink's order, and retention's (and the date filters').
    index('audit_events_tx_id_idx').on(t.txId, t.id),
    index('audit_events_at_idx').on(t.at),
  ],
);

/** The one row of `audit_sink`. */
export const AUDIT_SINK_ROW = 'sink';

/**
 * The sink's cursor (#379): the last event delivered, as
 * `(last_tx_id, last_id)`, and the lease of the server sending
 * (`claimed_by` until `claimed_until`). One row (`AUDIT_SINK_ROW`), made
 * at the start of the log on the first pass.
 */
export const auditSink = pgTable(
  'audit_sink',
  {
    name: text('name').primaryKey(),
    lastTxId: xid8('last_tx_id')
      .notNull()
      .default(sql`'0'::xid8`),
    lastId: bigint('last_id', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    claimedBy: text('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    /**
     * Set once the cursor or the events were found ahead of this database's
     * transactions (a restore from another server), and kept until the
     * operator's recipe clears it (backend/api/README.md, "After a
     * restore"): the sink sends nothing and retention removes nothing.
     */
    blocked: boolean('blocked').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('audit_sink_name', sql`${t.name} = 'sink'`),
    check('audit_sink_last_id', sql`${t.lastId} >= 0`),
    check(
      'audit_sink_claimed_by',
      sql`${t.claimedBy} is null or char_length(${t.claimedBy}) between 1 and 200`,
    ),
  ],
);
