import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeSets } from './change-sets.tables.js';

/**
 * Working copies: the editor's autosaves of a module or manual in a change
 * set, one per change set and subject, never committed by themselves (a
 * save point commits them to Git). The subject's format is `locks`'s.
 */
export const workingCopies = pgTable(
  'working_copies',
  {
    changeSetId: uuid('change_set_id')
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    /** `module` or `manual`, as the audit log names them. */
    subjectType: text('subject_type').notNull(),
    /** `<lang>/<moduleId>` for a module, the manual's ID for a manual. */
    subjectId: text('subject_id').notNull(),
    /** The content model's schema version of `content` (`schemaVersion`). */
    schemaVersion: integer('schema_version').notNull(),
    /** The module's tree or the manual's manifest, as JSON. */
    content: jsonb('content').notNull(),
    /** The branch commit the first save started from. */
    baseCommit: text('base_commit').notNull(),
    /** 1 for the first save, one more for each after it. */
    version: integer('version').notNull(),
    updatedByKind: text('updated_by_kind').notNull(),
    updatedById: text('updated_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.changeSetId, t.subjectType, t.subjectId] }),
    check(
      'working_copies_subject',
      sql`(${t.subjectType} = 'module' and ${t.subjectId} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'manual' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'config' and ${t.subjectId} = 'ccms.yaml') or (${t.subjectType} = 'term' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'design' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (${t.subjectType} = 'template' and ${t.subjectId} ~ '^[a-z0-9]+(-[a-z0-9]+)*/([A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$')`,
    ),
    check('working_copies_subject_id', sql`char_length(${t.subjectId}) <= 200`),
    check('working_copies_schema_version', sql`${t.schemaVersion} >= 1`),
    check(
      'working_copies_content',
      sql`jsonb_typeof(${t.content}) = 'object' and (${t.content} ->> 'schemaVersion')::int = ${t.schemaVersion}`,
    ),
    // A backstop: the API keeps it to 512 KiB of JSON (`jsonb`'s text is
    // a little longer than JSON.stringify's).
    check(
      'working_copies_content_size',
      sql`octet_length(${t.content}::text) <= 2097152`,
    ),
    check(
      'working_copies_base_commit',
      sql`${t.baseCommit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check('working_copies_version', sql`${t.version} >= 1`),
    check(
      'working_copies_updated_by_kind',
      sql`${t.updatedByKind} in ('user', 'service')`,
    ),
    check(
      'working_copies_updated_by_id',
      sql`char_length(${t.updatedById}) between 1 and 200`,
    ),
  ],
);
