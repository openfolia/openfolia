import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Translation jobs (#50): one row per delta export sent to a provider.
 * The XLIFF files are not stored: they are made again from `commit` and
 * the job's units. The formats are `core/translation-job.ts`'s, held here
 * too.
 */
export const translationJobs = pgTable(
  'translation_jobs',
  {
    /** A UUID version 7, made by the server (its time leads). */
    id: uuid('id').primaryKey(),
    /** The source language, as configured at the export. */
    sourceLang: text('source_lang').notNull(),
    /** The target languages, in the configured order. */
    languages: text('languages').array().notNull(),
    /** What was exported (`ExportSubject`). */
    subject: jsonb('subject').notNull(),
    ref: text('ref').notNull(),
    commit: text('commit').notNull(),
    /** Whether `commit` was released content when it was exported. */
    released: boolean('released').notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    state: text('state').notNull(),
    createdByKind: text('created_by_kind').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'translation_jobs_languages',
      sql`cardinality(${t.languages}) between 1 and 100`,
    ),
    check('translation_jobs_ref', sql`char_length(${t.ref}) between 1 and 256`),
    check(
      'translation_jobs_commit',
      sql`${t.commit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'translation_jobs_state',
      sql`${t.state} in ('sent', 'returned', 'cancelled')`,
    ),
    check(
      'translation_jobs_created_by_kind',
      sql`${t.createdByKind} in ('user', 'service')`,
    ),
    check(
      'translation_jobs_created_by_id',
      sql`char_length(${t.createdById}) between 1 and 200`,
    ),
    // The list, newest first.
    index('translation_jobs_created_idx').on(t.createdAt, t.id),
  ],
);

/**
 * The units of a job: one block of one module in one target language,
 * with the source hash it was exported with. `open` while the job is
 * `sent`: a unit is open in at most one job (the partial unique index), so
 * two exports at once never both send it.
 */
export const translationJobUnits = pgTable(
  'translation_job_units',
  {
    jobId: uuid('job_id').notNull(),
    lang: text('lang').notNull(),
    moduleId: text('module_id').notNull(),
    blockId: text('block_id').notNull(),
    /** Its place in the export, so a file lists modules as they were found. */
    position: integer('position').notNull(),
    sourceHash: text('source_hash').notNull(),
    words: integer('words').notNull(),
    open: boolean('open').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.lang, t.moduleId, t.blockId] }),
    foreignKey({
      columns: [t.jobId],
      foreignColumns: [translationJobs.id],
      name: 'translation_job_units_job_fk',
    }).onDelete('cascade'),
    check(
      'translation_job_units_source_hash',
      sql`${t.sourceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('translation_job_units_words', sql`${t.words} >= 0`),
    check('translation_job_units_position', sql`${t.position} >= 0`),
    uniqueIndex('translation_job_units_open_idx')
      .on(t.lang, t.moduleId, t.blockId)
      .where(sql`${t.open}`),
  ],
);
