import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../core/change-set.js';
import { DrizzleChangeSetStore } from './drizzle-change-set-store.js';

const BASE = 'c'.repeat(40);

function changeSet(over: Partial<ChangeSet> = {}, at = Date.now()): ChangeSet {
  const id = over.id ?? newChangeSetId(at);
  return {
    id,
    title: 'Explain charging',
    description: null,
    author: { kind: 'user', id: 'sample-author' },
    baseRef: 'main',
    baseCommit: BASE,
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: new Date(at),
    updatedAt: new Date(at),
    ...over,
  };
}

describe('DrizzleChangeSetStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleChangeSetStore;
  let unit: DrizzleUnitOfWork;
  const all = { number: 1, size: 50 };

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleChangeSetStore(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  it('stores change sets and reads them back exactly', async () => {
    const one = changeSet({ description: 'Why.' });
    await unit.run((tx) => store.insert(tx, one));
    expect(await store.find(one.id)).toEqual(one);
    expect(await store.find(newChangeSetId())).toBeUndefined();
    // Malformed IDs are none, not a database error.
    expect(await store.find('nope')).toBeUndefined();
    expect(await store.find(one.id.toUpperCase())).toBeUndefined();
  });

  it('lists newest first, filtered, paged', async () => {
    const now = Date.now();
    const old = changeSet({}, now - 2000);
    const mid = changeSet(
      { author: { kind: 'user', id: 'sample-reviewer' } },
      now - 1000,
    );
    const latest = changeSet({ state: 'abandoned' }, now);
    await unit.run(async (tx) => {
      for (const c of [mid, latest, old]) await store.insert(tx, c);
    });
    const ids = async (filter: object, page = all) =>
      (await store.list(filter, page)).items.map((c) => c.id);
    expect(await ids({})).toEqual([latest.id, mid.id, old.id]);
    expect(await ids({ state: 'draft' })).toEqual([mid.id, old.id]);
    expect(await ids({ author: 'sample-reviewer' })).toEqual([mid.id]);
    expect(await ids({ author: 'sample-author', state: 'abandoned' })).toEqual([
      latest.id,
    ]);
    expect(await store.list({}, { number: 2, size: 2 })).toEqual({
      total: 3,
      items: [old],
    }); // Per state, the state filter left out (#481).
    expect(await store.countByState({ state: 'abandoned' })).toEqual({
      draft: 2,
      'in-review': 0,
      approved: 0,
      merged: 0,
      abandoned: 1,
    });
    expect(
      await store.countByState({
        author: 'sample-author',
        authorKind: 'user',
      }),
    ).toMatchObject({ draft: 1, abandoned: 1 });
  });

  it('lists the open ones, newest first, at most so many, by author', async () => {
    const now = Date.now();
    const old = changeSet({}, now - 3000);
    const reviewed = changeSet(
      {
        state: 'in-review',
        reviewHead: 'd'.repeat(40),
        author: { kind: 'user', id: 'sample-reviewer' },
      },
      now - 2000,
    );
    const abandoned = changeSet({ state: 'abandoned' }, now - 1000);
    const latest = changeSet({}, now);
    await unit.run(async (tx) => {
      for (const c of [old, reviewed, abandoned, latest]) {
        await store.insert(tx, c);
      }
    });
    const ids = async (max: number, author?: ChangeSet['author']) =>
      (await store.listOpen(max, author)).map((c) => c.id);
    expect(await ids(10)).toEqual([latest.id, reviewed.id, old.id]);
    expect(await ids(2)).toEqual([latest.id, reviewed.id]);
    expect(await ids(10, { kind: 'user', id: 'sample-author' })).toEqual([
      latest.id,
      old.id,
    ]);
    expect(await ids(10, { kind: 'service', id: 'sample-author' })).toEqual([]);
  });

  it('walks one state oldest first in keyset pages, resuming after a cursor', async () => {
    const now = Date.now();
    const approved = (at: number) =>
      changeSet({ state: 'approved', reviewHead: 'd'.repeat(40) }, at);
    const first = approved(now - 3000);
    // Two at the same moment: the ID orders them.
    const [a, b] = [approved(now - 2000), approved(now - 2000)].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    ) as [ChangeSet, ChangeSet];
    const draft = changeSet({}, now - 1000);
    const last = approved(now);
    await unit.run(async (tx) => {
      for (const c of [last, draft, b, first, a]) await store.insert(tx, c);
    });
    const ids = async (max: number, after?: ChangeSet) =>
      (await store.listInState('approved', max, after)).map((c) => c.id);
    expect(await ids(10)).toEqual([first.id, a.id, b.id, last.id]);
    expect(await ids(2)).toEqual([first.id, a.id]);
    expect(await ids(2, a)).toEqual([b.id, last.id]);
    expect(await ids(2, last)).toEqual([]);
  });

  it('locks, changes the state and stamps the change', async () => {
    const one = changeSet({}, Date.now() - 60_000);
    await unit.run((tx) => store.insert(tx, one));
    const changed = await unit.run(async (tx) => {
      expect(await store.lock(tx, one.id)).toEqual(one);
      expect(await store.lock(tx, 'nope')).toBeUndefined();
      return store.setState(tx, one.id, 'abandoned');
    });
    expect(changed).toMatchObject({
      state: 'abandoned',
      createdAt: one.createdAt,
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(
      one.updatedAt.getTime(),
    );
    expect(await store.find(one.id)).toEqual(changed);
  });

  it('keeps nothing of a transaction that fails', async () => {
    const one = changeSet();
    await expect(
      unit.run(async (tx) => {
        await store.insert(tx, one);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await store.find(one.id)).toBeUndefined();
  });

  it('tells which IDs have a change set', async () => {
    const one = changeSet();
    await unit.run((tx) => store.insert(tx, one));
    const other = newChangeSetId();
    expect(await store.existing([one.id, other, 'nope'])).toEqual(
      new Set([one.id]),
    );
    expect(await store.existing([])).toEqual(new Set());
  });

  it('holds the formats in the database too', async () => {
    const id = newChangeSetId();
    const bad: Partial<ChangeSet>[] = [
      { title: '' },
      { title: 'x'.repeat(201) },
      { description: '' },
      { baseRef: 'change-sets/other' },
      { baseCommit: 'main' },
      { branch: 'main' },
      { branch: `change-sets/${newChangeSetId()}` },
      { state: 'nope' as never },
      { author: { kind: 'robot' as never, id: 'x' } },
    ];
    for (const over of bad) {
      await expect(
        unit.run((tx) => store.insert(tx, changeSet({ id, ...over }))),
      ).rejects.toThrow();
    }
    expect(await store.find(id)).toBeUndefined();
  });
});
