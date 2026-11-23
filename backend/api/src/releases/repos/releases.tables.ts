import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Releases (#40): one row per release tag, next to it. Git holds the tag
 * (the release itself); this row makes releases listable and names the
 * product, revision, who and when. Reserved first (`tag_object` null),
 * published once the tag is made; then never changed or deleted, which
 * the database holds too (a trigger, migration `0017_releases`). The
 * formats are `core/release.ts`'s, held here too.
 */
export const releases = pgTable(
  'releases',
  {
    /** A UUID version 7, made by the server (its time leads). */
    id: uuid('id').primaryKey(),
    /** A value of `product_facet`, as configured at the release. */
    product: text('product').notNull(),
    productFacet: text('product_facet').notNull(),
    revision: text('revision').notNull(),
    /** The tag's name, without `refs/tags/`. */
    tag: text('tag').notNull(),
    /** The annotated tag object; null while only reserved. */
    tagObject: text('tag_object'),
    commit: text('commit').notNull(),
    notes: text('notes'),
    /** Notes per language (#138): language tag → text; `{}` for none. */
    notesByLanguage: jsonb('notes_by_language')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** Marked a major change by its publisher (#138). */
    major: boolean('major').notNull().default(false),
    publishedByKind: text('published_by_kind').notNull(),
    publishedById: text('published_by_id').notNull(),
    /** The tagger date. */
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'releases_product',
      sql`${t.product} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.product}) <= 64`,
    ),
    check(
      'releases_product_facet',
      sql`${t.productFacet} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.productFacet}) <= 64`,
    ),
    check(
      'releases_revision',
      sql`${t.revision} ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$' and ${t.revision} not like '%..%' and ${t.revision} not like '%.' and ${t.revision} not like '%.lock'`,
    ),
    check(
      'releases_tag',
      sql`char_length(${t.tag}) between 1 and 256 and ${t.tag} !~ '^refs/'`,
    ),
    check(
      'releases_tag_object',
      sql`${t.tagObject} is null or ${t.tagObject} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'releases_commit',
      sql`${t.commit} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      'releases_notes',
      sql`${t.notes} is null or char_length(${t.notes}) between 1 and 10000`,
    ),
    check(
      'releases_notes_by_language',
      sql`jsonb_typeof(${t.notesByLanguage}) = 'object'`,
    ),
    check(
      'releases_published_by_kind',
      sql`${t.publishedByKind} in ('user', 'service')`,
    ),
    check(
      'releases_published_by_id',
      sql`char_length(${t.publishedById}) between 1 and 200`,
    ),
    // A release is never re-created under the same name: neither its
    // product and revision nor its tag (in any case, as Git on a
    // case-insensitive file system would see it).
    uniqueIndex('releases_name_idx').on(t.product, t.revision),
    uniqueIndex('releases_tag_idx').on(sql`lower(${t.tag})`),
    // The list, newest first, and its product filter.
    index('releases_published_idx').on(t.publishedAt, t.id),
    index('releases_product_idx').on(t.product, t.publishedAt, t.id),
  ],
);

/**
 * Withdrawn releases (#138): one row per release taken back, with who,
 * when and why. Its own table, so the release row stays immutable; the tag
 * stays too. Never changed or deleted once written (a trigger, migration
 * `0023_release_notes`): a withdrawal is told to subscribers (the outbox's
 * `release.withdrawn`) and cannot be called back.
 */
export const releaseWithdrawals = pgTable(
  'release_withdrawals',
  {
    releaseId: uuid('release_id')
      .primaryKey()
      .references(() => releases.id),
    withdrawnByKind: text('withdrawn_by_kind').notNull(),
    withdrawnById: text('withdrawn_by_id').notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [
    check(
      'release_withdrawals_by_kind',
      sql`${t.withdrawnByKind} in ('user', 'service')`,
    ),
    check(
      'release_withdrawals_by_id',
      sql`char_length(${t.withdrawnById}) between 1 and 200`,
    ),
    check(
      'release_withdrawals_reason',
      sql`char_length(${t.reason}) between 1 and 2000`,
    ),
  ],
);

/**
 * The outputs of releases (#249): one row per release, kind, manual,
 * variant and language. A PDF rendered at the release's tag (as the
 * manual's audience reads it) lives in the blob store under `sha256`; a
 * manual the release did not change points at the previous release's file
 * (`reused_from_*`). The state moves by compare-and-swap
 * (`DrizzleReleaseOutputStore`): `queued`, `rendering`, `done` or
 * `failed`, never out of `done`.
 */
export const releaseOutputs = pgTable(
  'release_outputs',
  {
    /** A UUID version 7, made by the server. */
    id: uuid('id').primaryKey(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    kind: text('kind').notNull(),
    manualId: text('manual_id').notNull(),
    /** The variant's slug, e.g. `model=large`. */
    variant: text('variant').notNull(),
    lang: text('lang').notNull(),
    /** The manual's audience at the tag; null for none (the most restricted level). */
    audience: text('audience'),
    state: text('state').notNull(),
    /** The file in the blob store; null until done. */
    sha256: text('sha256'),
    size: bigint('size', { mode: 'number' }),
    /** Why it failed (or the latest attempt did): a stable code and a text for its readers. */
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    /** The output whose file this one reuses; null when rendered for this release. */
    reusedFromRelease: uuid('reused_from_release'),
    reusedFromOutput: uuid('reused_from_output'),
    /** Render attempts started. */
    attempts: integer('attempts').notNull().default(0),
    /** Times queued again after failing (`POST …/retry`). */
    retries: integer('retries').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * When its render job was queued (#497): a release keeps only a few at
     * a time; null while it waits for one of them to end.
     */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /**
     * Outputs of the same inputs (#497): the same manual, variant and
     * language in releases that changed nothing it shows. One rendered file
     * serves them all. Its first output's ID; null for rows from before.
     */
    reuseGroup: uuid('reuse_group'),
    /** When a reader's request for its file moved it up the queue (#497); null otherwise. */
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    /**
     * The QR code the file prints (#450), `{ url, placement }`; null for none. Outputs are
     * reused only between those that print the same.
     */
    qrCode: jsonb('qr_code').$type<{
      url: string;
      placement: 'title-page' | 'back-cover';
    }>(),
  },
  (t) => [
    // A manual's PDF (#249) or an offline package (#59).
    check('release_outputs_kind', sql`${t.kind} in ('pdf', 'offline-package')`),
    check(
      'release_outputs_state',
      sql`${t.state} in ('queued', 'rendering', 'done', 'failed')`,
    ),
    check(
      'release_outputs_manual_id',
      sql`char_length(${t.manualId}) between 1 and 200`,
    ),
    check(
      'release_outputs_variant',
      sql`char_length(${t.variant}) between 1 and 1000`,
    ),
    check('release_outputs_lang', sql`char_length(${t.lang}) between 1 and 35`),
    check(
      'release_outputs_audience',
      sql`${t.audience} is null or char_length(${t.audience}) between 1 and 64`,
    ),
    // A done output has its file; no other one claims to.
    check(
      'release_outputs_file',
      sql`(${t.state} = 'done') = (${t.sha256} is not null and ${t.size} is not null)`,
    ),
    check(
      'release_outputs_sha256',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('release_outputs_size', sql`${t.size} is null or ${t.size} >= 0`),
    check(
      'release_outputs_error',
      sql`(${t.errorCode} is null) = (${t.errorDetail} is null) and (${t.errorDetail} is null or char_length(${t.errorDetail}) <= 1000) and (${t.errorCode} is null or char_length(${t.errorCode}) between 1 and 100)`,
    ),
    check(
      'release_outputs_reused_from',
      sql`(${t.reusedFromRelease} is null) = (${t.reusedFromOutput} is null)`,
    ),
    check(
      'release_outputs_counts',
      sql`${t.attempts} >= 0 and ${t.retries} >= 0`,
    ),
    // One output per release, kind, manual, variant and language; also the list's order.
    uniqueIndex('release_outputs_subject_idx').on(
      t.releaseId,
      t.manualId,
      t.variant,
      t.lang,
      t.kind,
    ),
    // What is still to render, per release: scheduling and the queue's position.
    index('release_outputs_pending_idx')
      .on(t.releaseId)
      .where(sql`${t.state} in ('queued', 'rendering')`),
    index('release_outputs_reuse_group_idx')
      .on(t.reuseGroup)
      .where(sql`${t.reuseGroup} is not null`),
  ],
);

/**
 * Refused plannings of release outputs (#477): one row per release whose
 * outputs were not planned, why (`too-many-outputs`), how many it would
 * have and the limit then. Kept so the planning job does not try (and log)
 * it again at every start; deleted in the transaction that plans its
 * first outputs, once the limit is raised.
 */
export const releaseOutputRefusals = pgTable(
  'release_output_refusals',
  {
    releaseId: uuid('release_id')
      .primaryKey()
      .references(() => releases.id),
    reason: text('reason').notNull(),
    wanted: integer('wanted').notNull(),
    max: integer('max').notNull(),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'release_output_refusals_reason',
      sql`${t.reason} in ('too-many-outputs')`,
    ),
    check(
      'release_output_refusals_counts',
      sql`${t.wanted} >= 0 and ${t.max} >= 0`,
    ),
  ],
);

/**
 * The releases whose planning ran to its end (#527, `ReleaseOutputStore.markPlanned`): every
 * output row written and its first render jobs queued. A release planned in another release's
 * turn (planned strictly in the order cut) is not planned again by its own job, and its
 * progress no longer waits for that job. Only added to; a release planned again keeps its row.
 */
export const releasePlannings = pgTable('release_plannings', {
  releaseId: uuid('release_id')
    .primaryKey()
    .references(() => releases.id),
  plannedAt: timestamp('planned_at', { withTimezone: true }).notNull(),
});

/**
 * Where the stalled-outputs sweep (#497, `SweepReleaseOutputsAction`)
 * stopped, in one row (`id` 1): each sweep, on whichever server, goes on
 * after the last one's (#527: several workers share it, and a restart
 * keeps it). Moved by compare-and-swap on `version`, so two servers
 * sweeping at once never both take the same window.
 */
export const releaseOutputSweeps = pgTable(
  'release_output_sweeps',
  {
    id: smallint('id').primaryKey(),
    /** The last release ID the previous sweep looked at; null: start from the first. */
    after: uuid('after'),
    version: integer('version').notNull(),
    sweptAt: timestamp('swept_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('release_output_sweeps_one_row', sql`${t.id} = 1`),
    check('release_output_sweeps_version', sql`${t.version} >= 0`),
  ],
);
