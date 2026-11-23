// Its own file: the settings are read once per file (`ConfigModule`).
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { StorageUsageDocument } from '../src/storage-usage/api/storage-usage.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};

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

async function blobCount(t: TestApp): Promise<number> {
  let count = 0;
  let after: string | undefined;
  do {
    const page = await t.blobs.list(after);
    count += page.blobs.length;
    after = page.next;
  } while (after !== undefined);
  return count;
}

describe('storage usage with a limit', () => {
  const LIMIT = 2_000;
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ CCMS_STORAGE_LIMIT_BYTES: String(LIMIT) });
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('recorded the limit at start-up, audited', async () => {
    t.actAs(admin);
    const res = await t.get(
      '/audit-events?filter[action]=storage.limit-change',
    );
    const events = AuditEventPageDocument.parse(res.body).data;
    expect(events.map((e) => e.attributes)).toEqual([
      expect.objectContaining({
        actor: { kind: 'service', id: 'service:storage' },
        subject: { type: 'storage', id: 'instance' },
        data: { from: null, to: LIMIT },
      }),
    ]);
    const data = await usage(t);
    expect(data.attributes.limitBytes).toBe(LIMIT);
    expect(data.meta).toMatchObject({ usedShare: 0, level: 'ok' });
  });

  it('refuses an upload over it with storage-limit-reached, storing nothing, audited', async () => {
    const changeSetId = await newChangeSet(t);
    const fits = await picture('#123', 16);
    expect(fits.byteLength).toBeLessThan(LIMIT);
    expect((await upload(t, changeSetId, fits, 'fits.png')).status).toBe(201);
    const blobs = await blobCount(t);

    const tooMuch = await picture('#fed', 512);
    expect(tooMuch.byteLength).toBeGreaterThan(LIMIT);
    const res = await upload(t, changeSetId, tooMuch, 'big.png');
    expect(res.status).toBe(409);
    const [error] = ErrorDocument.parse(res.body).errors;
    expect(error).toMatchObject({
      code: 'storage-limit-reached',
      meta: { limit: LIMIT },
    });
    expect(error?.detail).toMatch(/storage limit/);
    expect(await blobCount(t)).toBe(blobs);
    const data = await usage(t);
    expect(data.attributes.media).toEqual({ bytes: fits.byteLength, files: 1 });

    t.actAs(admin);
    const audit = await t.get(
      '/audit-events?filter[action]=storage.upload-refused',
    );
    expect(
      AuditEventPageDocument.parse(audit.body).data.map((e) => e.attributes),
    ).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: 'sample-author' },
        subject: { type: 'storage', id: 'instance' },
        data: { changeSetId, limit: LIMIT, used: fits.byteLength },
      }),
    ]);
  });
});
