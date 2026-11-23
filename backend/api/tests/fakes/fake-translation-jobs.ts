import type { PageRequest, Paginated } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  countUnits,
  type TranslationJob,
  type TranslationJobUnit,
} from '../../src/translations/core/translation-job.js';
import {
  type NewTranslationJob,
  type TranslationJobFilter,
  seesJob,
  TranslationJobs,
  type UnitAtProvider,
} from '../../src/translations/core/translation-jobs.js';
import { fakeOf } from './fake-unit-of-work.js';

interface StoredJob {
  job: TranslationJob;
  units: TranslationJobUnit[];
}

/**
 * Translation jobs in memory. `units` are more units at a provider, as a
 * test sets them (of no job); the jobs `create` records add theirs while
 * they are `sent`. Writes are staged on the fake transaction.
 */
export class FakeTranslationJobs extends TranslationJobs {
  units: UnitAtProvider[] = [];
  readonly jobs = new Map<string, StoredJob>();
  /** Per job, the units an import closed (`lang/module/block`). */
  readonly returned = new Map<string, Set<string>>();

  unitsAtProvider(filter: {
    readonly lang?: string | undefined;
  }): Promise<readonly UnitAtProvider[]> {
    return Promise.resolve(
      [...this.units, ...this.#open()].filter(
        (u) => filter.lang === undefined || u.lang === filter.lang,
      ),
    );
  }

  #open(): UnitAtProvider[] {
    return [...this.jobs.values()].flatMap(({ job, units }) =>
      job.state === 'sent'
        ? units.filter(
            (u) =>
              !this.returned
                .get(job.id)
                ?.has(`${u.lang}/${u.moduleId}/${u.blockId}`),
          )
        : [],
    );
  }

  create(
    tx: Transaction,
    job: NewTranslationJob,
    units: readonly TranslationJobUnit[],
  ): Promise<boolean> {
    const key = (u: UnitAtProvider) => `${u.lang}/${u.moduleId}/${u.blockId}`;
    const open = new Set(this.#open().map(key));
    if (units.some((u) => open.has(key(u)))) return Promise.resolve(false);
    fakeOf(tx).onCommit(() => {
      this.jobs.set(job.id, {
        job: { ...job, state: 'sent', ...countUnits(job.languages, units) },
        units: [...units],
      });
    });
    return Promise.resolve(true);
  }

  find(id: string): Promise<TranslationJob | undefined> {
    return Promise.resolve(this.jobs.get(id)?.job);
  }

  list(
    filter: TranslationJobFilter,
    page: PageRequest,
  ): Promise<Paginated<TranslationJob>> {
    const all = [...this.jobs.values()]
      .map(({ job }) => job)
      .filter((job) => seesJob(filter, job))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const start = (page.number - 1) * page.size;
    return Promise.resolve({
      total: all.length,
      items: all.slice(start, start + page.size),
    });
  }

  unitsOf(id: string, lang: string): Promise<TranslationJobUnit[]> {
    return Promise.resolve(
      (this.jobs.get(id)?.units ?? []).filter((u) => u.lang === lang),
    );
  }

  returnUnits(
    tx: Transaction,
    id: string,
    units: readonly Pick<UnitAtProvider, 'lang' | 'moduleId' | 'blockId'>[],
  ): Promise<TranslationJob['state'] | undefined> {
    const stored = this.jobs.get(id);
    if (!stored) return Promise.resolve(undefined);
    if (stored.job.state === 'cancelled') return Promise.resolve('cancelled');
    const key = (u: Pick<UnitAtProvider, 'lang' | 'moduleId' | 'blockId'>) =>
      `${u.lang}/${u.moduleId}/${u.blockId}`;
    const back = new Set(units.map(key));
    const closed = new Set([...(this.returned.get(id) ?? []), ...back]);
    const open = stored.units.some((u) => !closed.has(key(u)));
    const state = open ? stored.job.state : 'returned';
    fakeOf(tx).onCommit(() => {
      this.returned.set(id, closed);
      stored.job = { ...stored.job, state };
    });
    return Promise.resolve(state);
  }

  cancel(tx: Transaction, id: string): Promise<boolean> {
    const stored = this.jobs.get(id);
    if (stored?.job.state !== 'sent') return Promise.resolve(false);
    fakeOf(tx).onCommit(() => {
      stored.job = { ...stored.job, state: 'cancelled' };
    });
    return Promise.resolve(true);
  }
}
