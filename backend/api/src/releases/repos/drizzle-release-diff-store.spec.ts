import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import {
  RELEASE_DIFF_FORMAT,
  type StoredReleaseDiff,
} from '../core/release-changes.js';
import { DrizzleReleaseDiffStore } from './drizzle-release-diff-store.js';
import { releaseDiffs } from './release-diffs.tables.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const diff: StoredReleaseDiff = {
  manuals: [
    [
      'guide',
      {
        before: { audience: 'public', modules: ['intro'] },
        after: { audience: undefined, modules: ['intro'] },
        fields: ['audience'],
      },
    ],
  ],
  modules: [
    [
      'en',
      'intro',
      {
        before: 'unreadable',
        after: undefined,
        fields: [],
        blocks: [{ blockId: 'p1', change: 'removed' }],
      },
    ],
  ],
};

describe('DrizzleReleaseDiffStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleReleaseDiffStore;
  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleReleaseDiffStore(database);
  });
  afterEach(() => database?.close());

  it('keeps a diff per pair of commits, a first release’s too, and reads it back as JSON', async () => {
    await store.keep(BASE, HEAD, diff);
    await store.keep(undefined, HEAD, 'too-many-changes');
    // What JSON keeps of it: no `undefined` members.
    expect(await store.find(BASE, HEAD)).toEqual(
      JSON.parse(JSON.stringify(diff)),
    );
    expect(await store.find(undefined, HEAD)).toBe('too-many-changes');
    expect(await store.find(HEAD, BASE)).toBeUndefined();
  });

  it('keeps a pair once, and reads none of another format, replacing it', async () => {
    await store.keep(BASE, HEAD, diff);
    await store.keep(BASE, HEAD, 'too-many-changes');
    expect(await store.find(BASE, HEAD)).toEqual(
      JSON.parse(JSON.stringify(diff)),
    );
    await database.db
      .update(releaseDiffs)
      .set({ format: RELEASE_DIFF_FORMAT - 1 });
    expect(await store.find(BASE, HEAD)).toBeUndefined();
    await store.keep(BASE, HEAD, 'too-many-changes');
    expect(await store.find(BASE, HEAD)).toBe('too-many-changes');
  });

  it('never fails a read for a diff it could not keep', async () => {
    await database.db.execute(sql`drop table release_diffs`);
    await expect(store.keep(BASE, HEAD, diff)).resolves.toBeUndefined();
  });
});
