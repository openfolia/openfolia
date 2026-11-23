import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { StoredHeader } from '../core/webhook-headers.js';

/**
 * A custom header (#457) as the `headers` column holds it: `secret` false
 * with its `value`, or true with its value `sealed` (`SecretSealer`, bound
 * to the subscriber and the header's name), never the value itself.
 */
export type StoredHeaderJson =
  | { readonly name: string; readonly secret: false; readonly value: string }
  | { readonly name: string; readonly secret: true; readonly sealed: string };

/** The column's JSON for these headers. */
export const toStoredJson = (
  headers: readonly StoredHeader[],
): StoredHeaderJson[] =>
  headers.map((h) =>
    'sealed' in h
      ? { name: h.name, secret: true, sealed: h.sealed }
      : { name: h.name, secret: false, value: h.value },
  );

/** The headers the column holds; an element of another shape is left out (never written so). */
export function storedHeadersOf(json: unknown): StoredHeader[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((h: unknown): StoredHeader[] => {
    if (typeof h !== 'object' || h === null) return [];
    const { name, secret, value, sealed } = h as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    if (secret === true && typeof sealed === 'string')
      return [{ name, sealed }];
    if (secret === false && typeof value === 'string') return [{ name, value }];
    return [];
  });
}

/**
 * Webhook subscribers (#42). `secret_sealed` is the secret encrypted
 * under the instance secret key (`SecretSealer`, AES-256-GCM), never
 * the secret; `previous_secret_sealed` the one before the last rotation,
 * which signs beside it until `previous_secret_until`. `owner_*` is who
 * made it: it hears only of what they may read. `active` false: paused,
 * or disabled after failing (`disabled_reason`).
 */
export const webhooks = pgTable(
  'webhooks',
  {
    /** A UUID version 7, made by the server. */
    id: uuid('id').primaryKey(),
    url: text('url').notNull(),
    description: text('description'),
    events: text('events').array().notNull(),
    /** The most restricted audience level it hears of (#254); null: what its owner reads. */
    maxAudience: text('max_audience'),
    secretSealed: text('secret_sealed').notNull(),
    previousSecretSealed: text('previous_secret_sealed'),
    previousSecretUntil: timestamp('previous_secret_until', {
      withTimezone: true,
    }),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    active: boolean('active').notNull().default(true),
    disabledReason: text('disabled_reason'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Attempts in a row that failed at the receiver: how long the next waits. */
    attemptFailures: integer('attempt_failures').notNull().default(0),
    /** Until when the one attempt in flight to it holds its claim. */
    sendingUntil: timestamp('sending_until', { withTimezone: true }),
    /** No attempt before this (a wait after a failed one). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    /** Its custom headers (#457), in order: `StoredHeaderJson`, secret values sealed. */
    headers: jsonb('headers')
      .$type<StoredHeaderJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'webhooks_url',
      sql`char_length(${t.url}) between 1 and 2000 and ${t.url} ~ '^https?://'`,
    ),
    check(
      'webhooks_description',
      sql`${t.description} is null or char_length(${t.description}) between 1 and 500`,
    ),
    check(
      'webhooks_events',
      sql`cardinality(${t.events}) between 1 and 20 and ${t.events} <@ array['manual.released', 'module.released', 'module.deprecated', 'manual.deprecated', 'release.withdrawn', 'translation.imported']::text[]`,
    ),
    check(
      'webhooks_max_audience',
      sql`${t.maxAudience} is null or ${t.maxAudience} ~ '^[a-z][a-z0-9-]{0,63}$'`,
    ),
    check(
      'webhooks_secrets',
      sql`char_length(${t.secretSealed}) between 1 and 1000 and (${t.previousSecretSealed} is null) = (${t.previousSecretUntil} is null)`,
    ),
    check(
      'webhooks_disabled',
      sql`(${t.disabledReason} is null or ${t.disabledReason} = 'failing') and (${t.disabledReason} is null or not ${t.active}) and (${t.disabledReason} is null) = (${t.disabledAt} is null)`,
    ),
    check(
      'webhooks_failures',
      sql`${t.consecutiveFailures} >= 0 and ${t.attemptFailures} >= 0`,
    ),
    check('webhooks_owner_kind', sql`${t.ownerKind} in ('user', 'service')`),
    check(
      'webhooks_headers',
      sql`jsonb_typeof(${t.headers}) = 'array' and jsonb_array_length(${t.headers}) <= 20 and octet_length(${t.headers}::text) <= 65536`,
    ),
    check(
      'webhooks_owner_id',
      sql`char_length(${t.ownerId}) between 1 and 200`,
    ),
    index('webhooks_created').on(t.createdAt, t.id),
  ],
);

/**
 * One delivery of one event to one subscriber (#42), with its attempts
 * so far. Unique per subscriber and idempotency key, so the same event
 * read again from the outbox is never delivered twice. `body` is the JSON
 * sent, the same on every attempt; `last_error` a code
 * (`DELIVERY_ERRORS`), never the receiver's text. Deleted with its
 * subscriber. A test event (`ping`, #254) has no outbox row.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    /** A UUID version 7, made by the server. */
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    body: text('body').notNull(),
    /** The subscriber's owner the body was built for (its reading scope). */
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    /** The subscriber's audience limit the body was built under (#254). */
    maxAudience: text('max_audience'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Times an attempt was put off (`deferrals` of its job): guards the job chain. */
    deferrals: integer('deferrals').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** The names of the headers the last attempt sent (#457), never a value; null before one sent anything. */
    sentHeaders: text('sent_headers').array(),
    /** The outbox row it was made from; null for a test event (`ping`, #254). */
    outboxId: bigint('outbox_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_key').on(t.webhookId, t.idempotencyKey),
    index('webhook_deliveries_log').on(
      t.webhookId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('webhook_deliveries_settled')
      .on(t.createdAt)
      .where(sql`${t.status} <> 'pending'`),
    check(
      'webhook_deliveries_event',
      sql`${t.event} in ('manual.released', 'module.released', 'module.deprecated', 'manual.deprecated', 'release.withdrawn', 'translation.imported', 'ping')`,
    ),
    check(
      'webhook_deliveries_max_audience',
      sql`${t.maxAudience} is null or ${t.maxAudience} ~ '^[a-z][a-z0-9-]{0,63}$'`,
    ),
    check(
      'webhook_deliveries_outbox',
      sql`(${t.event} = 'ping') = (${t.outboxId} is null)`,
    ),
    check(
      'webhook_deliveries_status',
      sql`${t.status} in ('pending', 'succeeded', 'failed', 'skipped') and (${t.status} = 'succeeded') = (${t.deliveredAt} is not null)`,
    ),
    check(
      'webhook_deliveries_key_format',
      sql`${t.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'webhook_deliveries_body',
      sql`char_length(${t.body}) between 2 and 65536`,
    ),
    check(
      'webhook_deliveries_owner_kind',
      sql`${t.ownerKind} in ('user', 'service')`,
    ),
    check(
      'webhook_deliveries_attempts',
      sql`${t.attempts} >= 0 and ${t.deferrals} >= 0`,
    ),
    check(
      'webhook_deliveries_error',
      sql`${t.lastError} is null or ${t.lastError} in ('http-status', 'timeout', 'connection', 'blocked-address', 'blocked-url', 'secret-unreadable')`,
    ),
    check(
      'webhook_deliveries_status_code',
      sql`${t.lastStatusCode} is null or ${t.lastStatusCode} between 100 and 599`,
    ),
  ],
);
