import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import {
  newTranslationJobId,
  type TranslationJobUnit,
} from '../core/translation-job.js';
import {
  type Languages,
  type NewTranslationJob,
  seesJob,
  type TranslationJobFilter,
} from '../core/translation-jobs.js';
import { DrizzleTranslationJobs } from './drizzle-translation-jobs.js';

const HASH = 'c'.repeat(64);
let at = Date.parse('2026-03-01T10:00:00Z');

const job = (over: Partial<NewTranslationJob> = {}): NewTranslationJob => {
  at += 1000;
  return {
    id: newTranslationJobId(at),
    sourceLang: 'en',
    languages: ['de', 'fr'],
    subject: { type: 'manual', manualId: 'operating' },
    ref: 'main',
    commit: 'a'.repeat(40),
    released: true,
    dueDate: '2026-04-01',
    createdBy: { kind: 'user', id: 'sample-manager' },
    createdAt: new Date(at),
    ...over,
  };
};

const unit = (
  lang: string,
  moduleId: string,
  blockId: string,
  words = 3,
): TranslationJobUnit => ({
  lang,
  moduleId,
  blockId,
  sourceHash: HASH,
  words,
});

describe('DrizzleTranslationJobs', () => {
  let database: PgliteDatabase;
  let jobs: DrizzleTranslationJobs;
  let work: DrizzleUnitOfWork;
  const all = { number: 1, size: 50 };

  beforeEach(async () => {
    database = await createTestDatabase();
    jobs = new DrizzleTranslationJobs(database);
    work = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  const create = (j: NewTranslationJob, units: TranslationJobUnit[]) =>
    work.run((tx) => jobs.create(tx, j, units));

  it('records a job with its units open, and counts them', async () => {
    const j = job();
    expect(
      await create(j, [
        unit('de', 'charging', 'intro', 4),
        unit('de', 'charging', 'steps', 2),
        unit('fr', 'charging', 'intro', 4),
        unit('fr', 'safety', 'hot', 1),
        unit('de', 'alpha', 'z', 0),
      ]),
    ).toBe(true);
    const found = await jobs.find(j.id);
    expect(found).toEqual({
      ...j,
      state: 'sent',
      counts: { modules: 3, units: 5, words: 11 },
      perLanguage: [
        { lang: 'de', modules: 2, units: 3, words: 6 },
        { lang: 'fr', modules: 2, units: 2, words: 5 },
      ],
    });
    expect(await jobs.unitsAtProvider({ lang: 'fr' })).toEqual(
      expect.arrayContaining([
        { lang: 'fr', moduleId: 'charging', blockId: 'intro' },
        { lang: 'fr', moduleId: 'safety', blockId: 'hot' },
      ]),
    );
    expect(await jobs.unitsAtProvider({})).toHaveLength(5);
    // In the order exported, not the order inserted.
    expect((await jobs.unitsOf(j.id, 'de')).map((u) => u.blockId)).toEqual([
      'intro',
      'steps',
      'z',
    ]);
  });

  it('refuses a unit open in another job, and frees it once cancelled', async () => {
    const first = job();
    expect(await create(first, [unit('de', 'charging', 'intro')])).toBe(true);
    const second = job();
    await expect(
      work.run(async (tx) => {
        if (
          !(await jobs.create(tx, second, [unit('de', 'charging', 'intro')]))
        ) {
          throw new Error('rolled back');
        }
      }),
    ).rejects.toThrow('rolled back');
    expect(await jobs.find(second.id)).toBeUndefined();
    // Another language, or another block, is no clash.
    expect(
      await create(job(), [
        unit('fr', 'charging', 'intro'),
        unit('de', 'charging', 'steps'),
      ]),
    ).toBe(true);

    expect(await work.run((tx) => jobs.cancel(tx, first.id))).toBe(true);
    expect((await jobs.find(first.id))?.state).toBe('cancelled');
    expect(await work.run((tx) => jobs.cancel(tx, first.id))).toBe(false);
    expect(await jobs.unitsAtProvider({ lang: 'de' })).toEqual([
      { lang: 'de', moduleId: 'charging', blockId: 'steps' },
    ]);
    expect(await create(job(), [unit('de', 'charging', 'intro')])).toBe(true);
  });

  it('returns units: they leave the provider, and the job is returned once none is left', async () => {
    const j = job();
    await create(j, [
      unit('de', 'charging', 'intro'),
      unit('de', 'charging', 'steps'),
      unit('fr', 'charging', 'intro'),
    ]);
    const back = (
      units: { lang: string; moduleId: string; blockId: string }[],
    ) => work.run((tx) => jobs.returnUnits(tx, j.id, units));
    expect(
      await back([
        { lang: 'de', moduleId: 'charging', blockId: 'intro' },
        // Not a unit of the job: changes nothing.
        { lang: 'de', moduleId: 'other', blockId: 'x' },
      ]),
    ).toBe('sent');
    expect(await jobs.unitsAtProvider({ lang: 'de' })).toEqual([
      { lang: 'de', moduleId: 'charging', blockId: 'steps' },
    ]);
    // A returned unit is free to be sent again.
    expect(await create(job(), [unit('de', 'charging', 'intro')])).toBe(true);
    expect(
      await back([
        { lang: 'de', moduleId: 'charging', blockId: 'steps' },
        { lang: 'fr', moduleId: 'charging', blockId: 'intro' },
      ]),
    ).toBe('returned');
    expect((await jobs.find(j.id))?.state).toBe('returned');
    expect(await jobs.unitsAtProvider({ lang: 'fr' })).toEqual([]);
    // Again: still returned.
    expect(
      await back([{ lang: 'fr', moduleId: 'charging', blockId: 'intro' }]),
    ).toBe('returned');
    expect(await work.run((tx) => jobs.cancel(tx, j.id))).toBe(false);
  });

  it('leaves a cancelled job alone, and knows no unknown one', async () => {
    const j = job();
    await create(j, [unit('de', 'charging', 'intro')]);
    await work.run((tx) => jobs.cancel(tx, j.id));
    expect(
      await work.run((tx) =>
        jobs.returnUnits(tx, j.id, [
          { lang: 'de', moduleId: 'charging', blockId: 'intro' },
        ]),
      ),
    ).toBe('cancelled');
    expect((await jobs.find(j.id))?.state).toBe('cancelled');
    expect(
      await work.run((tx) =>
        jobs.returnUnits(tx, newTranslationJobId(at + 99_000), []),
      ),
    ).toBeUndefined();
  });

  it('returns many units in batches', async () => {
    const j = job({ languages: ['de'] });
    const many = Array.from({ length: 2_500 }, (_, i) =>
      unit('de', 'big', `b${i}`, 1),
    );
    await create(j, many);
    expect(
      await work.run((tx) =>
        jobs.returnUnits(
          tx,
          j.id,
          many.map(({ lang, moduleId, blockId }) => ({
            lang,
            moduleId,
            blockId,
          })),
        ),
      ),
    ).toBe('returned');
    expect(await jobs.unitsAtProvider({ lang: 'de' })).toEqual([]);
  });

  it('inserts many units in batches', async () => {
    const j = job({ languages: ['de'] });
    const many = Array.from({ length: 2_500 }, (_, i) =>
      unit('de', 'big', `b${i}`, 1),
    );
    expect(await create(j, many)).toBe(true);
    expect((await jobs.find(j.id))?.counts).toEqual({
      modules: 1,
      units: 2_500,
      words: 2_500,
    });
    expect((await jobs.unitsOf(j.id, 'de')).at(-1)?.blockId).toBe('b2499');
  });

  it('lists newest first, exactly the jobs seesJob lets the reader see, paged', async () => {
    const other = { kind: 'user' as const, id: 'someone-else' };
    const made = [
      job({ languages: ['de'] }),
      job({ languages: ['de', 'fr'] }),
      job({ languages: ['fr'] }),
      job({ languages: ['fr'], released: false }),
      job({ languages: ['fr'], createdBy: other }),
      job({ languages: ['de'], createdBy: other, released: false }),
      job({ languages: ['de'], sourceLang: 'it', createdBy: other }),
      job({ languages: ['fr'], createdBy: other, released: false }),
    ];
    for (const [i, j] of made.entries()) {
      await create(j, [unit(j.languages[0] as string, `m${i}`, 'b')]);
    }
    const newestFirst = [...made].reverse();
    const reader = { kind: 'user' as const, id: 'sample-manager' };
    const filters: TranslationJobFilter[] = [];
    for (const managed of ['all', ['de'], ['de', 'fr'], []] as Languages[]) {
      for (const readable of [
        'all',
        ['en', 'de'],
        ['de', 'fr'],
      ] as Languages[]) {
        for (const draftReadable of ['all', ['en', 'de'], []] as Languages[]) {
          for (const drafts of [true, false]) {
            for (const who of [
              reader,
              other,
              { kind: 'service' as const, id: 'x' },
            ]) {
              filters.push({
                reader: who,
                managed,
                readable,
                draftReadable,
                drafts,
              });
            }
          }
        }
      }
    }
    for (const filter of filters) {
      const listed = await jobs.list(filter, all);
      const expected = newestFirst
        .filter((j) => seesJob(filter, j))
        .map((j) => j.id);
      expect([filter, listed.items.map((j) => j.id)]).toEqual([
        filter,
        expected,
      ]);
      expect(listed.total).toBe(expected.length);
    }
    const everything: TranslationJobFilter = {
      reader,
      managed: 'all',
      readable: 'all',
      draftReadable: 'all',
      drafts: true,
    };
    const page = await jobs.list(everything, { number: 2, size: 6 });
    expect(page.total).toBe(8);
    expect(page.items.map((j) => j.id)).toEqual([made[1]?.id, made[0]?.id]);
    expect(page.items[0]?.counts.units).toBe(1);
  });

  it('finds nothing for a malformed or unknown ID', async () => {
    expect(await jobs.find('nope')).toBeUndefined();
    expect(await jobs.find(newTranslationJobId())).toBeUndefined();
    expect(await jobs.unitsOf('nope', 'de')).toEqual([]);
    expect(await work.run((tx) => jobs.cancel(tx, 'nope'))).toBe(false);
  });
});
