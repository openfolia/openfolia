import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import { DrizzleChangeSetStore } from '../../change-sets/repos/drizzle-change-set-store.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import type { NewAssetUpload } from '../core/asset-upload.js';
import { DrizzleAssetUploads } from './drizzle-asset-uploads.js';

function changeSet(): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'Images',
    description: null,
    author: { kind: 'user', id: 'sample-author' },
    baseRef: 'main',
    baseCommit: 'c'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

describe('DrizzleAssetUploads', () => {
  let database: PgliteDatabase;
  let uploads: DrizzleAssetUploads;
  let unit: DrizzleUnitOfWork;
  let mine: ChangeSet;
  const upload = (over: Partial<NewAssetUpload> = {}): NewAssetUpload => ({
    changeSetId: mine.id,
    sha256: 'a'.repeat(64),
    size: 1234,
    contentType: 'image/png',
    uploadedBy: { kind: 'user', id: 'sample-author' },
    ...over,
  });

  beforeEach(async () => {
    database = await createTestDatabase();
    uploads = new DrizzleAssetUploads(database);
    unit = new DrizzleUnitOfWork(database);
    mine = changeSet();
    const changeSets = new DrizzleChangeSetStore(database);
    await unit.run((tx) => changeSets.insert(tx, mine));
  });
  afterEach(() => database?.close());
  const uploadedInto = (ids: string[]) => uploads.uploadedInto(ids);

  it('records an upload once per change set and hash', async () => {
    const first = await unit.run((tx) => uploads.record(tx, upload()));
    expect(first).toEqual({
      created: true,
      upload: {
        ...upload(),
        uploadedAt: expect.any(Date),
        lastUploadedAt: first.upload.uploadedAt,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Again, even with other details: the first record stays.
    const again = await unit.run((tx) =>
      uploads.record(tx, upload({ uploadedBy: { kind: 'user', id: 'x' } })),
    );
    // Only the latest upload's time moves, for retention.
    expect(again.created).toBe(false);
    expect(again.upload).toEqual({
      ...first.upload,
      lastUploadedAt: expect.any(Date),
    });
    expect(again.upload.lastUploadedAt.getTime()).toBeGreaterThan(
      first.upload.uploadedAt.getTime(),
    );
    expect(await uploads.find(mine.id, 'a'.repeat(64))).toEqual(again.upload);
    expect(await unit.run((tx) => uploads.count(tx, mine.id))).toBe(1);
    const other = await unit.run((tx) =>
      uploads.record(tx, upload({ sha256: 'b'.repeat(64) })),
    );
    expect(other.created).toBe(true);
  });

  it('tells whether any change set holds a hash, under the hash’s lock', async () => {
    const hash = 'c'.repeat(64);
    expect(
      await unit.run(async (tx) => {
        await uploads.lockHash(tx, hash);
        return uploads.recorded(tx, hash);
      }),
    ).toBe(false);
    await unit.run((tx) => uploads.record(tx, upload({ sha256: hash })));
    expect(await unit.run((tx) => uploads.recorded(tx, hash))).toBe(true);
  });

  it('finds nothing for a key it does not hold, malformed or not', async () => {
    await unit.run((tx) => uploads.record(tx, upload()));
    expect(await uploads.find(mine.id, 'b'.repeat(64))).toBeUndefined();
    expect(
      await uploads.find(newChangeSetId(), 'a'.repeat(64)),
    ).toBeUndefined();
    expect(await uploads.find('nope', 'a'.repeat(64))).toBeUndefined();
    expect(await uploads.find(mine.id, 'nope')).toBeUndefined();
  });

  it('lists a change set’s uploads, last uploaded first', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(64));
    for (const sha256 of [a, b, c]) {
      await unit.run((tx) => uploads.record(tx, upload({ sha256 })));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Uploading `a` again makes it the latest.
    await unit.run((tx) => uploads.record(tx, upload({ sha256: a })));
    expect((await uploads.list(mine.id)).map((u) => u.sha256)).toEqual([
      a,
      c,
      b,
    ]);
    expect(await uploads.list(newChangeSetId())).toEqual([]);
    expect(await uploads.list('nope')).toEqual([]);
  });

  it('lists files, finds an open change set’s uploads, and marks, finds and clears deletions under locks', async () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    await unit.run((tx) => uploads.record(tx, upload({ fileName: 'a.png' })));
    await unit.run((tx) => uploads.record(tx, upload({ sha256: b })));
    expect(
      (await uploads.files()).map((file) => [file.sha256, file.fileName]),
    ).toEqual(
      expect.arrayContaining([
        [a, 'a.png'],
        [b, undefined],
      ]),
    );
    expect((await uploadedInto([mine.id])).sort()).toEqual([a, b]);
    expect(await uploadedInto([newChangeSetId()])).toEqual([]);
    expect(await uploadedInto([])).toEqual([]);
    await unit.run(async (tx) => {
      await uploads.lockHashes(tx, [b, a, b]);
      await uploads.markDeleted(tx, b);
      expect(await uploads.deletedAmong(tx, [a, b])).toEqual([b]);
    });
    await unit.run(async (tx) => {
      await uploads.lockHashes(tx, []);
      await uploads.clearDeleted(tx, b);
      expect(await uploads.deletedAmong(tx, [a, b])).toEqual([]);
    });
  });

  it('tells which hashes a change set an author wrote holds, by the change set’s author', async () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const theirs: ChangeSet = {
      ...changeSet(),
      author: { kind: 'user', id: 'sample-other' },
    };
    await unit.run((tx) =>
      new DrizzleChangeSetStore(database).insert(tx, theirs),
    );
    // Recorded as uploaded by the author, into the other author's change set.
    await unit.run((tx) =>
      uploads.record(tx, upload({ changeSetId: theirs.id })),
    );
    const author = { kind: 'user', id: 'sample-author' } as const;
    expect(await uploads.uploadedForAuthor(author, [a])).toEqual([]);
    expect(
      await uploads.uploadedForAuthor({ kind: 'user', id: 'sample-other' }, [
        a,
      ]),
    ).toEqual([a]);
    await unit.run((tx) => uploads.record(tx, upload()));
    // Each once, sorted, whatever was asked.
    expect(await uploads.uploadedForAuthor(author, [b, a, a])).toEqual([a]);
    expect(
      await uploads.uploadedForAuthor({ kind: 'service', id: author.id }, [a]),
    ).toEqual([]);
    expect(await uploads.uploadedForAuthor(author, [])).toEqual([]);
    expect(
      await uploads.uploadedForAuthor(author, ['A'.repeat(64), 'x']),
    ).toEqual([]);
  });

  it('holds the formats in the database too', async () => {
    for (const bad of [
      upload({ sha256: 'A'.repeat(64) }),
      upload({ size: -1 }),
      upload({ contentType: 'Image/PNG' }),
      upload({ contentType: 'text/html; charset=utf-8' }),
      upload({ fileName: '' }),
      upload({ fileName: 'x'.repeat(256) }),
      upload({ uploadedBy: { kind: 'robot' as never, id: 'x' } }),
      upload({ uploadedBy: { kind: 'user', id: '' } }),
      upload({ changeSetId: newChangeSetId() }),
    ]) {
      await expect(unit.run((tx) => uploads.record(tx, bad))).rejects.toThrow();
    }
    const rows = await database.db.execute(
      sql`select count(*)::int as n from asset_uploads`,
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });
});
