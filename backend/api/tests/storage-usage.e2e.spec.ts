import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  StorageUsageDocument,
  StoredFilePageDocument,
} from '../src/storage-usage/api/storage-usage.resources.js';
import { StorageRecounter } from '../src/storage-usage/api/storage-recounter.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};
const reader: Actor = actorWith(['content.read', 'content.read.draft']);

const picture = (background: string, size = 64) =>
  sharp({ create: { width: size, height: size, channels: 3, background } })
    .png()
    .toBuffer();

async function newChangeSet(t: TestApp): Promise<string> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Pictures' } },
    }),
  );
  expect(created.status).toBe(201);
  return ChangeSetDocument.parse(created.body).data.id;
}

function upload(t: TestApp, changeSetId: string, file: Buffer, name: string) {
  t.actAs(author);
  return t
    .post(`/change-sets/${changeSetId}/assets`)
    .set('Content-Type', 'multipart/form-data')
    .set(REQUEST_HEADER, '1')
    .attach('file', file, name);
}

async function usage(t: TestApp) {
  t.actAs(admin);
  const res = await t.get('/storage-usage');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(JSON_API);
  return StorageUsageDocument.parse(res.body).data;
}

describe('storage usage without a limit (the default)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('answers the categories for an administrator, unlimited, as JSON:API matching its schema', async () => {
    const data = await usage(t);
    expect(data).toEqual({
      type: 'StorageUsage',
      id: 'instance',
      attributes: {
        media: { bytes: 0, files: 0 },
        archivedPdfs: { bytes: 0, files: 0 },
        gitContent: { bytes: null },
        database: { bytes: null },
        limitBytes: null,
        recountedAt: null,
      },
      meta: { usedBytes: 0, usedShare: null, level: 'unlimited', warnAt: 0.8 },
    });
  });

  it('is 403 for anyone but an administrator', async () => {
    for (const actor of [author, reader]) {
      t.actAs(actor);
      for (const path of ['/storage-usage', '/storage-usage/files']) {
        const res = await t.get(path);
        expect(res.status).toBe(403);
        expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
      }
    }
  });

  it('counts the same bytes uploaded into two change sets at the same time once', async () => {
    const before = (await usage(t)).attributes.media;
    const [one, two] = [await newChangeSet(t), await newChangeSet(t)];
    const same = await picture('#4a7', 48);
    const sent = await Promise.all([
      upload(t, one, same, 'one.png'),
      upload(t, two, same, 'two.png'),
    ]);
    expect(sent.map((res) => res.status)).toEqual([201, 201]);
    expect((await usage(t)).attributes.media).toEqual({
      bytes: before.bytes + same.byteLength,
      files: before.files + 1,
    });
  });

  it('counts uploads as they come, lists the largest files, and a recount sets the totals right', async () => {
    const base = (await usage(t)).attributes.media;
    const changeSetId = await newChangeSet(t);
    const small = await picture('#123', 16);
    const large = await picture('#fed', 256);
    expect((await upload(t, changeSetId, small, 'small.png')).status).toBe(201);
    expect((await upload(t, changeSetId, large, 'large.png')).status).toBe(201);
    // The same bytes again store nothing new.
    expect((await upload(t, changeSetId, large, 'large.png')).status).toBe(200);
    const counted = await usage(t);
    expect(counted.attributes.media).toEqual({
      bytes: base.bytes + small.byteLength + large.byteLength,
      files: base.files + 2,
    });
    expect(counted.meta.level).toBe('unlimited');

    t.actAs(admin);
    const res = await t.get('/storage-usage/files?page[size]=1');
    expect(res.status).toBe(200);
    const files = StoredFilePageDocument.parse(res.body);
    expect(files.meta.page.total).toBe(base.files + 2);
    expect(files.data).toEqual([
      expect.objectContaining({
        type: 'StoredFile',
        attributes: expect.objectContaining({
          size: large.byteLength,
          contentType: 'image/png',
          fileName: 'large.png',
        }),
      }),
    ]);
    expect(files.links.next).toContain('page%5Bnumber%5D=2');

    // A blob no upload records (the old layout's import) takes room too;
    // the recount finds it, and the Git content and database sizes.
    const extra = Buffer.from('a file of the old layout');
    await t.blobs.put(Readable.from([extra]), {
      contentType: 'application/octet-stream',
      maxBytes: 1_000,
    });
    await t.app.get(StorageRecounter).runOnce();
    const recounted = await usage(t);
    expect(recounted.attributes.media).toEqual({
      bytes:
        base.bytes + small.byteLength + large.byteLength + extra.byteLength,
      files: base.files + 3,
    });
    expect(recounted.attributes.recountedAt).not.toBeNull();
    expect(recounted.attributes.gitContent.bytes).toBeGreaterThan(0);
    expect(recounted.attributes.database.bytes).toBeGreaterThan(0);
  });
});
