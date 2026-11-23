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
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from '../../change-sets/repos/change-sets.tables.js';

/**
 * Imports (#256): an uploaded bundle checked against a branch, with its
 * report, kept for an hour so it can be applied, and while its job writes
 * it into a change set. The upload's bytes are in the blob store under
 * `upload_sha256`. The formats are `core/import.ts`'s, held here too.
 */
export const imports = pgTable(
  'imports',
  {
    /** A UUID version 7, made by the server. */
    id: uuid('id').primaryKey(),
    importerId: text('importer_id').notNull(),
    /** The importer's options, as checked. */
    options: jsonb('options').notNull(),
    updateExisting: boolean('update_existing').notNull(),
    baseRef: text('base_ref').notNull(),
    baseCommit: text('base_commit').notNull(),
    createdByKind: text('created_by_kind').notNull(),
    createdById: text('created_by_id').notNull(),
    fileName: text('file_name'),
    uploadSha256: text('upload_sha256').notNull(),
    uploadSize: bigint('upload_size', { mode: 'number' }).notNull(),
    /** This import stored the bytes, so it removes them when it goes (unless something else names them). */
    uploadCreated: boolean('upload_created').notNull(),
    state: text('state').notNull(),
    /** `ImportReport`. */
    report: jsonb('report').notNull(),
    changeSetId: uuid('change_set_id').references(() => changeSets.id),
    /** `ImportProgress`. */
    progress: jsonb('progress').notNull(),
    /** `ImportFailure`, once failed. */
    failure: jsonb('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'imports_importer_id',
      sql`${t.importerId} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.importerId}) <= 64`,
    ),
    check(
      'imports_base_ref',
      sql`char_length(${t.baseRef}) between 1 and 256 and ${t.baseRef} not like 'change-sets/%'`,
    ),
    check(
      'imports_base_commit',
      sql`${t.baseCommit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'imports_created_by_kind',
      sql`${t.createdByKind} in ('user', 'service')`,
    ),
    check(
      'imports_created_by_id',
      sql`char_length(${t.createdById}) between 1 and 200`,
    ),
    check(
      'imports_file_name',
      sql`${t.fileName} is null or char_length(${t.fileName}) between 1 and 255`,
    ),
    check('imports_upload_sha256', sql`${t.uploadSha256} ~ '^[0-9a-f]{64}$'`),
    check('imports_upload_size', sql`${t.uploadSize} >= 0`),
    check(
      'imports_state',
      sql`${t.state} in ('validated', 'applying', 'applied', 'failed')`,
    ),
    check(
      'imports_failure',
      sql`(${t.state} = 'failed') = (${t.failure} is not null)`,
    ),
    // The sweep: expired imports, oldest first.
    index('imports_expires_idx').on(t.expiresAt),
    // Who else names an upload's bytes.
    index('imports_upload_idx').on(t.uploadSha256),
  ],
);
