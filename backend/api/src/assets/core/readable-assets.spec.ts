import { Readable } from 'node:stream';
import { actorWith } from '../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../tests/fakes/fake-asset-uploads.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../access/core/actor.js';
import { ReadableAssets, usageOf } from './readable-assets.js';

const importer: Actor = {
  ...actorWith(['admin.roles', 'content.edit', 'content.read']),
  id: 'sample-importer',
};
const OWN_CHANGE_SET = '01900000-0000-7000-8000-000000000001';
const OTHER_CHANGE_SET = '01900000-0000-7000-8000-000000000002';

async function setup() {
  const blobs = new FakeBlobStore();
  const uploads = new FakeAssetUploads();
  const unit = new FakeUnitOfWork();
  const store = async (text: string) =>
    (
      await blobs.put(Readable.from([Buffer.from(text)]), {
        contentType: 'application/octet-stream',
        maxBytes: 1024,
      })
    ).sha256;
  const onBranch = await store('used on the branch');
  const own = await store('uploaded by the importer');
  const others = await store('uploaded by another author');
  const authoredByImporterUploadedByOther = await store(
    'in the importer’s change set',
  );
  const bundle = await store('another import’s bundle');
  const outOfScope = await store('used only outside the scope');
  const record = (changeSetId: string, sha256: string, by: string) =>
    unit.run((tx) =>
      uploads.record(tx, {
        changeSetId,
        sha256,
        size: 1,
        contentType: 'image/png',
        uploadedBy: { kind: 'user', id: by },
      }),
    );
  await record(OWN_CHANGE_SET, own, importer.id);
  await record(OTHER_CHANGE_SET, others, 'sample-other');
  // The change set's author decides, not who the record names.
  uploads.authors.set(OWN_CHANGE_SET, { kind: 'user', id: importer.id });
  uploads.authors.set(OTHER_CHANGE_SET, { kind: 'user', id: 'sample-other' });
  await record(OWN_CHANGE_SET, authoredByImporterUploadedByOther, 'x');
  const usage = new Map([[`sha256:${onBranch}`, []]]);
  const snapshot = { assetUsage: vi.fn(async () => usage) };
  const heads = vi.spyOn(blobs, 'head');
  const readable = new ReadableAssets(uploads);
  const has = readable.storedFor(importer, snapshot, blobs);
  return {
    has: (hash: string) => has.has(`sha256:${hash}`),
    raw: has,
    blobs,
    heads,
    snapshot,
    uploads,
    readable,
    hashes: {
      onBranch,
      own,
      others,
      authoredByImporterUploadedByOther,
      bundle,
      outOfScope,
    },
  };
}

describe('ReadableAssets.storedFor', () => {
  it('takes a stored file used on the branch or uploaded into the importer’s own change set', async () => {
    const t = await setup();
    expect(await t.has(t.hashes.onBranch)).toBe(true);
    expect(await t.has(t.hashes.own)).toBe(true);
    expect(await t.has(t.hashes.authoredByImporterUploadedByOther)).toBe(true);
    // The branch's usage is read once.
    expect(t.snapshot.assetUsage).toHaveBeenCalledTimes(1);
  });

  it('answers a stored file out of scope exactly as a missing one, without asking the store', async () => {
    const t = await setup();
    const missing = 'e'.repeat(64);
    for (const hash of [
      t.hashes.others,
      t.hashes.bundle,
      t.hashes.outOfScope,
      missing,
    ]) {
      expect(await t.has(hash)).toBe(false);
    }
    // Whether these blobs exist was never looked up.
    expect(t.heads).not.toHaveBeenCalled();
  });

  it('never counts another import’s uploaded bundle', async () => {
    const t = await setup();
    // An import's bundle is in the store but in no asset upload record.
    expect(t.blobs.blobs.has(t.hashes.bundle)).toBe(true);
    expect(await t.has(t.hashes.bundle)).toBe(false);
  });

  it('does not take an in-scope reference whose bytes are gone', async () => {
    const t = await setup();
    t.blobs.blobs.delete(t.hashes.own);
    t.blobs.blobs.delete(t.hashes.onBranch);
    expect(await t.has(t.hashes.own)).toBe(false);
    expect(await t.has(t.hashes.onBranch)).toBe(false);
  });

  it('refuses a reference that is not a well-formed hash before any lookup', async () => {
    const t = await setup();
    const spy = vi.spyOn(t.uploads, 'uploadedForAuthor');
    for (const reference of [
      t.hashes.own,
      `sha256:${t.hashes.own.toUpperCase()}`,
      `sha256:${t.hashes.own}x`,
      'sha256:',
      'md5:abc',
    ]) {
      expect(await t.raw.has(reference)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(t.snapshot.assetUsage).not.toHaveBeenCalled();
    expect(t.heads).not.toHaveBeenCalled();
  });
});

describe('ReadableAssets.unreadable', () => {
  it('takes a file used in a place or uploaded into the actor’s own change set, without asking the store', async () => {
    const t = await setup();
    const uploadsAsked = vi.spyOn(t.uploads, 'uploadedForAuthor');
    const elsewhere = 'f'.repeat(64);
    const second = vi.fn(async () => new Map([[`sha256:${elsewhere}`, []]]));
    const missing = 'e'.repeat(64);
    expect(
      await t.readable.unreadable(
        importer,
        [
          t.hashes.own,
          t.hashes.onBranch,
          elsewhere,
          t.hashes.authoredByImporterUploadedByOther,
          t.hashes.others,
          t.hashes.bundle,
          t.hashes.outOfScope,
          missing,
          missing,
        ],
        [usageOf(t.snapshot), second],
      ),
    ).toEqual(
      [t.hashes.others, t.hashes.bundle, t.hashes.outOfScope, missing].sort(),
    );
    // One query for the uploads, each place once, and never the store.
    expect(uploadsAsked).toHaveBeenCalledTimes(1);
    expect(t.snapshot.assetUsage).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(t.heads).not.toHaveBeenCalled();
  });

  it('asks a place only while some hash is left, and skips one the actor may not open', async () => {
    const t = await setup();
    const never = vi.fn(async () => new Map());
    expect(
      await t.readable.unreadable(importer, [t.hashes.own], [never]),
    ).toEqual([]);
    expect(await t.readable.unreadable(importer, [], [never])).toEqual([]);
    expect(never).not.toHaveBeenCalled();
    expect(
      await t.readable.unreadable(
        importer,
        [t.hashes.onBranch],
        [async () => undefined, usageOf(t.snapshot)],
      ),
    ).toEqual([]);
  });

  it('refuses a malformed hash without a lookup', async () => {
    const t = await setup();
    const uploadsAsked = vi.spyOn(t.uploads, 'uploadedForAuthor');
    const place = vi.fn(async () => new Map([['sha256:X', []]]));
    expect(
      await t.readable.unreadable(
        importer,
        ['X', t.hashes.own.toUpperCase()],
        [place],
      ),
    ).toEqual([t.hashes.own.toUpperCase(), 'X'].sort());
    expect(uploadsAsked).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  it('answers every refused file alike: 422 unknown-asset naming them', async () => {
    const t = await setup();
    const missing = 'e'.repeat(64);
    await expect(
      t.readable.refuseUnreadable(
        importer,
        [t.hashes.others, missing, t.hashes.own],
        [usageOf(t.snapshot)],
      ),
    ).rejects.toMatchObject({
      code: 'unknown-asset',
      meta: {
        assets: [t.hashes.others, missing]
          .sort()
          .map((hash) => `sha256:${hash}`),
      },
    });
    await expect(
      t.readable.refuseUnreadable(importer, [t.hashes.own], []),
    ).resolves.toBeUndefined();
  });
});
