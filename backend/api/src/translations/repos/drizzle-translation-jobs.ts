import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type ExportCounts,
  type ExportSubject,
  isTranslationJobId,
  type LanguageCounts,
  type TranslationJob,
  type TranslationJobState,
  type TranslationJobUnit,
} from '../core/translation-job.js';
import {
  type NewTranslationJob,
  type Languages,
  type TranslationJobFilter,
  TranslationJobs,
  type UnitAtProvider,
} from '../core/translation-jobs.js';
import { translationJobs, translationJobUnits } from './translations.tables.js';

type Row = typeof translationJobs.$inferSelect;

/** Units inserted per statement (Postgres takes at most 65,535 parameters). */
const UNITS_PER_INSERT = 1_000;

/** `TranslationJobs` over `translation_jobs` and `translation_job_units`. */
@Injectable()
export class DrizzleTranslationJobs extends TranslationJobs {
  constructor(private readonly database: Database) {
    super();
  }

  async unitsAtProvider(filter: {
    readonly lang?: string | undefined;
  }): Promise<readonly UnitAtProvider[]> {
    return this.database.db
      .select({
        lang: translationJobUnits.lang,
        moduleId: translationJobUnits.moduleId,
        blockId: translationJobUnits.blockId,
      })
      .from(translationJobUnits)
      .where(
        and(
          eq(translationJobUnits.open, true),
          filter.lang === undefined
            ? undefined
            : eq(translationJobUnits.lang, filter.lang),
        ),
      );
  }

  async create(
    tx: Transaction,
    job: NewTranslationJob,
    units: readonly TranslationJobUnit[],
  ): Promise<boolean> {
    const db = drizzleOf(tx);
    await db.insert(translationJobs).values({
      id: job.id,
      sourceLang: job.sourceLang,
      languages: [...job.languages],
      subject: job.subject,
      ref: job.ref,
      commit: job.commit,
      released: job.released,
      dueDate: job.dueDate,
      state: 'sent',
      createdByKind: job.createdBy.kind,
      createdById: job.createdBy.id,
      createdAt: job.createdAt,
    });
    // Inserted in one fixed order (the open-unit index's), so two exports
    // waiting on each other's units never deadlock; `position` keeps the
    // order they were found in.
    const rows = units
      .map((unit, position) => ({
        jobId: job.id,
        lang: unit.lang,
        moduleId: unit.moduleId,
        blockId: unit.blockId,
        position,
        sourceHash: unit.sourceHash,
        words: unit.words,
        open: true,
      }))
      .sort(
        (a, b) =>
          compare(a.lang, b.lang) ||
          compare(a.moduleId, b.moduleId) ||
          compare(a.blockId, b.blockId),
      );
    for (let i = 0; i < rows.length; i += UNITS_PER_INSERT) {
      const batch = rows.slice(i, i + UNITS_PER_INSERT);
      const inserted = await db
        .insert(translationJobUnits)
        .values(batch)
        // The open-unit index: another job holds one of them open (a unit
        // given twice here would show the same way; the subject never
        // gives one twice).
        .onConflictDoNothing({
          target: [
            translationJobUnits.lang,
            translationJobUnits.moduleId,
            translationJobUnits.blockId,
          ],
          where: sql`${translationJobUnits.open}`,
        })
        .returning({ blockId: translationJobUnits.blockId });
      if (inserted.length < batch.length) return false;
    }
    return true;
  }

  async find(id: string): Promise<TranslationJob | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isTranslationJobId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(translationJobs)
      .where(eq(translationJobs.id, id));
    if (!row) return undefined;
    const [job] = await this.#withCounts([row]);
    return job;
  }

  async list(
    filter: TranslationJobFilter,
    page: PageRequest,
  ): Promise<Paginated<TranslationJob>> {
    const where = visibleTo(filter);
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(translationJobs)
          .where(where)
          .orderBy(desc(translationJobs.createdAt), desc(translationJobs.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(translationJobs).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return {
      total: counted?.total ?? 0,
      items: await this.#withCounts(rows),
    };
  }

  async unitsOf(id: string, lang: string): Promise<TranslationJobUnit[]> {
    if (!isTranslationJobId(id)) return [];
    return this.database.db
      .select({
        lang: translationJobUnits.lang,
        moduleId: translationJobUnits.moduleId,
        blockId: translationJobUnits.blockId,
        sourceHash: translationJobUnits.sourceHash,
        words: translationJobUnits.words,
      })
      .from(translationJobUnits)
      .where(
        and(
          eq(translationJobUnits.jobId, id),
          eq(translationJobUnits.lang, lang),
        ),
      )
      .orderBy(asc(translationJobUnits.position));
  }

  async cancel(tx: Transaction, id: string): Promise<boolean> {
    if (!isTranslationJobId(id)) return false;
    const db = drizzleOf(tx);
    const rows = await db
      .update(translationJobs)
      .set({ state: 'cancelled' })
      .where(and(eq(translationJobs.id, id), eq(translationJobs.state, 'sent')))
      .returning({ id: translationJobs.id });
    if (rows.length === 0) return false;
    await db
      .update(translationJobUnits)
      .set({ open: false })
      .where(eq(translationJobUnits.jobId, id));
    return true;
  }

  async returnUnits(
    tx: Transaction,
    id: string,
    units: readonly Pick<UnitAtProvider, 'lang' | 'moduleId' | 'blockId'>[],
  ): Promise<TranslationJobState | undefined> {
    if (!isTranslationJobId(id)) return undefined;
    const db = drizzleOf(tx);
    // The job's row first, so two imports of one job settle its state in turn.
    const [job] = await db
      .select({ state: translationJobs.state })
      .from(translationJobs)
      .where(eq(translationJobs.id, id))
      .for('update');
    if (!job) return undefined;
    if (job.state === 'cancelled') return 'cancelled';
    const sorted = [...units].sort(
      (a, b) =>
        compare(a.lang, b.lang) ||
        compare(a.moduleId, b.moduleId) ||
        compare(a.blockId, b.blockId),
    );
    for (let i = 0; i < sorted.length; i += UNITS_PER_INSERT) {
      const batch = sorted.slice(i, i + UNITS_PER_INSERT);
      await db
        .update(translationJobUnits)
        .set({ open: false })
        .where(
          and(
            eq(translationJobUnits.jobId, id),
            eq(translationJobUnits.open, true),
            sql`(${translationJobUnits.lang}, ${translationJobUnits.moduleId}, ${translationJobUnits.blockId}) in (${sql.join(
              batch.map((u) => sql`(${u.lang}, ${u.moduleId}, ${u.blockId})`),
              sql`, `,
            )})`,
          ),
        );
    }
    const [open] = await db
      .select({ open: count() })
      .from(translationJobUnits)
      .where(
        and(
          eq(translationJobUnits.jobId, id),
          eq(translationJobUnits.open, true),
        ),
      );
    if ((open?.open ?? 0) > 0 || job.state !== 'sent') {
      return job.state as TranslationJobState;
    }
    await db
      .update(translationJobs)
      .set({ state: 'returned' })
      .where(eq(translationJobs.id, id));
    return 'returned';
  }

  /** The jobs of `rows` with their counts, in the same order. */
  async #withCounts(rows: readonly Row[]): Promise<TranslationJob[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const units = translationJobUnits;
    const [perLanguage, totals] = await Promise.all([
      this.database.db
        .select({
          jobId: units.jobId,
          lang: units.lang,
          modules: countDistinct(units.moduleId),
          units: count(),
          words: sum(units.words).mapWith(Number),
        })
        .from(units)
        .where(inArray(units.jobId, ids))
        .groupBy(units.jobId, units.lang),
      this.database.db
        .select({
          jobId: units.jobId,
          modules: countDistinct(units.moduleId),
          units: count(),
          words: sum(units.words).mapWith(Number),
        })
        .from(units)
        .where(inArray(units.jobId, ids))
        .groupBy(units.jobId),
    ]);
    return rows.map((row) => {
      const total = totals.find((t) => t.jobId === row.id);
      const counts: ExportCounts = {
        modules: total?.modules ?? 0,
        units: total?.units ?? 0,
        words: total?.words ?? 0,
      };
      const languages: LanguageCounts[] = row.languages.map((lang) => {
        const found = perLanguage.find(
          (p) => p.jobId === row.id && p.lang === lang,
        );
        return {
          lang,
          modules: found?.modules ?? 0,
          units: found?.units ?? 0,
          words: found?.words ?? 0,
        };
      });
      return {
        id: row.id,
        sourceLang: row.sourceLang,
        languages: row.languages,
        subject: row.subject as ExportSubject,
        ref: row.ref,
        commit: row.commit,
        released: row.released,
        dueDate: row.dueDate,
        state: row.state as TranslationJobState,
        createdBy: {
          kind: row.createdByKind as 'user' | 'service',
          id: row.createdById,
        },
        createdAt: row.createdAt,
        counts,
        perLanguage: languages,
      };
    });
  }
}

/** Code-unit order, as Postgres's `C` collation would compare. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `seesJob` in SQL. */
function visibleTo(filter: TranslationJobFilter): SQL {
  const jobs = translationJobs;
  const among = (column: SQL | typeof jobs.languages, languages: Languages) =>
    languages === 'all'
      ? sql`true`
      : languages.length === 0
        ? sql`false`
        : sql`${column} <@ array[${sql.join(
            languages.map((lang) => sql`${lang}`),
            sql`, `,
          )}]::text[]`;
  const own = and(
    eq(jobs.createdByKind, filter.reader.kind),
    eq(jobs.createdById, filter.reader.id),
  );
  const coveredBy = (readable: Languages) =>
    and(
      among(sql`array[${jobs.sourceLang}]`, readable),
      among(jobs.languages, filter.managed),
      among(jobs.languages, readable),
    );
  const covered = or(
    and(eq(jobs.released, true), coveredBy(filter.readable)),
    and(eq(jobs.released, false), coveredBy(filter.draftReadable)),
  );
  return and(
    filter.drafts ? sql`true` : eq(jobs.released, true),
    or(own, covered),
  ) as SQL;
}
