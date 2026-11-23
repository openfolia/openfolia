import type { Deprecation } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The module index (#45): per commit, its module files and manifests with
 * what lists filter and sort by and what includes what. A rebuildable
 * index: derived from Git alone, dropped and built again with the same
 * result (`pnpm nx run api:index-rebuild`); who may see what is decided
 * when it is read, never stored. A commit's rows are written once, in the
 * transaction that adds its `module_index_commits` row.
 */
export const moduleIndexCommits = pgTable(
  'module_index_commits',
  {
    /** A full commit ID (40 or 64 lowercase hex characters). */
    commit: text('commit').primaryKey(),
    builtAt: timestamp('built_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * What the rows hold (`INDEX_FORMAT`, #480): an index written in another
     * format (by a server of another version) is built again, never read or
     * carried over. 0: before formats were counted.
     */
    format: integer('format').notNull().default(0),
  },
  (t) => [
    check(
      'module_index_commits_commit',
      sql`${t.commit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    // The oldest are dropped first.
    index('module_index_commits_built_at_idx').on(t.builtAt),
  ],
);

/** One module file at an indexed commit. */
export const moduleIndexModules = pgTable(
  'module_index_modules',
  {
    commit: text('commit').notNull(),
    moduleId: text('module_id').notNull(),
    lang: text('lang').notNull(),
    /** Null for a file that cannot be read (`error`), as are the type and facets. */
    title: text('title'),
    moduleType: text('module_type'),
    audience: text('audience'),
    facets: jsonb('facets').$type<Record<string, string[]>>(),
    keywords: jsonb('keywords').$type<string[]>(),
    /** Withdrawn or superseded (#266); null when it is not (or the file cannot be read). */
    deprecated: jsonb('deprecated').$type<Deprecation>(),
    /** The module IDs its module reference blocks name, in document order. */
    refs: jsonb('refs').$type<string[]>().notNull(),
    /** The variant attributes its variant blocks name, each with the values named (#91). */
    variants: jsonb('variants')
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    /** The term IDs its term links name (#245), each once, in document order. */
    terms: jsonb('terms').$type<string[]>().notNull().default([]),
    /** SHA-256 of the parsed module's JSON (#480): equal digests, equal modules. Null for a file that cannot be read. */
    digest: text('digest'),
    /** A source-language file's translatable units, by block ID in document order (#480). */
    units: jsonb('units').$type<string[]>().notNull().default([]),
    /** A translation with a readable record, compared with the source at this commit (#480); null otherwise. */
    translation: jsonb('translation').$type<{
      outdated: string[];
      sourceCommit: string;
    }>(),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.commit, t.moduleId, t.lang] }),
    foreignKey({
      columns: [t.commit],
      foreignColumns: [moduleIndexCommits.commit],
    }).onDelete('cascade'),
    check(
      'module_index_modules_readable',
      sql`(${t.error} is null) = (${t.title} is not null and ${t.moduleType} is not null and ${t.facets} is not null)`,
    ),
  ],
);

/** One manifest at an indexed commit. */
export const moduleIndexManuals = pgTable(
  'module_index_manuals',
  {
    commit: text('commit').notNull(),
    manualId: text('manual_id').notNull(),
    /** Null for a manifest that cannot be read (`error`). */
    title: text('title'),
    audience: text('audience'),
    /** Withdrawn or superseded (#266); null when it is not. */
    deprecated: jsonb('deprecated').$type<Deprecation>(),
    /** The module IDs its entries name (groups flattened), in order. */
    modules: jsonb('modules').$type<string[]>().notNull(),
    /** The variant attributes any reader of it may see it name (combinations, text attributes' conditions), each with the values named (#91). */
    variants: jsonb('variants')
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    /** Its entries' conditions' names, each with the module IDs the entry covers: shown only where a covered module is (#91). */
    entryVariants: jsonb('entry_variants')
      .$type<{ modules: string[]; names: Record<string, string[]> }[]>()
      .notNull()
      .default([]),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.commit, t.manualId] }),
    foreignKey({
      columns: [t.commit],
      foreignColumns: [moduleIndexCommits.commit],
    }).onDelete('cascade'),
    check(
      'module_index_manuals_readable',
      sql`(${t.error} is null) = (${t.title} is not null)`,
    ),
  ],
);
