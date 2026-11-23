import {
  fakeRenditions,
  RENDITION_SETTINGS,
} from '../../../../tests/fakes/fake-asset-renditions.js';
import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeArchivedFiles } from '../../../../tests/fakes/fake-archived-files.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeHeldBlobs } from '../../../../tests/fakes/fake-held-blobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { fakeQuota } from '../../../../tests/fakes/fake-storage-usage.js';
import type { Actor } from '../../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../../change-sets/core/change-set.js';
import { renamedFont, themeFont } from '../../../../tests/fonts.js';
import {
  MAX_FONTS_PER_CHANGE_SET,
  MAX_UPLOADS_PER_CHANGE_SET,
} from '../asset-upload.js';
import { GetChangeSetAssetAction } from './get-change-set-asset.action.js';
import { UploadAssetAction } from './upload-asset.action.js';

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const EDITING = ['content.read', 'content.edit'] as const;
const author: Actor = { ...actorWith([...EDITING]), id: 'sample-author' };
const other: Actor = { ...author, id: 'sample-other' };
const draftReader: Actor = {
  ...actorWith([...EDITING, 'content.read.draft']),
  id: 'sample-reviewer',
};

function changeSet(by: Actor, over: Partial<ChangeSet> = {}): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'Images',
    description: null,
    author: { kind: by.kind, id: by.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** The file in chunks of `size`, counting how many were read. */
function file(data: Uint8Array, size = 4) {
  const read = { chunks: 0, stopped: false };
  return {
    read,
    file: () =>
      (async function* () {
        try {
          for (let at = 0; at < data.byteLength; at += size) {
            read.chunks++;
            yield data.subarray(at, at + size);
          }
        } finally {
          read.stopped = true;
        }
      })(),
  };
}

function setUp(...changeSets: ChangeSet[]) {
  return setUpWith({}, ...changeSets);
}

function setUpWith(
  { limitBytes = null }: { limitBytes?: number | null },
  ...changeSets: ChangeSet[]
) {
  const store = new FakeChangeSetStore(changeSets);
  const uploads = new FakeAssetUploads();
  const blobs = new FakeBlobStore();
  const auditLog = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const { quota, usage } = fakeQuota({ limitBytes, auditLog, unit });
  const archived = new FakeArchivedFiles();
  const held = new FakeHeldBlobs();
  return {
    store,
    uploads,
    blobs,
    auditLog,
    usage,
    archived,
    held,
    upload: new UploadAssetAction(
      store,
      uploads,
      blobs,
      auditLog,
      unit,
      quota,
      archived,
      held,
    ),
    preview: new GetChangeSetAssetAction(
      store,
      uploads,
      blobs,
      fakeRenditions(blobs, { uploads }).service,
      RENDITION_SETTINGS,
    ),
  };
}

describe('UploadAssetAction', () => {
  it('stores a PNG in the blob store and records it, with an audit event', async () => {
    const mine = changeSet(author);
    const { upload, blobs, uploads, auditLog } = setUp(mine);
    const result = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      ...file(PNG),
    });
    const hash = sha256(PNG);
    expect(result).toEqual({
      created: true,
      upload: {
        changeSetId: mine.id,
        sha256: hash,
        size: PNG.byteLength,
        contentType: 'image/png',
        uploadedBy: { kind: 'user', id: 'sample-author' },
        uploadedAt: expect.any(Date),
        lastUploadedAt: expect.any(Date),
      },
    });
    expect(blobs.blobs.get(hash)).toEqual({
      data: PNG,
      contentType: 'image/png',
      storedAt: expect.any(Date),
    });
    expect(uploads.uploads).toEqual([result.upload]);
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        action: 'asset.upload',
        actor: { kind: 'user', id: 'sample-author' },
        subject: { type: 'asset', id: hash },
        data: {
          changeSetId: mine.id,
          size: PNG.byteLength,
          contentType: 'image/png',
        },
      }),
    ]);
  });

  it('takes the same image again as it is: no new record, no new event', async () => {
    const mine = changeSet(author);
    const { upload, blobs, uploads, auditLog } = setUp(mine);
    const input = { actor: author, changeSetId: mine.id, maxBytes: 1024 };
    const first = await upload.handle({ ...input, ...file(JPEG) });
    const again = await upload.handle({ ...input, ...file(JPEG, 7) });
    expect(first.created).toBe(true);
    expect(again).toEqual({
      created: false,
      upload: { ...first.upload, lastUploadedAt: expect.any(Date) },
    });
    expect(first.upload.contentType).toBe('image/jpeg');
    expect(blobs.blobs.size).toBe(1);
    expect(uploads.uploads).toHaveLength(1);
    expect(auditLog.events).toHaveLength(1);
  });

  it('records the same image once per change set', async () => {
    const mine = changeSet(author);
    const also = changeSet(author);
    const { upload, blobs, uploads } = setUp(mine, also);
    for (const changeSetId of [mine.id, also.id]) {
      const result = await upload.handle({
        actor: author,
        changeSetId,
        maxBytes: 1024,
        ...file(PNG),
      });
      expect(result.created).toBe(true);
    }
    expect(blobs.blobs.size).toBe(1);
    expect(uploads.uploads.map((u) => u.changeSetId)).toEqual([
      mine.id,
      also.id,
    ]);
  });

  it.each([
    ['an SVG with a script', SVG],
    ['text', Buffer.from('just some text, no image at all')],
    ['an empty file', Buffer.alloc(0)],
    // FF D8 FF without a marker that opens a JPEG segment.
    [
      'three JPEG bytes on something else',
      Buffer.from('\xff\xd8\xff<html>', 'latin1'),
    ],
    ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    // The signature without the IHDR chunk every PNG starts with.
    [
      'a PNG signature on something else',
      Buffer.concat([PNG.subarray(0, 8), Buffer.from('<html><script>')]),
    ],
  ])('refuses %s, stores nothing and stops reading', async (_, data) => {
    const mine = changeSet(author);
    const { upload, blobs, uploads, auditLog } = setUp(mine);
    const source = file(Buffer.concat([data, Buffer.alloc(4096)]));
    const refused = upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1 << 20,
      ...source,
    });
    await expect(refused).rejects.toThrow(UnprocessableError);
    await expect(refused).rejects.toMatchObject({
      code: 'unsupported-image-type',
      meta: { accepted: ['image/png', 'image/jpeg'] },
    });
    expect(source.read.chunks).toBeLessThanOrEqual(4);
    expect(source.read.stopped).toBe(true);
    expect(blobs.blobs.size).toBe(0);
    expect(uploads.uploads).toEqual([]);
    expect(auditLog.events).toEqual([]);
  });

  it('refuses a file larger than the limit, having read only just past it', async () => {
    const mine = changeSet(author);
    const { upload, blobs, uploads, auditLog } = setUp(mine);
    const big = Buffer.concat([PNG, Buffer.alloc(1000)]);
    const source = file(big, 10);
    const refused = upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 100,
      ...source,
    });
    await expect(refused).rejects.toMatchObject({
      code: 'too-large',
      meta: { max: 100 },
    });
    expect(source.read.chunks).toBe(11);
    expect(source.read.stopped).toBe(true);
    expect(blobs.blobs.size).toBe(0);
    expect(uploads.uploads).toEqual([]);
    expect(auditLog.events).toEqual([]);
  });

  /** The change set holding `n` images already (records only). */
  /** Records images `from` to `to - 1` (distinct hashes) into the change set. */
  function filled(
    uploads: FakeAssetUploads,
    changeSetId: string,
    to: number,
    from = 0,
  ) {
    for (let i = from; i < to; i++) {
      uploads.uploads.push({
        changeSetId,
        sha256: i.toString(16).padStart(64, '0'),
        size: 1,
        contentType: 'image/png',
        uploadedBy: { kind: 'user', id: 'sample-author' },
        uploadedAt: new Date(),
        lastUploadedAt: new Date(),
      });
    }
  }

  it('refuses any image into a full change set without reading or storing it', async () => {
    const mine = changeSet(author);
    const { upload, uploads, blobs } = setUp(mine);
    filled(uploads, mine.id, MAX_UPLOADS_PER_CHANGE_SET);
    const source = file(PNG);
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        ...source,
      }),
    ).rejects.toMatchObject({
      code: 'too-many-uploads',
      meta: { max: MAX_UPLOADS_PER_CHANGE_SET },
    });
    expect(source.read.chunks).toBe(0);
    expect(blobs.created).toEqual([]);
  });

  it('rolls back the one past the cap that came in at the same time, and removes its blob', async () => {
    const mine = changeSet(author);
    const { upload, uploads, blobs, auditLog } = setUp(mine);
    filled(uploads, mine.id, MAX_UPLOADS_PER_CHANGE_SET - 1);
    const refused = upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      file: () =>
        (async function* () {
          yield PNG.subarray(0, 20);
          // Another upload took the last place meanwhile.
          filled(
            uploads,
            mine.id,
            MAX_UPLOADS_PER_CHANGE_SET,
            MAX_UPLOADS_PER_CHANGE_SET - 1,
          );
          yield PNG.subarray(20);
        })(),
    });
    await expect(refused).rejects.toMatchObject({ code: 'too-many-uploads' });
    expect(uploads.uploads.some((u) => u.sha256 === sha256(PNG))).toBe(false);
    expect(auditLog.events).toEqual([]);
    expect(blobs.created).toEqual([sha256(PNG)]);
    expect(blobs.blobs.size).toBe(0);
  });

  it('takes a file of exactly the limit', async () => {
    const mine = changeSet(author);
    const { upload } = setUp(mine);
    const result = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: PNG.byteLength,
      ...file(PNG),
    });
    expect(result.upload.size).toBe(PNG.byteLength);
  });

  describe('refuses before reading a byte', () => {
    const refusals: [string, Actor, new (message: string) => Error][] = [
      [
        'an actor without content.edit',
        { ...actorWith(['content.read']), id: 'sample-author' },
        ForbiddenError,
      ],
      [
        'another author, for an actor who may not read drafts',
        other,
        NotFoundError,
      ],
      ['another author, for a reader of drafts', draftReader, ForbiddenError],
    ];
    it.each(refusals)('%s', async (_, actor, error) => {
      const mine = changeSet(author);
      const { upload } = setUp(mine);
      const source = file(PNG);
      await expect(
        upload.handle({
          actor,
          changeSetId: mine.id,
          maxBytes: 1024,
          ...source,
        }),
      ).rejects.toThrow(error);
      expect(source.read.chunks).toBe(0);
    });

    it('a change set that does not exist, malformed ID or not', async () => {
      const { upload } = setUp();
      for (const changeSetId of [newChangeSetId(), 'nope']) {
        const source = file(PNG);
        await expect(
          upload.handle({
            actor: author,
            changeSetId,
            maxBytes: 1024,
            ...source,
          }),
        ).rejects.toThrow(NotFoundError);
        expect(source.read.chunks).toBe(0);
      }
    });

    it.each(['in-review', 'approved', 'merged', 'abandoned'] as const)(
      'a change set that is %s',
      async (state) => {
        const closed = changeSet(author, { state });
        const { upload } = setUp(closed);
        const source = file(PNG);
        const refused = upload.handle({
          actor: author,
          changeSetId: closed.id,
          maxBytes: 1024,
          ...source,
        });
        await expect(refused).rejects.toThrow(ConflictError);
        await expect(refused).rejects.toMatchObject({
          code: 'invalid-state',
          meta: { state },
        });
        expect(source.read.chunks).toBe(0);
      },
    );
  });

  it('records nothing when the change set stopped being a draft while the bytes came', async () => {
    const mine = changeSet(author);
    const { upload, store, uploads, auditLog, blobs } = setUp(mine);
    const data = PNG;
    const refused = upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      file: () =>
        (async function* () {
          yield data.subarray(0, 20);
          // Abandoned meanwhile.
          store.changeSets[0] = { ...mine, state: 'abandoned' };
          yield data.subarray(20);
        })(),
    });
    await expect(refused).rejects.toMatchObject({ code: 'invalid-state' });
    expect(uploads.uploads).toEqual([]);
    expect(auditLog.events).toEqual([]);
    // The blob this upload stored goes again.
    expect(blobs.blobs.size).toBe(0);
  });

  it('keeps a blob it did not store, or one another upload recorded meanwhile', async () => {
    const mine = changeSet(author);
    const theirs = changeSet(other);
    const { upload, store, uploads, blobs } = setUp(mine, theirs);
    // There before (another change set's, or content's): a no-op put.
    await blobs.put(
      (async function* () {
        yield JPEG;
      })(),
      { contentType: 'image/jpeg', maxBytes: 1024 },
    );
    const abandoning = (data: Buffer, during?: () => void) => () =>
      (async function* () {
        yield data.subarray(0, 20);
        store.changeSets[0] = { ...mine, state: 'abandoned' };
        during?.();
        yield data.subarray(20);
      })();
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        file: abandoning(JPEG),
      }),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(blobs.blobs.has(sha256(JPEG))).toBe(true);

    // Stored by this upload, but recorded by another change set's meanwhile.
    store.changeSets[0] = mine;
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        file: abandoning(PNG, () =>
          uploads.uploads.push({
            changeSetId: theirs.id,
            sha256: sha256(PNG),
            size: PNG.byteLength,
            contentType: 'image/png',
            uploadedBy: { kind: 'user', id: other.id },
            uploadedAt: new Date(),
            lastUploadedAt: new Date(),
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(blobs.blobs.has(sha256(PNG))).toBe(true);
    expect(uploads.lockedHashes).toContain(sha256(PNG));
  });

  it('keeps a blob a done release output or a holder took on meanwhile (#602)', async () => {
    const mine = changeSet(author);
    const { upload, store, blobs, archived, held } = setUp(mine);
    // Stored by this upload; meanwhile a render of exactly these bytes
    // finds them there and records its output `done` (or an import or the
    // branding takes them); then this upload's record is refused.
    const refusedWhile = (data: Buffer, during: () => void) =>
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        file: () =>
          (async function* () {
            yield data.subarray(0, 20);
            store.changeSets[0] = { ...mine, state: 'abandoned' };
            during();
            yield data.subarray(20);
          })(),
      });
    await expect(
      refusedWhile(PNG, () => archived.files.add(sha256(PNG))),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(blobs.created).toContain(sha256(PNG));
    expect(blobs.blobs.has(sha256(PNG))).toBe(true);

    store.changeSets[0] = mine;
    await expect(
      refusedWhile(JPEG, () => held.branding.add(sha256(JPEG))),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(blobs.created).toContain(sha256(JPEG));
    expect(blobs.blobs.has(sha256(JPEG))).toBe(true);

    const zip = Buffer.concat([PNG, Buffer.from('an import bundle')]);
    store.changeSets[0] = mine;
    await expect(
      refusedWhile(zip, () => held.hashes.add(sha256(zip))),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(blobs.created).toContain(sha256(zip));
    expect(blobs.blobs.has(sha256(zip))).toBe(true);
  });

  it('refuses to record an image whose blob went meanwhile', async () => {
    const mine = changeSet(author);
    const { upload, uploads, blobs } = setUp(mine);
    const lock = uploads.lockHash.bind(uploads);
    // Removed between storing and recording (another upload's clean-up).
    uploads.lockHash = async (tx, hash) => {
      blobs.blobs.delete(hash);
      return lock(tx, hash);
    };
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        ...file(PNG),
      }),
    ).rejects.toMatchObject({ code: 'upload-interrupted' });
    expect(uploads.uploads).toEqual([]);
  });

  it('answers with the refusal even when the clean-up fails', async () => {
    const mine = changeSet(author);
    const { upload, uploads, blobs } = setUp(mine);
    filled(uploads, mine.id, MAX_UPLOADS_PER_CHANGE_SET - 1);
    const refused = upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      file: () =>
        (async function* () {
          yield PNG.subarray(0, 20);
          filled(
            uploads,
            mine.id,
            MAX_UPLOADS_PER_CHANGE_SET,
            MAX_UPLOADS_PER_CHANGE_SET - 1,
          );
          yield PNG.subarray(20);
        })(),
    });
    // The store goes down once the blob is stored: its removal fails.
    const recorded = uploads.recorded.bind(uploads);
    uploads.recorded = async (tx, hash) => {
      blobs.down = true;
      return recorded(tx, hash);
    };
    await expect(refused).rejects.toMatchObject({ code: 'too-many-uploads' });
    expect(blobs.blobs.has(sha256(PNG))).toBe(true);
  });
});

describe('UploadAssetAction, the storage used (#404)', () => {
  const input = (id: string) => ({
    actor: author,
    changeSetId: id,
    maxBytes: 1024,
  });

  it('counts new bytes towards the media, and the same bytes again not', async () => {
    const mine = changeSet(author);
    const theirs = changeSet(author);
    const { upload, usage } = setUp(mine, theirs);
    await upload.handle({ ...input(mine.id), ...file(PNG) });
    await upload.handle({ ...input(mine.id), ...file(PNG) });
    // Into another change set: the blob is stored once.
    await upload.handle({ ...input(theirs.id), ...file(PNG) });
    expect(usage.totals.media).toEqual({ bytes: PNG.byteLength, files: 1 });
    await upload.handle({ ...input(mine.id), ...file(JPEG) });
    expect(usage.totals.media).toEqual({
      bytes: PNG.byteLength + JPEG.byteLength,
      files: 2,
    });
  });

  it('counts bytes a put found stored, when no upload records them yet', async () => {
    const mine = changeSet(author);
    const { upload, usage, blobs } = setUpWith({ limitBytes: 1_000 }, mine);
    // The same bytes stored without an upload record (a put whose upload
    // was refused, its blob not yet removed): still counted, and limited.
    usage.totals = { ...usage.totals, media: { bytes: 995, files: 1 } };
    const put = blobs.put.bind(blobs);
    blobs.put = async (...args) => ({
      ...(await put(...args)),
      created: false,
    });
    await expect(
      upload.handle({ ...input(mine.id), ...file(PNG) }),
    ).rejects.toMatchObject({ code: 'storage-limit-reached' });
    expect(usage.totals.media).toEqual({ bytes: 995, files: 1 });
  });

  it('does not count as media an upload of bytes an archived release PDF holds', async () => {
    const mine = changeSet(author);
    const { upload, usage, blobs } = setUpWith(
      { limitBytes: 2 * PNG.byteLength },
      mine,
    );
    // Archived first (a release's file), counted as a PDF; the upload of the
    // same bytes takes no more room and is not counted twice.
    await blobs.put(
      (async function* () {
        yield PNG;
      })(),
      { contentType: 'image/png', maxBytes: 1024 },
    );
    usage.apart.set(sha256(PNG), 'pdf');
    usage.totals = {
      ...usage.totals,
      pdfs: { bytes: PNG.byteLength, files: 1 },
    };
    await expect(
      upload.handle({ ...input(mine.id), ...file(PNG) }),
    ).resolves.toMatchObject({ created: true });
    expect(usage.totals.media).toEqual({ bytes: 0, files: 0 });
    expect(usage.totals.pdfs).toEqual({ bytes: PNG.byteLength, files: 1 });
  });

  it('refuses nothing without a limit, however much is used', async () => {
    const mine = changeSet(author);
    const { upload, usage } = setUp(mine);
    usage.totals = {
      ...usage.totals,
      media: { bytes: Number.MAX_SAFE_INTEGER - 1_000, files: 1 },
    };
    await expect(
      upload.handle({ ...input(mine.id), ...file(PNG) }),
    ).resolves.toMatchObject({ created: true });
  });

  it('refuses an upload past the limit with storage-limit-reached: nothing stored, the refusal audited', async () => {
    const mine = changeSet(author);
    const { upload, usage, blobs, uploads, auditLog } = setUpWith(
      { limitBytes: 1_000 },
      mine,
    );
    usage.totals = { ...usage.totals, pdfs: { bytes: 990, files: 1 } };
    const error = await upload
      .handle({ ...input(mine.id), ...file(PNG) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: 'storage-limit-reached',
      meta: { limit: 1_000 },
      used: 990,
    });
    expect(blobs.blobs.size).toBe(0);
    expect(uploads.uploads).toEqual([]);
    expect(usage.totals.media).toEqual({ bytes: 0, files: 0 });
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        action: 'storage.upload-refused',
        actor: { kind: 'user', id: 'sample-author' },
        subject: { type: 'storage', id: 'instance' },
        data: { changeSetId: mine.id, limit: 1_000, used: 990 },
      }),
    ]);
  });

  it('refuses before reading a byte once the limit is reached', async () => {
    const mine = changeSet(author);
    const { upload, usage } = setUpWith({ limitBytes: 1_000 }, mine);
    usage.totals = { ...usage.totals, media: { bytes: 1_000, files: 3 } };
    const sent = file(PNG);
    await expect(
      upload.handle({ ...input(mine.id), ...sent }),
    ).rejects.toMatchObject({ code: 'storage-limit-reached' });
    expect(sent.read.chunks).toBe(0);
  });

  it('caps what is read at the room left: a larger file is refused as the limit', async () => {
    const mine = changeSet(author);
    const { upload, usage, blobs } = setUpWith({ limitBytes: 1_000 }, mine);
    usage.totals = { ...usage.totals, media: { bytes: 995, files: 1 } };
    await expect(
      upload.handle({ ...input(mine.id), ...file(JPEG) }),
    ).rejects.toMatchObject({
      code: 'storage-limit-reached',
      meta: { limit: 1_000 },
      used: 995,
    });
    expect(blobs.blobs.size).toBe(0);
  });

  it('refuses an upload counted past the limit in its transaction (another took the room meanwhile), and removes its blob', async () => {
    const mine = changeSet(author);
    const { upload, usage, blobs, uploads } = setUpWith(
      { limitBytes: PNG.byteLength + JPEG.byteLength },
      mine,
    );
    await upload.handle({ ...input(mine.id), ...file(PNG) });
    expect(usage.totals.media.bytes).toBe(PNG.byteLength);
    // Another upload is counted after the room was read, before this one records.
    const put = blobs.put.bind(blobs);
    blobs.put = async (...args) => {
      const stored = await put(...args);
      usage.totals = {
        ...usage.totals,
        media: { bytes: PNG.byteLength + 10, files: 2 },
      };
      return stored;
    };
    await expect(
      upload.handle({ ...input(mine.id), ...file(JPEG) }),
    ).rejects.toMatchObject({ code: 'storage-limit-reached' });
    expect(blobs.blobs.has(sha256(JPEG))).toBe(false);
    expect(uploads.uploads.map((u) => u.sha256)).toEqual([sha256(PNG)]);
    expect(usage.totals.media.bytes).toBe(PNG.byteLength + 10);
  });
});

describe('GetChangeSetAssetAction', () => {
  async function uploaded() {
    const mine = changeSet(author);
    const theirs = changeSet(other);
    const set = setUp(mine, theirs);
    await set.upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      ...file(PNG),
    });
    return { ...set, mine, theirs };
  }

  it('gives the author an image uploaded into their change set', async () => {
    const { preview, mine } = await uploaded();
    const asset = await preview.handle({
      actor: author,
      changeSetId: mine.id,
      hash: sha256(PNG),
    });
    expect(asset.type).toBe('image/png');
    expect(asset.size).toBe(PNG.byteLength);
    expect(await buffer(asset.stream)).toEqual(PNG);
  });

  it('finds nothing else: another change set’s, one not uploaded, a malformed hash', async () => {
    const { preview, mine, theirs, blobs } = await uploaded();
    // In the store, but not uploaded into this change set.
    const elsewhere = await blobs.put(
      (async function* () {
        yield JPEG;
      })(),
      { contentType: 'image/jpeg', maxBytes: 1024 },
    );
    for (const [actor, changeSetId, hash] of [
      [author, mine.id, elsewhere.sha256],
      [author, mine.id, 'f'.repeat(64)],
      [author, mine.id, 'not-a-hash'],
      [other, theirs.id, sha256(PNG)],
    ] as const) {
      await expect(
        preview.handle({ actor, changeSetId, hash }),
      ).rejects.toThrow(NotFoundError);
    }
  });

  it('is the author’s only: 403 for a reader of drafts, 404 for anyone else', async () => {
    const { preview, mine } = await uploaded();
    const hash = sha256(PNG);
    await expect(
      preview.handle({ actor: draftReader, changeSetId: mine.id, hash }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      preview.handle({ actor: other, changeSetId: mine.id, hash }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      preview.handle({ actor: actorWith([]), changeSetId: mine.id, hash }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('UploadAssetAction, attachments', () => {
  const ZIP = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(60, 1),
  ]);
  const JSON_SAMPLE = Buffer.from('{"speed": 1.2, "mode": "auto"}\n');
  const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

  const attach = (
    data: Uint8Array,
    name: string | undefined,
    over: Partial<Parameters<UploadAssetAction['handle']>[0]> = {},
  ) => ({
    kind: 'attachment' as const,
    maxBytes: 1024,
    fileName: () => name,
    ...file(data),
    ...over,
  });

  it('stores a ZIP and a JSON file with their type and file name, audited', async () => {
    const mine = changeSet(author);
    const { upload, blobs, uploads, auditLog } = setUp(mine);
    const zip = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(ZIP, 'C:\\temp\\config v2.zip'),
    });
    expect(zip.upload).toMatchObject({
      contentType: 'application/zip',
      fileName: 'config v2.zip',
      size: ZIP.byteLength,
    });
    const json = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(JSON_SAMPLE, 'sample.json'),
    });
    expect(json.upload).toMatchObject({
      contentType: 'application/json',
      fileName: 'sample.json',
    });
    expect(blobs.blobs.get(sha256(JSON_SAMPLE))?.contentType).toBe(
      'application/json',
    );
    expect(uploads.uploads).toHaveLength(2);
    expect(auditLog.events[1]).toMatchObject({
      data: { contentType: 'application/json', fileName: 'sample.json' },
    });
  });

  it('takes a file without a name, as octet-stream unless its bytes say more', async () => {
    const mine = changeSet(author);
    const { upload } = setUp(mine);
    const result = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(Buffer.from([0, 1, 2, 3, 4]), '..'),
    });
    expect(result.upload.contentType).toBe('application/octet-stream');
    expect(result.upload).not.toHaveProperty('fileName');
  });

  it('refuses HTML and SVG by default before storing a byte, whatever the name', async () => {
    const mine = changeSet(author);
    const { upload, blobs, uploads } = setUp(mine);
    for (const [data, name, type, reason] of [
      [HTML, 'page.html', 'text/html', 'dangerous'],
      [HTML, 'innocent.json', 'text/html', 'mismatch'],
      [SVG, 'logo.svg', 'image/svg+xml', 'dangerous'],
    ] as const) {
      const sent = attach(data, name);
      const error = await upload
        .handle({ actor: author, changeSetId: mine.id, ...sent })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableError);
      expect(error).toMatchObject({
        code: 'unsupported-attachment-type',
        meta: { contentType: type, reason },
      });
      expect(sent.read.stopped).toBe(true);
    }
    expect(blobs.blobs.size).toBe(0);
    expect(uploads.uploads).toEqual([]);
  });

  it('takes HTML only when the settings open it', async () => {
    const mine = changeSet(author);
    const { upload } = setUp(mine);
    const result = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(HTML, 'page.html', {
        attachmentTypes: {
          deny: [],
          open: [{ kind: 'type', type: 'text/html' }],
        },
      }),
    });
    expect(result.upload.contentType).toBe('text/html');
  });

  it('applies the allow and deny lists', async () => {
    const mine = changeSet(author);
    const { upload } = setUp(mine);
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        ...attach(JSON_SAMPLE, 'sample.json', {
          attachmentTypes: {
            allow: [{ kind: 'extension', extension: '.zip' }],
            deny: [],
            open: [],
          },
        }),
      }),
    ).rejects.toMatchObject({ meta: { reason: 'not-allowed' } });
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        ...attach(ZIP, 'a.zip', {
          attachmentTypes: {
            deny: [{ kind: 'family', top: 'application' }],
            open: [],
          },
        }),
      }),
    ).rejects.toMatchObject({ meta: { reason: 'denied', extension: '.zip' } });
  });

  it('keeps an image upload image-only: a ZIP is still refused there', async () => {
    const mine = changeSet(author);
    const { upload } = setUp(mine);
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        maxBytes: 1024,
        fileName: () => 'a.zip',
        ...file(ZIP),
      }),
    ).rejects.toMatchObject({ code: 'unsupported-image-type' });
  });

  it('refuses a file over its size limit, storing nothing', async () => {
    const mine = changeSet(author);
    const { upload, blobs } = setUp(mine);
    await expect(
      upload.handle({
        actor: author,
        changeSetId: mine.id,
        ...attach(ZIP, 'a.zip', { maxBytes: 10 }),
      }),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(blobs.blobs.size).toBe(0);
  });

  it('answers the same bytes again with the type they were stored with', async () => {
    const mine = changeSet(author);
    const also = changeSet(author);
    const { upload } = setUp(mine, also);
    const notes = Buffer.from('a;b\n1;2\n');
    const first = await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(notes, 'notes.txt'),
    });
    expect(first.upload.contentType).toBe('text/plain');
    const again = await upload.handle({
      actor: author,
      changeSetId: also.id,
      ...attach(notes, 'table.csv'),
    });
    expect(again.upload.contentType).toBe('text/plain');
  });

  it('previews an attachment upload as a download under its name', async () => {
    const mine = changeSet(author);
    const { upload, preview } = setUp(mine);
    await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(ZIP, 'config.zip'),
    });
    const asset = await preview.handle({
      actor: author,
      changeSetId: mine.id,
      hash: sha256(ZIP),
    });
    expect(asset.download).toEqual({ fileName: 'config.zip' });
    asset.stream.destroy();
    await upload.handle({
      actor: author,
      changeSetId: mine.id,
      maxBytes: 1024,
      ...file(PNG),
    });
    const image = await preview.handle({
      actor: author,
      changeSetId: mine.id,
      hash: sha256(PNG),
    });
    expect(image.download).toBeUndefined();
    expect(await buffer(image.stream)).toEqual(PNG);
  });

  it('previews an upload under the hash when its name no longer fits the stored type', async () => {
    const mine = changeSet(author);
    const { upload, preview, uploads } = setUp(mine);
    const notes = Buffer.from('MsgBox 1');
    await upload.handle({
      actor: author,
      changeSetId: mine.id,
      ...attach(notes, 'notes.txt'),
    });
    // As an upload recorded under a rule since tightened, or kept with an
    // earlier upload's type, would hold it.
    const index = uploads.uploads.findIndex((u) => u.sha256 === sha256(notes));
    uploads.uploads[index] = {
      ...uploads.uploads[index]!,
      fileName: 'notes.vbs',
    };
    const asset = await preview.handle({
      actor: author,
      changeSetId: mine.id,
      hash: sha256(notes),
    });
    expect(asset.download).toEqual({});
    asset.stream.destroy();
  });

  describe('a font (#555)', () => {
    const TTF = Buffer.from(themeFont('ttf/Geist-Regular.ttf'));
    const WOFF2 = Buffer.from(themeFont('Geist-Variable.woff2'));

    it('stores a TrueType or WOFF2 font as the font it is, whatever its name says', async () => {
      const mine = changeSet(author);
      const { upload, blobs, auditLog } = setUp(mine);
      const input = {
        actor: author,
        changeSetId: mine.id,
        kind: 'font' as const,
        maxBytes: 1024 * 1024,
        fileName: () => 'picture.png',
      };
      const ttf = await upload.handle({ ...input, ...file(TTF, 4096) });
      const woff2 = await upload.handle({ ...input, ...file(WOFF2, 4096) });
      expect(ttf.upload.contentType).toBe('font/ttf');
      expect(woff2.upload.contentType).toBe('font/woff2');
      expect(blobs.blobs.get(sha256(TTF))?.contentType).toBe('font/ttf');
      expect(auditLog.events.map((e) => e.data['contentType'])).toEqual([
        'font/ttf',
        'font/woff2',
      ]);
    });

    it('refuses what is no font, or a malformed one, before anything is stored', async () => {
      const mine = changeSet(author);
      const { upload, blobs, uploads } = setUp(mine);
      for (const [data, reason] of [
        [PNG, 'not-a-font'],
        [TTF.subarray(0, 2000), 'malformed'],
      ] as const) {
        const refused = await upload
          .handle({
            actor: author,
            changeSetId: mine.id,
            kind: 'font',
            maxBytes: 1024 * 1024,
            ...file(data, 512),
          })
          .catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(UnprocessableError);
        expect(refused).toMatchObject({
          code: 'unsupported-font-type',
          meta: { reason },
        });
      }
      expect(blobs.blobs.size).toBe(0);
      expect(uploads.uploads).toEqual([]);
    });

    it('refuses a font over the limit, reading at most one byte past it', async () => {
      const mine = changeSet(author);
      const { upload, blobs } = setUp(mine);
      const { read, file: big } = file(TTF, 1000);
      await expect(
        upload.handle({
          actor: author,
          changeSetId: mine.id,
          kind: 'font',
          maxBytes: 10_000,
          file: big,
        }),
      ).rejects.toMatchObject({ code: 'too-large', meta: { max: 10_000 } });
      expect(read.chunks).toBe(11);
      expect(read.stopped).toBe(true);
      expect(blobs.blobs.size).toBe(0);
    });

    it('takes at most MAX_FONTS_PER_CHANGE_SET fonts into a change set', async () => {
      const mine = changeSet(author);
      const { upload, uploads } = setUp(mine);
      for (let i = 0; i < MAX_FONTS_PER_CHANGE_SET; i++) {
        uploads.uploads.push({
          changeSetId: mine.id,
          sha256: i.toString(16).padStart(64, '0'),
          size: 1,
          contentType: 'font/ttf',
          uploadedBy: { kind: 'user', id: author.id },
          uploadedAt: new Date(),
          lastUploadedAt: new Date(),
        });
      }
      const another = Buffer.from(renamedFont(TTF, 'Another Sans'));
      const refused = await upload
        .handle({
          actor: author,
          changeSetId: mine.id,
          kind: 'font',
          maxBytes: 1024 * 1024,
          ...file(another, 4096),
        })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictError);
      expect(refused).toMatchObject({
        code: 'too-many-uploads',
        meta: { max: MAX_FONTS_PER_CHANGE_SET },
      });
      // An image still goes in: the cap is the fonts'.
      expect(
        (
          await upload.handle({
            actor: author,
            changeSetId: mine.id,
            maxBytes: 1024,
            ...file(PNG),
          })
        ).created,
      ).toBe(true);
    });
  });
});
