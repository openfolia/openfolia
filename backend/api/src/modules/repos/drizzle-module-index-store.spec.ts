import { eq } from 'drizzle-orm';
import { parseCondition } from '@openfolia/content-model';
import {
  FakeSnapshot,
  manifest,
  module,
} from '../../../tests/fakes/fake-content.js';
import { referring } from '../../../tests/fakes/fake-module-index-store.js';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import {
  buildCommitIndex,
  INDEX_FORMAT,
  type CommitIndex,
} from '../core/module-index.js';
import { DrizzleModuleIndexStore } from './drizzle-module-index-store.js';
import { moduleIndexCommits } from './module-index.tables.js';

const commit = (n: number) => n.toString(16).padStart(40, 'a');

const content = {
  modules: [
    {
      ...referring(module('b'), 'a'),
      meta: {
        ...module('b').meta,
        facets: { region: ['north'] },
        keywords: ['Wärme'],
      },
    },
    module('a'),
    {
      ...module('a', 'de'),
      // Variant names, as the variants admin reads them (#91).
      blocks: [
        {
          type: 'variant' as const,
          id: 'v',
          when: parseCondition('model in (large) && software >= 2'),
          blocks: module('a').blocks,
        },
      ],
    },
  ],
  brokenModules: [{ id: 'broken', lang: 'en' }],
  // A translation compared with its source (#480).
  translationRecords: {
    'de/a': {
      schemaVersion: 1 as const,
      sourceCommit: 'b'.repeat(40),
      blocks: {},
    },
  },
  manifests: [
    {
      ...manifest('guide', ['b']),
      entries: [{ module: 'b', when: parseCondition('market in (eu)') }],
    },
  ],
  brokenManifests: ['bad'],
};

describe('DrizzleModuleIndexStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleModuleIndexStore;
  let built: CommitIndex;

  beforeAll(async () => {
    database = await createTestDatabase();
    store = new DrizzleModuleIndexStore(database);
    built = await buildCommitIndex(new FakeSnapshot(content, commit(1)));
  });
  afterAll(() => database?.close());
  beforeEach(() => store.clear());

  it('gives back exactly the index it kept', async () => {
    expect(built.modules.find((m) => m.lang === 'de')?.variants).toEqual({
      model: ['large'],
      software: [],
    });
    expect(built.manuals.find((m) => m.id === 'guide')?.variants).toEqual({
      model: ['large', 'small'],
    });
    expect(built.manuals.find((m) => m.id === 'guide')?.entryVariants).toEqual([
      { modules: ['b'], names: { market: ['eu'] } },
    ]);
    expect(built.modules.find((m) => m.lang === 'de')?.translation).toEqual({
      outdated: ['p'],
      sourceCommit: 'b'.repeat(40),
    });
    expect(built.modules.find((m) => m.id === 'a' && m.lang === 'en')).toEqual(
      expect.objectContaining({
        digest: expect.any(String) as string,
        units: ['p'],
      }),
    );
    expect(await store.get(built.commit)).toBeUndefined();
    await store.put(built, 10);
    expect(await store.get(built.commit)).toEqual(built);
  });

  it('builds again an index of another format, never reading it (#480)', async () => {
    await store.put(built, 10);
    // As a server of the previous version left it.
    await database.db
      .update(moduleIndexCommits)
      .set({ format: 0 })
      .where(eq(moduleIndexCommits.commit, built.commit));
    expect(await store.get(built.commit)).toBeUndefined();
    await store.put(built, 10);
    expect(await store.get(built.commit)).toEqual(built);
    // A newer server's index is left alone, and not read here either.
    await database.db
      .update(moduleIndexCommits)
      .set({ format: INDEX_FORMAT + 1 })
      .where(eq(moduleIndexCommits.commit, built.commit));
    await store.put(built, 10);
    expect(await store.get(built.commit)).toBeUndefined();
    const [row] = await database.db.select().from(moduleIndexCommits);
    expect(row?.format).toBe(INDEX_FORMAT + 1);
  });

  it('keeps the first index of a commit', async () => {
    await store.put(built, 10);
    await store.put({ ...built, modules: [] }, 10);
    expect(await store.get(built.commit)).toEqual(built);
  });

  it('drops the oldest commits beyond those it keeps', async () => {
    for (const n of [1, 2, 3]) {
      await store.put({ ...built, commit: commit(n) }, 2);
      // `built_at` is the transaction's start: one apart.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await store.get(commit(1))).toBeUndefined();
    expect(await store.get(commit(2))).toBeDefined();
    expect(await store.get(commit(3))).toEqual({
      ...built,
      commit: commit(3),
    });
  });

  it('drops everything on clear, rows and all', async () => {
    await store.put(built, 10);
    await store.clear();
    expect(await store.get(built.commit)).toBeUndefined();
    const rows = await database.db.query.moduleIndexModules.findMany();
    expect(rows).toEqual([]);
  });

  it('stores a large commit in several statements', async () => {
    const many = {
      commit: commit(9),
      modules: Array.from({ length: 1_201 }, (_, i) => ({
        id: `m-${String(i).padStart(4, '0')}`,
        lang: 'en',
        meta: { title: `M ${i}`, type: 'concept', facets: {} },
        refs: [],
      })),
      manuals: [],
    };
    await store.put(many, 10);
    expect(await store.get(many.commit)).toEqual(many);
  });
});

describe('DrizzleModuleIndexStore, odd content', () => {
  let database: PgliteDatabase;
  afterAll(() => database?.close());

  it('drops NUL characters rather than failing, and gives code-unit order back', async () => {
    database = await createTestDatabase();
    const store = new DrizzleModuleIndexStore(database);
    const odd = (id: string) => ({
      id,
      lang: 'en',
      meta: { title: `T\u0000${id}`, type: 'concept', facets: {} },
      refs: [],
    });
    await store.put(
      { commit: commit(20), modules: [odd('ab'), odd('a-b')], manuals: [] },
      10,
    );
    const kept = await store.get(commit(20));
    expect(kept?.modules.map((m) => [m.id, m.meta?.title])).toEqual([
      ['a-b', 'Ta-b'],
      ['ab', 'Tab'],
    ]);
  });
});
