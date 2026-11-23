import { createHash } from 'node:crypto';
import type { Attachment, Block, Module } from '@openfolia/content-model';
import type { Actor } from '../src/access/core/actor.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/** The attachment limit these apps run with. */
const MAX = 4096;

let files = 0;
/** Bytes of their own: every test uploads into the one blob store. */
const unique = (data: Buffer) =>
  Buffer.concat([data, Buffer.from(`\n#${++files}`)]);
const zip = () =>
  unique(
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]),
  );
const json = () => unique(Buffer.from('{"mode": "auto", "speed": 1.5}'));
const HTML = Buffer.from(
  '<!doctype html><script>alert(document.cookie)</script>',
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.7\n%refused');
/** The first bytes of an OLE compound file: a legacy Office document, an installer. */
const OLE = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(24),
]);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};

const TYPE_SETTINGS = [
  'CCMS_ATTACHMENT_TYPES_ALLOW',
  'CCMS_ATTACHMENT_TYPES_DENY',
  'CCMS_ATTACHMENT_TYPES_OPEN',
];

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    CCMS_MAX_ATTACHMENT_BYTES: String(MAX),
    ...Object.fromEntries(TYPE_SETTINGS.map((name) => [name, ''])),
  });
});
afterAll(async () => {
  for (const name of [...TYPE_SETTINGS, 'CCMS_MAX_ATTACHMENT_BYTES']) {
    delete process.env[name];
  }
  await t?.close();
});
afterEach(() => t?.actAs(undefined));

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function changeSet(app: TestApp): Promise<string> {
  app.actAs(author);
  const res = await app.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Attachments' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

/** A multipart upload as a browser sends it, claiming a harmless type. */
const attach = (
  app: TestApp,
  cs: string,
  data: Buffer,
  filename: string,
  kind = 'attachment',
) =>
  app
    .anonymous()
    .post(`/change-sets/${cs}/assets?kind=${kind}`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set(REQUEST_HEADER, '1')
    .attach('file', data, { filename, contentType: 'application/json' });

/** Adds `blocks` to the change set's module `moduleId` and commits it. */
async function commit(
  app: TestApp,
  cs: string,
  blocks: Block[],
  moduleId = 'charging',
) {
  const subject = { type: 'module', lang: 'en', moduleId };
  const locked = await app
    .post(`/change-sets/${cs}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(locked.status).toBe(201);
  const copy = `/change-sets/${cs}/modules/en/${moduleId}/working-copy`;
  const committed = ModuleWorkingCopyDocument.parse((await app.get(copy)).body)
    .data.attributes;
  const content: Module = {
    ...committed.content,
    blocks: [...committed.content.blocks, ...blocks],
  };
  const saved = await app.put(copy).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: 0, baseCommit: committed.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await app.post(`/change-sets/${cs}/commits`)).status).toBe(201);
}

const block = (
  id: string,
  uploaded: {
    reference: string;
    fileName: string | null;
    contentType: string;
    size: number;
  },
): Attachment => ({
  type: 'attachment',
  id,
  asset: uploaded.reference,
  name: `File ${id}`,
  fileName: uploaded.fileName ?? 'file',
  mediaType: uploaded.contentType,
  size: uploaded.size,
});

describe('attachments', () => {
  it('uploads a ZIP and a JSON file, commits them, lists them and downloads them as files', async () => {
    const cs = await changeSet(t);
    const ZIP = zip();
    const JSON_FILE = json();
    const zipped = await attach(t, cs, ZIP, 'Konfiguration "v2"; ä.zip');
    expect(zipped.status).toBe(201);
    const zipUpload = ChangeSetAssetDocument.parse(zipped.body).data.attributes;
    expect(zipUpload).toMatchObject({
      reference: `sha256:${sha256(ZIP)}`,
      contentType: 'application/zip',
      size: ZIP.byteLength,
      fileName: 'Konfiguration _v2_; ä.zip',
    });
    const sample = await attach(t, cs, JSON_FILE, 'sample.json');
    expect(sample.status).toBe(201);
    const jsonUpload = ChangeSetAssetDocument.parse(sample.body).data
      .attributes;
    expect(jsonUpload.contentType).toBe('application/json');

    // Its author previews it as a download, before a module refers to it.
    const preview = await t
      .get(`/change-sets/${cs}/assets/${sha256(ZIP)}`)
      .set('Accept', '*/*')
      .buffer(true);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-disposition']).toBe(
      `attachment; filename="Konfiguration _v2__ _.zip"; filename*=UTF-8''Konfiguration%20_v2_%3B%20%C3%A4.zip`,
    );

    // The uploads, listed and found by file name before a module shows them.
    const ref = encodeURIComponent(`change-sets/${cs}`);
    const listed = AssetPageDocument.parse(
      (
        await t.get(
          `/assets?ref=${ref}&filter[changeSet]=${cs}&filter[type]=attachment`,
        )
      ).body,
    );
    expect(listed.data.map((a) => a.id)).toEqual([
      sha256(JSON_FILE),
      sha256(ZIP),
    ]);
    const found = AssetPageDocument.parse(
      (
        await t.get(
          `/assets?ref=${ref}&filter[changeSet]=${cs}&filter[q]=sample`,
        )
      ).body,
    );
    expect(found.data.map((a) => a.id)).toEqual([sha256(JSON_FILE)]);

    await commit(t, cs, [
      block('config', zipUpload),
      block('sample', jsonUpload),
    ]);

    for (const [data, upload, type] of [
      [ZIP, zipUpload, 'application/zip'],
      [JSON_FILE, jsonUpload, 'application/json'],
    ] as const) {
      const served = await t
        .get(`/assets/${sha256(data)}?ref=${ref}`)
        .set('Accept', '*/*')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toMatch(new RegExp(`^${type}`));
      expect(served.headers['content-disposition']).toMatch(/^attachment; /);
      expect(served.headers['content-disposition']).toContain(
        `filename*=UTF-8''${encodeURIComponent(upload.fileName ?? '').replace(
          /'/g,
          '%27',
        )}`,
      );
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      expect(Buffer.from(served.body as Buffer)).toEqual(data);
    }

    // Listed at the branch, with how it is used and its block's file name.
    const atBranch = AssetPageDocument.parse(
      (await t.get(`/assets?ref=${ref}&filter[type]=attachment`)).body,
    );
    expect(
      atBranch.data.map((a) => [a.id, a.attributes.fileName, a.meta.usedAs]),
    ).toEqual([
      [sha256(ZIP), 'Konfiguration _v2_; ä.zip', ['attachment']],
      [sha256(JSON_FILE), 'sample.json', ['attachment']],
    ]);

    // No check holds it up: both files are stored.
    const checks = CheckPageDocument.parse(
      (await t.get(`/change-sets/${cs}/checks`)).body,
    );
    expect(checks.data.map((c) => c.attributes.code)).not.toContain(
      'missing-attachment',
    );
  });

  it('never offers a file under a dangerous name a block gives it', async () => {
    const cs = await changeSet(t);
    const ZIP = zip();
    const uploaded = ChangeSetAssetDocument.parse(
      (await attach(t, cs, ZIP, 'config.zip')).body,
    ).data.attributes;
    await commit(
      t,
      cs,
      [
        { ...block('evil', uploaded), fileName: 'evil.html' },
        { ...block('vector', uploaded), fileName: 'x.svg' },
      ],
      'internals',
    );
    const ref = encodeURIComponent(`change-sets/${cs}`);
    const served = await t
      .get(`/assets/${sha256(ZIP)}?ref=${ref}`)
      .set('Accept', '*/*')
      .buffer(true);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^application\/zip/);
    // No block name fits a ZIP: it is saved under its hash, still a download.
    expect(served.headers['content-disposition']).toBe(
      `attachment; filename="${sha256(ZIP)}"; filename*=UTF-8''${sha256(ZIP)}`,
    );
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain('sandbox');
    // The check names each such block, blocking.
    const checks = CheckPageDocument.parse(
      (await t.get(`/change-sets/${cs}/checks`)).body,
    );
    expect(
      checks.data
        .filter((c) => c.attributes.code === 'attachment-file-name')
        .map((c) => [c.attributes.blockId, c.attributes.severity]),
    ).toEqual([
      ['evil', 'blocking'],
      ['vector', 'blocking'],
    ]);
  });

  it('reports an attachment whose file is not stored as a blocking check', async () => {
    const cs = await changeSet(t);
    // Only a file the author may read is named (#335): one they uploaded,
    // whose bytes are lost from the store after it is committed.
    const ZIP = zip();
    const uploaded = ChangeSetAssetDocument.parse(
      (await attach(t, cs, ZIP, 'gone.zip')).body,
    ).data.attributes;
    await commit(t, cs, [block('gone', uploaded)], 'safety-note');
    await t.blobs.delete(sha256(ZIP));
    const checks = CheckPageDocument.parse(
      (await t.get(`/change-sets/${cs}/checks`)).body,
    );
    const check = checks.data.find(
      (c) => c.attributes.code === 'missing-attachment',
    );
    expect(check?.attributes).toMatchObject({
      severity: 'blocking',
      category: 'attachment',
      blockId: 'gone',
      params: { asset: uploaded.reference },
    });
  });

  it.each([
    ['an HTML page', HTML, 'page.html', 'text/html', 'dangerous'],
    ['an SVG', SVG, 'logo.svg', 'image/svg+xml', 'dangerous'],
    [
      'an executable',
      Buffer.from('MZ\x90\x00rest', 'latin1'),
      'setup.exe',
      'application/vnd.microsoft.portable-executable',
      'dangerous',
    ],
    ['HTML named as JSON', HTML, 'data.json', 'text/html', 'mismatch'],
    ['PNG bytes named as HTML', PNG, 'page.html', 'text/html', 'mismatch'],
    ['a PDF named as a ZIP', PDF, 'archive.zip', 'application/zip', 'mismatch'],
    [
      'a legacy Word document',
      OLE,
      'report.doc',
      'application/msword',
      'dangerous',
    ],
    [
      'OLE bytes named as text',
      OLE,
      'notes.txt',
      'application/x-ole-storage',
      'mismatch',
    ],
    [
      'a name that is all extension',
      Buffer.from('plain words'),
      '.hta',
      'application/hta',
      'dangerous',
    ],
  ])('refuses %s, with a clear error', async (_, data, name, type, reason) => {
    const cs = await changeSet(t);
    const res = await attach(t, cs, data, name);
    expect(res.status).toBe(422);
    const error = only(res.body);
    expect(error).toMatchObject({
      code: 'unsupported-attachment-type',
      meta: { contentType: type, reason },
    });
    expect(error?.detail).toMatch(
      reason === 'dangerous'
        ? /refused unless the settings open them/
        : /bytes of another type than its extension says/,
    );
    expect(await t.blobs.exists(sha256(data))).toBe(false);
  });

  it('refuses an attachment over CCMS_MAX_ATTACHMENT_BYTES, and keeps the image limit for images', async () => {
    const cs = await changeSet(t);
    const big = unique(Buffer.alloc(MAX + 1));
    const res = await attach(t, cs, big, 'big.bin');
    expect(res.status).toBe(422);
    expect(only(res.body)).toMatchObject({
      code: 'too-large',
      meta: { max: MAX },
    });
    expect(await t.blobs.exists(sha256(big))).toBe(false);
    const fits = Buffer.alloc(MAX - 8, 7);
    expect((await attach(t, cs, fits, 'fits.bin')).status).toBe(201);

    // The image upload is unchanged: a ZIP is no image.
    const image = await attach(t, cs, zip(), 'a.zip', 'image');
    expect(image.status).toBe(422);
    expect(only(image.body)?.code).toBe('unsupported-image-type');
  });

  it('refuses an unknown kind', async () => {
    const cs = await changeSet(t);
    const res = await attach(t, cs, zip(), 'a.zip', 'video');
    expect(res.status).toBe(400);
    expect(only(res.body)?.source).toEqual({ parameter: 'kind' });
  });
});
