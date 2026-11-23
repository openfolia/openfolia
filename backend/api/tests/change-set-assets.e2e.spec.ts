import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PNG_HASH } from '@openfolia/content-repo/testing';
import type { Module } from '@openfolia/content-model';
import { eq } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { MAX_UPLOADS_PER_CHANGE_SET } from '../src/assets/core/asset-upload.js';
import { assetUploads } from '../src/assets/repos/asset-uploads.tables.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

const MAX = 2048;

/** A real 1×1 PNG, with bytes after its end so no other test (or the sample) holds it. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
let images = 0;
/** A PNG of its own: each test uploads into the one blob store. */
const png = () => Buffer.concat([PNG_BYTES, Buffer.from(`#${++images}`)]);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};
const other: Actor = { ...author, id: 'sample-other' };
const draftReader: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-reviewer',
};
const admin = actorWith(['admin.roles']);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ CCMS_MAX_UPLOAD_BYTES: String(MAX) });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function changeSet(as: Actor): Promise<string> {
  t.actAs(as);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Images' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

/** A multipart upload of `data` in the part `field`. */
const upload = (cs: string, data: Buffer, field = 'file', name = 'a.png') =>
  t
    .anonymous()
    .post(`/change-sets/${cs}/assets`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set(REQUEST_HEADER, '1')
    .attach(field, data, { filename: name, contentType: 'image/png' });

const events = async (subject: string) => {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=${encodeURIComponent(subject)}`,
  );
  return AuditEventPageDocument.parse(res.body).data.map((e) => e.attributes);
};

describe('POST /change-sets/:changeSetId/assets', () => {
  it('stores an image without a commit, previews it for its author, and takes it again as it is', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    const hash = sha256(PNG);
    t.actAs(author);
    const res = await upload(cs, PNG);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(res.headers['location']).toBe(`/change-sets/${cs}/assets/${hash}`);
    const doc = ChangeSetAssetDocument.parse(res.body);
    expect(doc.data).toEqual({
      type: 'ChangeSetAsset',
      id: `${cs}/${hash}`,
      attributes: {
        reference: `sha256:${hash}`,
        contentType: 'image/png',
        size: PNG.byteLength,
        fileName: 'a.png',
        uploadedBy: { kind: 'user', id: 'sample-author' },
        uploadedAt: expect.any(String),
      },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: cs } } },
    });
    expect(await t.blobs.head(hash)).toEqual({
      sha256: hash,
      size: PNG.byteLength,
      contentType: 'image/png',
      storedAt: expect.any(Date),
    });

    // Nothing committed: the branch is still at main.
    const onBranch = await t.get(
      `/modules/en/charging?ref=${encodeURIComponent(`change-sets/${cs}`)}`,
    );
    expect(onBranch.headers['x-ccms-commit']).toBe(t.commits.main);

    // Its author previews it; the asset route does not serve it yet.
    const preview = await t
      .get(res.headers['location'] as string)
      .set('Accept', 'image/*')
      .buffer(true);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    expect(preview.headers['cache-control']).toBe('private, no-cache');
    expect(Buffer.from(preview.body as Buffer)).toEqual(PNG);
    const served = await t.get(
      `/assets/${hash}?ref=${encodeURIComponent(`change-sets/${cs}`)}`,
    );
    expect(served.status).toBe(404);

    // The same image again: the first upload, nothing new.
    const again = await upload(cs, PNG, 'file', 'other-name.jpg');
    expect(again.status).toBe(200);
    expect(again.headers['location']).toBeUndefined();
    expect(ChangeSetAssetDocument.parse(again.body)).toEqual(doc);

    expect(
      (await events(`asset/${hash}`)).map((e) => [
        e.action,
        e.actor.id,
        e.data,
      ]),
    ).toEqual([
      [
        'asset.upload',
        'sample-author',
        {
          changeSetId: cs,
          size: PNG.byteLength,
          contentType: 'image/png',
          fileName: 'a.png',
        },
      ],
    ]);
  });

  it('is served by the asset route once a module on the branch refers to it', async () => {
    const cs = await changeSet(author);
    t.actAs(author);
    const uploaded = ChangeSetAssetDocument.parse((await upload(cs, JPEG)).body)
      .data.attributes;
    const subject = { type: 'module', lang: 'en', moduleId: 'charging' };
    const locked = await t
      .post(`/change-sets/${cs}/locks`)
      .send(
        JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
      );
    expect(locked.status).toBe(201);
    const copy = `/change-sets/${cs}/modules/en/charging/working-copy`;
    const committed = ModuleWorkingCopyDocument.parse((await t.get(copy)).body)
      .data.attributes;
    const content: Module = {
      ...committed.content,
      blocks: [
        ...committed.content.blocks,
        {
          type: 'image',
          id: 'uploaded',
          asset: uploaded.reference,
          alt: 'Uploaded',
        },
      ],
    };
    const saved = await t.put(copy).send(
      JSON.stringify({
        data: { type: 'WorkingCopy', attributes: { content } },
        meta: { version: 0, baseCommit: committed.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    expect((await t.post(`/change-sets/${cs}/commits`)).status).toBe(201);

    const hash = uploaded.reference.slice('sha256:'.length);
    const served = await t
      .get(`/assets/${hash}?ref=${encodeURIComponent(`change-sets/${cs}`)}`)
      .set('Accept', 'image/*')
      .buffer(true);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(served.body as Buffer)).toEqual(JPEG);
  });

  it('refuses a file larger than CCMS_MAX_UPLOAD_BYTES, storing nothing', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    t.actAs(author);
    // Within the multipart allowance: read up to just past the limit.
    const big = Buffer.concat([PNG, Buffer.alloc(MAX + 1 - PNG.byteLength)]);
    const res = await upload(cs, big);
    expect(res.status).toBe(422);
    expect(only(res.body)).toMatchObject({
      code: 'too-large',
      meta: { max: MAX },
    });
    expect(await t.blobs.exists(sha256(big))).toBe(false);

    // Its Content-Length alone shows it: refused before reading (were the
    // bytes read, this SVG would be unsupported-image-type).
    const huge = Buffer.concat([SVG, Buffer.alloc(MAX + 20_000)]);
    const early = await upload(cs, huge);
    expect(early.status).toBe(422);
    expect(only(early.body)?.code).toBe('too-large');

    // Exactly the limit fits.
    const fits = Buffer.concat([PNG, Buffer.alloc(MAX - PNG.byteLength)]);
    expect((await upload(cs, fits)).status).toBe(201);
  });

  it.each([
    ['an SVG with a script', SVG],
    ['text', Buffer.from('Not an image at all.')],
    ['an HTML page', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['an empty file', Buffer.alloc(0)],
  ])('refuses %s as no image it takes', async (_, data) => {
    const cs = await changeSet(author);
    t.actAs(author);
    const res = await upload(cs, data, 'file', 'picture.png');
    expect(res.status).toBe(422);
    expect(only(res.body)).toMatchObject({
      code: 'unsupported-image-type',
      meta: { accepted: ['image/png', 'image/jpeg'] },
    });
    expect(await t.blobs.exists(sha256(data))).toBe(false);
  });

  it('takes images only into its author’s own change set', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    t.actAs(other);
    const hidden = await upload(cs, PNG);
    expect(hidden.status).toBe(404);
    expect(only(hidden.body)?.code).toBe('not-found');
    t.actAs(draftReader);
    const refused = await upload(cs, PNG);
    expect(refused.status).toBe(403);
    expect(only(refused.body)?.code).toBe('forbidden');
    t.actAs(actorWith(['content.read']));
    expect((await upload(cs, PNG)).status).toBe(403);
    expect(await t.blobs.exists(sha256(PNG))).toBe(false);

    // Nor does anyone but its author preview what was uploaded.
    t.actAs(author);
    expect((await upload(cs, PNG)).status).toBe(201);
    const preview = `/change-sets/${cs}/assets/${sha256(PNG)}`;
    t.actAs(other);
    expect((await t.get(preview)).status).toBe(404);
    t.actAs(draftReader);
    expect((await t.get(preview)).status).toBe(403);
  });

  it('takes at most 1,000 images into a change set', async () => {
    const cs = await changeSet(author);
    await t.database.db.insert(assetUploads).values(
      Array.from({ length: MAX_UPLOADS_PER_CHANGE_SET - 1 }, (_, n) => ({
        changeSetId: cs,
        sha256: n.toString(16).padStart(64, '0'),
        size: 1,
        contentType: 'image/png',
        uploadedByKind: 'user',
        uploadedById: 'sample-author',
        uploadedAt: new Date(),
        lastUploadedAt: new Date(),
      })),
    );
    t.actAs(author);
    const last = png();
    expect((await upload(cs, last)).status).toBe(201);
    const over = png();
    const refused = await upload(cs, over);
    expect(refused.status).toBe(409);
    expect(only(refused.body)).toMatchObject({
      code: 'too-many-uploads',
      meta: { max: MAX_UPLOADS_PER_CHANGE_SET },
    });
    expect(await t.blobs.exists(sha256(over))).toBe(false);
    expect(await events(`asset/${sha256(over)}`)).toEqual([]);
  });

  it('takes images only into a draft', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    t.actAs(author);
    expect((await t.post(`/change-sets/${cs}/abandon`)).status).toBe(200);
    const res = await upload(cs, PNG);
    expect(res.status).toBe(409);
    expect(only(res.body)).toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });
  });

  it('refuses a multipart upload without X-Ccms-Request, as a cross-site form would send it', async () => {
    const cs = await changeSet(author);
    t.actAs(author);
    const res = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .attach('file', png(), 'a.png');
    expect(res.status).toBe(403);
    expect(only(res.body)?.code).toBe('request-header-required');
    const stored = await t.database.db
      .select()
      .from(assetUploads)
      .where(eq(assetUploads.changeSetId, cs));
    expect(stored).toEqual([]);
  });

  it('refuses a body that is not one file part named "file"', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    t.actAs(author);
    const json = await t
      .post(`/change-sets/${cs}/assets`)
      .send(JSON.stringify({ data: { type: 'ChangeSetAsset' } }));
    expect(json.status).toBe(415);
    expect(only(json.body)?.code).toBe('unsupported-media-type');

    const raw = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .set('Content-Type', 'image/png')
      .send(PNG);
    expect(raw.status).toBe(415);

    const wrongName = await upload(cs, PNG, 'image');
    expect(wrongName.status).toBe(400);
    expect(only(wrongName.body)?.code).toBe('invalid-body');

    const withField = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .field('caption', 'hello')
      .attach('file', PNG, 'a.png');
    expect(withField.status).toBe(400);
    expect(only(withField.body)?.code).toBe('invalid-body');

    const two = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .attach('file', PNG, 'a.png')
      .attach('file', JPEG, 'b.jpg');
    expect(two.status).toBe(400);
    expect(only(two.body)?.code).toBe('invalid-body');

    const empty = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x--\r\n');
    expect(empty.status).toBe(400);
    expect(only(empty.body)?.code).toBe('invalid-body');

    const cut = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send(
        Buffer.concat([
          Buffer.from(
            '--x\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n',
          ),
          PNG,
        ]),
      );
    expect(cut.status).toBe(400);
    expect(only(cut.body)?.code).toBe('invalid-body');
    // Neither the cut-off nor the refused forms stored their file.
    expect(await t.blobs.exists(sha256(PNG))).toBe(false);
  });

  it('previews nothing but an image uploaded into the change set', async () => {
    const cs = await changeSet(author);
    const PNG = png();
    t.actAs(author);
    expect((await upload(cs, JPEG)).status).toBe(201);
    for (const hash of [sha256(PNG), 'not-a-hash', 'F'.repeat(64)]) {
      const res = await t.get(`/change-sets/${cs}/assets/${hash}`);
      expect([hash, res.status]).toEqual([hash, 404]);
    }
    const query = await t.get(`/change-sets/${cs}/assets/${sha256(JPEG)}?x=1`);
    expect(query.status).toBe(400);
    expect(only(query.body)?.code).toBe('unsupported-parameter');
  });
});

describe('files a working copy names (#335)', () => {
  // Each test its own module: the other tests keep charging locked.
  let moduleId = '';
  const copyOf = (cs: string) =>
    `/change-sets/${cs}/modules/en/${moduleId}/working-copy`;
  /** Takes the lock and reads the working copy (the committed file at first). */
  async function editing(cs: string) {
    const locked = await t.post(`/change-sets/${cs}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'module', lang: 'en', moduleId } },
        },
      }),
    );
    expect(locked.status).toBe(201);
    return ModuleWorkingCopyDocument.parse((await t.get(copyOf(cs))).body).data
      .attributes;
  }
  const naming = (base: Module, ...hashes: string[]): Module => ({
    ...base,
    blocks: [
      ...base.blocks,
      ...hashes.map((hash, n) => ({
        type: 'image' as const,
        id: `named-${n}`,
        asset: `sha256:${hash}`,
        alt: 'Named',
      })),
    ],
  });
  const save = (
    cs: string,
    { content, baseCommit }: { content: Module; baseCommit: string },
  ) =>
    t.put(copyOf(cs)).send(
      JSON.stringify({
        data: { type: 'WorkingCopy', attributes: { content } },
        meta: { version: 0, baseCommit },
      }),
    );

  it('refuses another author’s upload, a stored file nobody uploaded and a missing hash alike, without asking the store', async () => {
    moduleId = 'internals';
    const theirs = await changeSet(other);
    const OTHERS = png();
    t.actAs(other);
    expect((await upload(theirs, OTHERS)).status).toBe(201);
    // Stored, but no upload of anyone's: as an import's bundle is.
    const BUNDLE = png();
    await t.blobs.put(Readable.from([BUNDLE]), {
      contentType: 'application/zip',
      maxBytes: MAX,
    });
    const missing = sha256(png());

    const cs = await changeSet(author);
    t.actAs(author);
    const committed = await editing(cs);
    const asked = [
      vi.spyOn(t.blobs, 'exists'),
      vi.spyOn(t.blobs, 'head'),
      vi.spyOn(t.blobs, 'get'),
    ];
    const answers = [];
    try {
      for (const hash of [sha256(OTHERS), sha256(BUNDLE), missing]) {
        const res = await save(cs, {
          ...committed,
          content: naming(committed.content, hash),
        });
        expect([hash, res.status]).toEqual([hash, 422]);
        const error = only(res.body);
        expect(error?.meta).toEqual({ assets: [`sha256:${hash}`] });
        answers.push({ ...error, meta: undefined });
      }
      for (const spy of asked) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of asked) spy.mockRestore();
    }
    expect(answers[0]).toMatchObject({ code: 'unknown-asset', status: '422' });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // Nothing was saved, so nothing reaches the branch or the asset route.
    expect(
      ModuleWorkingCopyDocument.parse((await t.get(copyOf(cs))).body).data
        .attributes.version,
    ).toBe(0);
    const ref = encodeURIComponent(`change-sets/${cs}`);
    for (const hash of [sha256(OTHERS), sha256(BUNDLE), missing]) {
      const served = await t.get(`/assets/${hash}?ref=${ref}`);
      expect([hash, served.status]).toEqual([hash, 404]);
    }
  });

  it('takes the author’s own upload and a file a module they see uses, saved, committed and served', async () => {
    moduleId = 'safety-note';
    const cs = await changeSet(author);
    const OWN = png();
    t.actAs(author);
    expect((await upload(cs, OWN)).status).toBe(201);
    const committed = await editing(cs);
    // The sample's image, which a module on the branch shows: as copying
    // that module's image block would name it.
    const saved = await save(cs, {
      ...committed,
      content: naming(committed.content, sha256(OWN), PNG_HASH),
    });
    expect(saved.status).toBe(200);
    expect((await t.post(`/change-sets/${cs}/commits`)).status).toBe(201);
    const ref = encodeURIComponent(`change-sets/${cs}`);
    const served = await t
      .get(`/assets/${sha256(OWN)}?ref=${ref}`)
      .set('Accept', 'image/*')
      .buffer(true);
    expect(served.status).toBe(200);
    expect(Buffer.from(served.body as Buffer)).toEqual(OWN);
  });
});
