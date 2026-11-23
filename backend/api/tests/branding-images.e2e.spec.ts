import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { AssetReferences } from '../src/assets/core/asset-references.js';
import { AssetUploads } from '../src/assets/core/asset-uploads.js';
import { DeleteAssetAction } from '../src/assets/core/actions/delete-asset.action.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import {
  BrandingImageDocument,
  BrandingImagePageDocument,
} from '../src/branding/api/branding.resources.js';
import { SweepBrandingImagesAction } from '../src/branding/core/actions/sweep-branding-images.action.js';
import { brandingImages } from '../src/branding/repos/branding.tables.js';
import { BOUNDED, UnitOfWork } from '../src/base/core/unit-of-work.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { StorageUsageDocument } from '../src/storage-usage/api/storage-usage.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const brander: Actor = {
  ...actorWith(['admin.branding']),
  id: 'sample-brander',
};
const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
const librarian: Actor = {
  ...actorWith(['content.read', 'content.edit', 'content.read.draft']),
  id: 'sample-librarian',
};
const DAY = 24 * 60 * 60 * 1000;

/** A 1 × 1 PNG of its own colour per `n`: a different file each. */
const pixel = (n: number) =>
  sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: {
        r: n & 0xff,
        g: (n >> 8) & 0xff,
        b: (n >> 16) & 0xff,
      },
    },
  })
    .png()
    .toBuffer();

function upload(t: TestApp, file: Buffer) {
  t.actAs(brander);
  return t
    .post('/branding/images')
    .set('Content-Type', 'multipart/form-data')
    .set(REQUEST_HEADER, '1')
    .attach('file', file, 'logo.png');
}

async function uploaded(t: TestApp, file: Buffer): Promise<string> {
  const res = await upload(t, file);
  expect([200, 201]).toContain(res.status);
  return BrandingImageDocument.parse(res.body).data.id;
}

function patch(t: TestApp, attributes: Record<string, unknown>) {
  t.actAs(brander);
  return t.patch('/branding').send(
    JSON.stringify({
      data: { type: 'Branding', id: 'branding', attributes },
    }),
  );
}

function remove(t: TestApp, hash: string) {
  t.actAs(brander);
  return t.delete(`/branding/images/${hash}`);
}

async function media(t: TestApp) {
  t.actAs(admin);
  const res = await t.get('/storage-usage');
  expect(res.status).toBe(200);
  return StorageUsageDocument.parse(res.body).data.attributes.media;
}

/** Every recorded branding image whose bytes are gone: none may be. */
async function recordedWithoutBytes(t: TestApp): Promise<string[]> {
  const rows = await t.database.db.select().from(brandingImages);
  const missing: string[] = [];
  for (const row of rows) {
    if (!(await t.blobs.exists(row.sha256))) missing.push(row.sha256);
  }
  return missing;
}

// One app per file: the settings are read once per file (`ConfigModule`).
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => {
  t?.actAs(undefined);
  vi.restoreAllMocks();
});

describe('branding uploads: deleting unused ones (#559)', () => {
  it('lists the uploads with the fields using each, to holders of admin.branding only', async () => {
    const used = await uploaded(t, await pixel(1));
    const unused = await uploaded(t, await pixel(2));
    expect((await patch(t, { mark: `sha256:${used}` })).status).toBe(200);
    t.actAs(brander);
    const res = await t.get('/branding/images?page[size]=100');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    const page = BrandingImagePageDocument.parse(res.body);
    const byId = new Map(page.data.map((image) => [image.id, image]));
    expect(byId.get(used)?.meta).toEqual({ usedIn: ['mark'] });
    expect(byId.get(unused)?.meta).toEqual({ usedIn: [] });
    expect(page.meta.page.total).toBe(2);
    t.actAs(admin);
    expect((await t.get('/branding/images')).status).toBe(403);
  });

  it('deletes an unused upload with its bytes, audited; refuses one in use and a missing one', async () => {
    const used = await uploaded(t, await pixel(3));
    const unused = await uploaded(t, await pixel(4));
    expect((await patch(t, { logoLight: `sha256:${used}` })).status).toBe(200);
    const before = await media(t);

    const inUse = await remove(t, used);
    expect(inUse.status).toBe(409);
    expect(ErrorDocument.parse(inUse.body).errors[0]).toMatchObject({
      code: 'branding-image-in-use',
      meta: { usedIn: ['logoLight'] },
    });
    expect(await t.blobs.exists(used)).toBe(true);

    const deleted = await remove(t, unused);
    expect(deleted.status).toBe(204);
    expect(await t.blobs.exists(unused)).toBe(false);
    const after = await media(t);
    expect(after.files).toBe(before.files - 1);
    expect(after.bytes).toBeLessThan(before.bytes);

    expect((await remove(t, unused)).status).toBe(404);
    expect((await remove(t, 'f'.repeat(64))).status).toBe(404);
    t.actAs(admin);
    expect((await t.delete(`/branding/images/${used}`)).status).toBe(403);

    t.actAs(admin);
    const events = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=branding.image-delete')).body,
    ).data;
    expect(events.map((e) => e.attributes)).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: 'sample-brander' },
        subject: { type: 'branding', id: 'branding' },
        data: expect.objectContaining({ sha256: unused, fileKept: false }),
      }),
    ]);
  });

  it('keeps the bytes when a change set holds an upload of them too', async () => {
    const file = await pixel(5);
    const hash = await uploaded(t, file);
    t.actAs(librarian);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Pictures' } },
      }),
    );
    const changeSetId = ChangeSetDocument.parse(created.body).data.id;
    const sent = await t
      .post(`/change-sets/${changeSetId}/assets`)
      .set('Content-Type', 'multipart/form-data')
      .set(REQUEST_HEADER, '1')
      .attach('file', file, 'picture.png');
    expect(sent.status).toBe(201);
    const before = await media(t);
    expect((await remove(t, hash)).status).toBe(204);
    expect(await t.blobs.exists(hash)).toBe(true);
    // The change set's upload counts the bytes, and still does.
    expect(await media(t)).toEqual(before);
  });

  it('counts a branding image in the storage used', async () => {
    const before = await media(t);
    const file = await pixel(6);
    await uploaded(t, file);
    expect(await media(t)).toEqual({
      bytes: before.bytes + file.byteLength,
      files: before.files + 1,
    });
  });

  it('sweeps unused uploads a day old, keeping those in use and recent ones', async () => {
    const used = await uploaded(t, await pixel(7));
    const old = await uploaded(t, await pixel(8));
    expect((await patch(t, { appIcon: `sha256:${used}` })).status).toBe(200);
    const sweep = t.app.get(SweepBrandingImagesAction);
    // Nothing is a day old yet.
    expect((await sweep.handle({ now: new Date() })).removed).toEqual([]);
    const report = await sweep.handle({ now: new Date(Date.now() + 2 * DAY) });
    expect(report.removed).toContain(old);
    expect(report.removed).not.toContain(used);
    expect(await t.blobs.exists(old)).toBe(false);
    expect(await t.blobs.exists(used)).toBe(true);
    t.actAs(admin);
    const events = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=branding.image-delete')).body,
    ).data;
    expect(
      events.find((e) => e.attributes.data?.['sha256'] === old)?.attributes
        .actor,
    ).toEqual({ kind: 'service', id: 'service:branding' });
  });
});

describe('a branding upload and a delete of unused files at the same moment (#559, #623)', () => {
  let n = 5000;

  /** Bytes already in the store that nothing records: an unused file, past its grace period. */
  async function unusedFile(): Promise<{ file: Buffer; hash: string }> {
    const file = await pixel(n++);
    const { sha256 } = await t.blobs.put(Readable.from([file]), {
      contentType: 'image/png',
      maxBytes: file.byteLength,
    });
    vi.spyOn(t.app.get(DeleteAssetAction), 'now').mockReturnValue(
      Date.now() + 2 * DAY,
    );
    return { file, hash: sha256 };
  }

  function deleteFile(hash: string) {
    return t.app
      .get(DeleteAssetAction)
      .handle({ actor: librarian, hash })
      .then(
        () => 'deleted',
        (error: unknown) => (error as { code?: string }).code ?? 'failed',
      );
  }

  it('the upload recorded between the delete’s check and its removal: the delete is refused, the bytes stay', async () => {
    const { file, hash } = await unusedFile();
    const references = t.app.get(AssetReferences);
    const placesOf = references.placesOf.bind(references);
    let calls = 0;
    let sent: Promise<number> | undefined;
    vi.spyOn(references, 'placesOf').mockImplementation(async (hashes) => {
      // The second look, once the file is marked deleted.
      if (++calls === 2) sent = upload(t, file).then((res) => res.status);
      if (sent) await sent;
      return placesOf(hashes);
    });
    expect(await deleteFile(hash)).toBe('asset-in-use');
    expect(await sent).toBe(201);
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await recordedWithoutBytes(t)).toEqual([]);
  });

  it('the delete between the upload’s store and its record: the upload is refused, nothing recorded without bytes', async () => {
    const { file, hash } = await unusedFile();
    const put = t.blobs.put.bind(t.blobs);
    let deleted: Promise<string> | undefined;
    vi.spyOn(t.blobs, 'put').mockImplementation(async (data, options) => {
      const stored = await put(data, options);
      deleted = deleteFile(hash);
      await deleted;
      return stored;
    });
    const res = await upload(t, file);
    expect(await deleted).toBe('deleted');
    expect(res.status).toBe(503);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'upload-interrupted',
    );
    expect(await recordedWithoutBytes(t)).toEqual([]);
  });

  it('both at once, many times: no recorded image loses its bytes', async () => {
    for (let i = 0; i < 10; i++) {
      const { file, hash } = await unusedFile();
      await Promise.all([upload(t, file), deleteFile(hash)]);
    }
    expect(await recordedWithoutBytes(t)).toEqual([]);
  });
});

describe('removing a branding image while something else happens (#559)', () => {
  let n = 9000;
  const assets = () => t.app.get(AssetUploads);
  const unit = () => t.app.get(UnitOfWork);
  const marked = (hash: string) =>
    unit().run((tx) => assets().deletedAmong(tx, [hash]), BOUNDED);

  /** Runs `during` at the removal's look for where the bytes are used (once they are marked). */
  function atTheLook(during: () => Promise<unknown>) {
    const references = t.app.get(AssetReferences);
    const placesOf = references.placesOf.bind(references);
    return vi
      .spyOn(references, 'placesOf')
      .mockImplementation(async (hashes) => {
        await during();
        return placesOf(hashes);
      });
  }

  async function contentUpload(file: Buffer): Promise<void> {
    t.actAs(librarian);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Pictures' } },
      }),
    );
    const changeSetId = ChangeSetDocument.parse(created.body).data.id;
    const sent = await t
      .post(`/change-sets/${changeSetId}/assets`)
      .set('Content-Type', 'multipart/form-data')
      .set(REQUEST_HEADER, '1')
      .attach('file', file, 'picture.png');
    expect(sent.status).toBe(201);
  }

  it('a change naming it meanwhile: refused as in use, the bytes and record stay, no mark left', async () => {
    const hash = await uploaded(t, await pixel(n++));
    atTheLook(async () => {
      expect((await patch(t, { mark: `sha256:${hash}` })).status).toBe(200);
      t.actAs(brander);
    });
    const res = await remove(t, hash);
    expect(res.status).toBe(409);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'branding-image-in-use',
    );
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await marked(hash)).toEqual([]);
    vi.restoreAllMocks();
    expect((await patch(t, { mark: null })).status).toBe(200);
  });

  it('a content upload of the same bytes meanwhile: the record goes, the bytes stay', async () => {
    const file = await pixel(n++);
    const hash = await uploaded(t, file);
    atTheLook(() => contentUpload(file));
    expect((await remove(t, hash)).status).toBe(204);
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await marked(hash)).toEqual([]);
    t.actAs(brander);
    const listed = BrandingImagePageDocument.parse(
      (await t.get('/branding/images?page[size]=100')).body,
    );
    expect(listed.data.map((i) => i.id)).not.toContain(hash);
  });

  it('bytes content refers to without any upload record: the record goes, the bytes stay', async () => {
    const hash = await uploaded(t, await pixel(n++));
    // As for a module at `main` naming them (the old layout's bytes, say).
    vi.spyOn(t.app.get(AssetReferences), 'placesOf').mockResolvedValue(
      new Map([[hash, [{ in: 'main', ref: 'main' }]]]),
    );
    expect((await remove(t, hash)).status).toBe(204);
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await marked(hash)).toEqual([]);
    t.actAs(admin);
    const events = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=branding.image-delete')).body,
    ).data;
    expect(
      events.find((e) => e.attributes.data?.['sha256'] === hash)?.attributes
        .data?.['fileKept'],
    ).toBe(true);
  });

  it('a failure while looking: the record, the bytes stay and the mark is cleared', async () => {
    const hash = await uploaded(t, await pixel(n++));
    vi.spyOn(t.app.get(AssetReferences), 'placesOf').mockRejectedValue(
      new Error('the content repository is gone'),
    );
    expect((await remove(t, hash)).status).toBe(500);
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await marked(hash)).toEqual([]);
    vi.restoreAllMocks();
    expect((await remove(t, hash)).status).toBe(204);
  });

  it('another deletion of the same bytes under way: nothing changes, its mark stays, try again (503)', async () => {
    const hash = await uploaded(t, await pixel(n++));
    await unit().run((tx) => assets().markDeleted(tx, hash), BOUNDED);
    const res = await remove(t, hash);
    expect(res.status).toBe(503);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'branding-image-busy',
    );
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await marked(hash)).toEqual([hash]);
    // Once it ended.
    await unit().run(async (tx) => {
      await assets().lockHash(tx, hash);
      await assets().clearDeleted(tx, hash);
    }, BOUNDED);
    expect((await remove(t, hash)).status).toBe(204);
    expect(await t.blobs.exists(hash)).toBe(false);
  });

  it('a delete and the sweep at once: removed once, nothing recorded without bytes', async () => {
    const hash = await uploaded(t, await pixel(n++));
    const before = await media(t);
    const [res, report] = await Promise.all([
      remove(t, hash),
      t.app
        .get(SweepBrandingImagesAction)
        .handle({ now: new Date(Date.now() + 2 * DAY) }),
    ]);
    const removedBySweep = report.removed.includes(hash);
    expect(res.status === 204 || removedBySweep).toBe(true);
    // The sweep first: gone, or under way (its mark set).
    if (removedBySweep) expect([404, 503]).toContain(res.status);
    expect(await t.blobs.exists(hash)).toBe(false);
    expect(await recordedWithoutBytes(t)).toEqual([]);
    expect(await marked(hash)).toEqual([]);
    expect((await media(t)).files).toBeLessThan(before.files);
  });
});
