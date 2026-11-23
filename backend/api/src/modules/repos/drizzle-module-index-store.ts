import type { Deprecation } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, notInArray } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import {
  type CommitIndex,
  type IndexedManual,
  type IndexedModule,
  INDEX_FORMAT,
  ModuleIndexStore,
} from '../core/module-index.js';
import {
  moduleIndexCommits,
  moduleIndexManuals,
  moduleIndexModules,
} from './module-index.tables.js';

/** Rows per insert statement, well below Postgres' 65,535 parameters. */
const ROWS_PER_INSERT = 500;

/** `ModuleIndexStore` over the `module_index_*` tables. */
@Injectable()
export class DrizzleModuleIndexStore extends ModuleIndexStore {
  constructor(private readonly database: Database) {
    super();
  }

  async get(commit: string): Promise<CommitIndex | undefined> {
    const db = this.database.db;
    // One snapshot of the tables: a commit's rows are complete once its row
    // is there, and a commit dropped meanwhile is read whole or not at all.
    return db.transaction(
      async (tx) => {
        const [built] = await tx
          .select({ format: moduleIndexCommits.format })
          .from(moduleIndexCommits)
          .where(eq(moduleIndexCommits.commit, commit));
        // Another format's rows (another version's server) are not this index.
        if (built?.format !== INDEX_FORMAT) return undefined;
        const [modules, manuals] = await Promise.all([
          tx
            .select()
            .from(moduleIndexModules)
            .where(eq(moduleIndexModules.commit, commit))
            .orderBy(
              asc(moduleIndexModules.moduleId),
              asc(moduleIndexModules.lang),
            ),
          tx
            .select()
            .from(moduleIndexManuals)
            .where(eq(moduleIndexManuals.commit, commit))
            .orderBy(asc(moduleIndexManuals.manualId)),
        ]);
        return {
          commit,
          modules: modules
            .map(toModule)
            .sort((a, b) => compare(a.id, b.id) || compare(a.lang, b.lang)),
          manuals: manuals.map(toManual).sort((a, b) => compare(a.id, b.id)),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async put(index: CommitIndex, keep: number): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      // An index of the commit in an older format goes (its rows with it); a newer one stays.
      await tx
        .delete(moduleIndexCommits)
        .where(
          and(
            eq(moduleIndexCommits.commit, index.commit),
            lt(moduleIndexCommits.format, INDEX_FORMAT),
          ),
        );
      // Waits for another server writing the same commit, then does nothing.
      const added = await tx
        .insert(moduleIndexCommits)
        .values({ commit: index.commit, format: INDEX_FORMAT })
        .onConflictDoNothing()
        .returning({ commit: moduleIndexCommits.commit });
      if (added.length === 0) return;
      for (const rows of chunks(
        index.modules.map((m) => moduleRow(index.commit, m)),
      )) {
        await tx.insert(moduleIndexModules).values(rows);
      }
      for (const rows of chunks(
        index.manuals.map((m) => manualRow(index.commit, m)),
      )) {
        await tx.insert(moduleIndexManuals).values(rows);
      }
      const kept = tx
        .select({ commit: moduleIndexCommits.commit })
        .from(moduleIndexCommits)
        .orderBy(
          desc(moduleIndexCommits.builtAt),
          desc(moduleIndexCommits.commit),
        )
        .limit(Math.max(keep, 1));
      await tx
        .delete(moduleIndexCommits)
        .where(notInArray(moduleIndexCommits.commit, kept));
    });
  }

  async clear(): Promise<void> {
    // The rows of each commit go with it (`on delete cascade`).
    await this.database.db.delete(moduleIndexCommits);
  }
}

/** Postgres text and jsonb hold no NUL character: an authored one is dropped, never a failed write. */
const clean = (text: string): string => text.replaceAll('\u0000', '');
const cleanAll = (texts: readonly string[]): string[] => texts.map(clean);
const cleanFacets = (
  facets: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(facets).map(([k, v]) => [clean(k), cleanAll(v)]),
  );
const nullable = (text: string | undefined): string | null =>
  text === undefined ? null : clean(text);
const cleanDeprecation = (d: Deprecation | undefined): Deprecation | null =>
  d === undefined
    ? null
    : {
        reason: clean(d.reason),
        ...(d.replacedBy !== undefined && { replacedBy: clean(d.replacedBy) }),
      };

/** Code-unit order, as the index is built: the same on every database, whatever its collation. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function* chunks<T>(rows: readonly T[]): Generator<T[]> {
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    yield rows.slice(start, start + ROWS_PER_INSERT);
  }
}

function moduleRow(
  commit: string,
  m: IndexedModule,
): typeof moduleIndexModules.$inferInsert {
  return {
    commit,
    moduleId: m.id,
    lang: m.lang,
    title: nullable(m.meta?.title),
    moduleType: nullable(m.meta?.type),
    audience: nullable(m.meta?.audience),
    facets: m.meta ? cleanFacets(m.meta.facets) : null,
    keywords: m.meta?.keywords ? cleanAll(m.meta.keywords) : null,
    deprecated: cleanDeprecation(m.meta?.deprecated),
    refs: cleanAll(m.refs),
    variants: cleanFacets(m.variants ?? {}),
    terms: cleanAll(m.terms ?? []),
    digest: m.digest ?? null,
    units: cleanAll(m.units ?? []),
    translation: m.translation
      ? {
          outdated: cleanAll(m.translation.outdated),
          sourceCommit: m.translation.sourceCommit,
        }
      : null,
    error: m.meta ? null : clean(m.error ?? 'The module file cannot be read.'),
  };
}

function manualRow(
  commit: string,
  m: IndexedManual,
): typeof moduleIndexManuals.$inferInsert {
  return {
    commit,
    manualId: m.id,
    title: m.error === undefined ? clean(m.title ?? m.id) : null,
    audience: nullable(m.audience),
    deprecated: cleanDeprecation(m.deprecated),
    modules: cleanAll(m.modules),
    variants: cleanFacets(m.variants ?? {}),
    entryVariants: (m.entryVariants ?? []).map((e) => ({
      modules: cleanAll(e.modules),
      names: cleanFacets(e.names),
    })),
    error: nullable(m.error),
  };
}

function toModule(row: typeof moduleIndexModules.$inferSelect): IndexedModule {
  const { moduleId: id, lang, refs } = row;
  if (row.error !== null || row.title === null || row.moduleType === null) {
    return { id, lang, refs: [], error: row.error ?? '' };
  }
  return {
    id,
    lang,
    meta: {
      title: row.title,
      type: row.moduleType,
      ...(row.audience !== null && { audience: row.audience }),
      facets: row.facets ?? {},
      ...(row.keywords?.length && { keywords: row.keywords }),
      ...(row.deprecated !== null && { deprecated: row.deprecated }),
    },
    refs,
    ...variantsOf(row.variants),
    ...(row.terms.length > 0 && { terms: row.terms }),
    ...(row.digest !== null && { digest: row.digest }),
    ...(row.units.length > 0 && { units: row.units }),
    ...(row.translation !== null && { translation: row.translation }),
  };
}

function toManual(row: typeof moduleIndexManuals.$inferSelect): IndexedManual {
  return {
    id: row.manualId,
    ...(row.error === null && row.title !== null
      ? { title: row.title }
      : { error: row.error ?? '' }),
    ...(row.audience !== null && { audience: row.audience }),
    ...(row.deprecated !== null && { deprecated: row.deprecated }),
    modules: row.modules,
    ...variantsOf(row.variants),
    ...(row.entryVariants.length > 0 && { entryVariants: row.entryVariants }),
  };
}

/** The variant names as the index holds them: absent when none. */
const variantsOf = (
  variants: Record<string, string[]>,
): { variants?: Record<string, string[]> } =>
  Object.keys(variants).length > 0 ? { variants } : {};
