import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The backup settings (#529): one row (`id` 1), made by the first change in
 * Admin → Backups; until then the defaults hold. `frequency`, `retention`
 * and `location` are JSON as `core/backup-settings.ts` describes them; the
 * location never holds the S3 secret key, which is `s3_secret_sealed`
 * (sealed under the instance secret key, write-only).
 */
export const backupSettings = pgTable(
  'backup_settings',
  {
    id: smallint('id').primaryKey(),
    enabled: boolean('enabled').notNull(),
    frequency: jsonb('frequency').notNull(),
    time: text('time').notNull(),
    timeZone: text('time_zone').notNull(),
    retention: jsonb('retention').notNull(),
    location: jsonb('location').notNull(),
    s3SecretSealed: text('s3_secret_sealed'),
    verify: boolean('verify').notNull(),
    verifyByDecrypting: boolean('verify_by_decrypting').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('backup_settings_one_row', sql`${t.id} = 1`),
    check(
      'backup_settings_time',
      sql`${t.time} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      'backup_settings_json',
      sql`jsonb_typeof(${t.frequency}) = 'object' and jsonb_typeof(${t.retention}) = 'object' and jsonb_typeof(${t.location}) = 'object'`,
    ),
  ],
);

/**
 * The backup keys: the age recipient each backup is encrypted to, the
 * identity sealed only while the server verifies by decrypting. One is
 * current (`retired_at` null); a rotation retires it and keeps its
 * fingerprint, so the history says which key each backup used.
 */
export const backupKeys = pgTable(
  'backup_keys',
  {
    id: uuid('id').primaryKey(),
    recipient: text('recipient').notNull(),
    fingerprint: text('fingerprint').notNull(),
    identitySealed: text('identity_sealed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('backup_keys_current')
      .on(sql`(true)`)
      .where(sql`${t.retiredAt} is null`),
    check('backup_keys_recipient', sql`${t.recipient} ~ '^age1[0-9a-z]{58}$'`),
    check(
      'backup_keys_fingerprint',
      sql`${t.fingerprint} ~ '^[0-9a-f]{4}(-[0-9a-f]{4}){3}$'`,
    ),
  ],
);

/** The backup runs, the history Admin → Backups shows. */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    location: text('location'),
    name: text('name'),
    keyFingerprint: text('key_fingerprint'),
    verified: boolean('verified'),
    verifyMode: text('verify_mode'),
    error: text('error'),
    errorDetail: text('error_detail'),
    processId: text('process_id').notNull(),
    requestId: uuid('request_id'),
  },
  (t) => [
    index('backup_runs_started').on(t.startedAt.desc(), t.id),
    index('backup_runs_scheduled').on(t.scheduledFor.desc()),
    check(
      'backup_runs_states',
      sql`${t.trigger} in ('schedule', 'manual', 'command') and ${t.status} in ('running', 'succeeded', 'failed') and (${t.verifyMode} is null or ${t.verifyMode} in ('decrypted', 'before-encryption'))`,
    ),
    check(
      'backup_runs_sha256',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'backup_runs_size',
      sql`${t.sizeBytes} is null or ${t.sizeBytes} >= 0`,
    ),
  ],
);

/** What the page asked the backup process to do. */
export const backupRequests = pgTable(
  'backup_requests',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    requestedByKind: text('requested_by_kind').notNull(),
    requestedById: text('requested_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    runId: uuid('run_id'),
    error: text('error'),
    errorDetail: text('error_detail'),
  },
  (t) => [
    index('backup_requests_pending')
      .on(t.createdAt)
      .where(sql`${t.status} in ('pending', 'running')`),
    check(
      'backup_requests_states',
      sql`${t.kind} in ('run', 'test-location') and ${t.status} in ('pending', 'running', 'done', 'failed') and ${t.requestedByKind} in ('user', 'service')`,
    ),
  ],
);

/**
 * The backup process's heartbeat (one row): when it last ran a pass, what
 * its environment fixes (`overrides`: per setting the variable and its
 * value, never a secret) and the fingerprint of a key it reads from a file.
 */
export const backupService = pgTable(
  'backup_service',
  {
    id: smallint('id').primaryKey(),
    processId: text('process_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    overrides: jsonb('overrides').notNull(),
    keyFingerprint: text('key_fingerprint'),
  },
  (t) => [
    check('backup_service_one_row', sql`${t.id} = 1`),
    check(
      'backup_service_overrides',
      sql`jsonb_typeof(${t.overrides}) = 'object'`,
    ),
  ],
);
