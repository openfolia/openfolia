import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleAssetReferenceStore } from './drizzle-asset-reference-store.js';

const commit = (n: number) => n.toString(16).padStart(40, 'a');
const hash = (n: number) => n.toString(16).padStart(64, '0');

describe('DrizzleAssetReferenceStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleAssetReferenceStore;

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleAssetReferenceStore(database);
  });
  afterEach(() => database?.close());

  it('keeps per commit the hashes its module files mention', async () => {
    await store.put(commit(1), [hash(1), hash(2)], [commit(1)]);
    await store.put(commit(2), [hash(2), hash(3)], [commit(1), commit(2)]);
    // A commit never changes: a second write keeps the first.
    await store.put(commit(2), [hash(9)], [commit(1), commit(2)]);
    await store.put(commit(3), [], [commit(1), commit(2), commit(3)]);

    const at = await store.referencedAt([commit(1), commit(2), commit(4)]);
    expect([...at.indexed].sort()).toEqual([commit(1), commit(2)]);
    expect([...at.hashes].sort()).toEqual([hash(1), hash(2), hash(3)]);
    expect([...(await store.referencedAt([commit(3)])).indexed]).toEqual([
      commit(3),
    ]);

    const mentioning = await store.mentioning(
      [hash(2), hash(3), hash(4)],
      [commit(1), commit(2), commit(3)],
    );
    expect([...mentioning.indexed].sort()).toEqual([
      commit(1),
      commit(2),
      commit(3),
    ]);
    expect(
      new Map(
        [...mentioning.commits].map(([h, commits]) => [h, [...commits].sort()]),
      ),
    ).toEqual(
      new Map([
        [hash(2), [commit(1), commit(2)]],
        [hash(3), [commit(2)]],
      ]),
    );
    expect(await store.referencedAt([])).toEqual({
      indexed: new Set(),
      hashes: new Set(),
    });
  });

  it('drops commits no ref points to once they are an hour old', async () => {
    await store.put(commit(1), [hash(1)], [commit(1)]);
    await store.put(commit(2), [hash(2)], [commit(2)]);
    await database.db.execute(
      sql`update asset_reference_commits set built_at = now() - interval '2 hours'`,
    );
    // Commit 1 is no ref's any more; commit 2 still is.
    await store.put(commit(3), [hash(3)], [commit(2), commit(3)]);
    expect(
      [
        ...(await store.referencedAt([commit(1), commit(2), commit(3)]))
          .indexed,
      ].sort(),
    ).toEqual([commit(2), commit(3)]);
    const rows = await database.db.execute<{ commit: string }>(
      sql`select commit from asset_reference_commits order by commit`,
    );
    expect(rows.rows.map((row) => row.commit)).toEqual([commit(2), commit(3)]);
  });

  it('clears the whole index', async () => {
    await store.put(commit(1), [hash(1)], [commit(1)]);
    await store.clear();
    expect((await store.referencedAt([commit(1)])).indexed.size).toBe(0);
  });

  it('refuses what is no commit or no hash', async () => {
    await expect(store.put('main', [], [])).rejects.toThrow();
    await expect(store.put(commit(1), ['sha256:x'], [])).rejects.toThrow();
    expect((await store.referencedAt([commit(1)])).indexed.size).toBe(0);
  });
});
