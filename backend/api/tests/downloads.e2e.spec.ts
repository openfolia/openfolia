import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  type Attachment,
  type Module,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  DownloadPageDocument,
  DownloadVersionPageDocument,
} from '../src/downloads/api/download.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders the sample's PDFs once: slower than most.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const sha256 = (data: string) =>
  createHash('sha256').update(data).digest('hex');
const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;
/** A body read as bytes (a file route's), as JSON. */
const bodyOf = (body: unknown): unknown =>
  Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

/** A file in the blob store, as an upload would put it, and its attachment block. */
const file = async (
  id: string,
  bytes: string,
  extra: Partial<Attachment> = {},
): Promise<Attachment> => {
  await t.blobs.put(Readable.from([Buffer.from(bytes)]), {
    contentType: 'application/zip',
    maxBytes: 1_000_000,
  });
  return {
    type: 'attachment',
    id,
    asset: `sha256:${sha256(bytes)}`,
    name: `Name of ${id}`,
    fileName: `${id}.zip`,
    mediaType: 'application/zip',
    size: bytes.length,
    ...extra,
  };
};

const module = (
  id: string,
  audience: string,
  blocks: Attachment[],
  facets: Record<string, string[]> = {},
): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: `Title of ${id}`,
    type: 'concept',
    lang: 'en',
    audience,
    facets,
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'Files.' }],
    },
    ...blocks,
  ],
});

/** Commits the modules to `main` (no manual names them: the release's PDFs stay as they are). */
const commit = async (...modules: Module[]) => {
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: modules.map((m) => ({
      path: `modules/en/${m.id}.adoc`,
      content: printModule(m),
    })),
    message: 'Attach files',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
};

const cut = async (revision: string, notes: string) => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: {
        type: 'Release',
        attributes: { product: 'north', revision, notes },
      },
    }),
  );
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
};

const list = async (query: string, as: Actor) => {
  t.actAs(as);
  const res = await t.get(`/downloads${query}`);
  expect(res.status).toBe(200);
  return DownloadPageDocument.parse(res.body);
};

const versions = (id: string, as: Actor) => {
  t.actAs(as);
  return t.get(`/downloads/${encodeURIComponent(id)}/versions`);
};

const fileAt = (id: string, releaseId: string, as: Actor) => {
  t.actAs(as);
  return t
    .get(`/downloads/${encodeURIComponent(id)}/versions/${releaseId}/file`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
};

const SHEET = 'attachment:north:datasheet:sheet:en';
const WIRING = 'attachment:north:wiring:plan:en';

describe('downloads', () => {
  let first: Awaited<ReturnType<typeof cut>>;
  let second: Awaited<ReturnType<typeof cut>>;

  beforeAll(async () => {
    await commit(
      module('datasheet', 'public', [
        await file('sheet', 'sheet v1', { description: 'The first sheet' }),
      ]),
      module('wiring', 'internal', [await file('plan', 'wiring v1')]),
      module('south-sheet', 'public', [await file('south', 'south v1')], {
        region: ['south'],
      }),
    );
    first = await cut('1.0', 'First release.');
    await commit(
      module('datasheet', 'public', [
        await file('sheet', 'sheet v2', { description: 'The new sheet' }),
      ]),
      module('wiring', 'internal', [await file('plan', 'wiring v2')]),
    );
    second = await cut('2.0', 'Second release.');
  });

  it('never shows a reader limited to a lower audience an attachment above it: list, count, versions, file', async () => {
    const seen = await list(
      '?filter[product]=north&filter[kind]=attachment',
      publicReader,
    );
    expect(seen.data.map((d) => d.id)).toEqual([SHEET]);
    expect(seen.meta.page.total).toBe(1);
    // Looked for by its words: not there either.
    const words = await list('?filter[q]=wiring', publicReader);
    expect(words.meta.page.total).toBe(0);
    for (const res of [
      await versions(WIRING, publicReader),
      await fileAt(WIRING, second.id, publicReader),
      await fileAt(WIRING, first.id, publicReader),
    ]) {
      expect(res.status).toBe(404);
      expect(codeOf(bodyOf(res.body))).toBe('not-found');
    }
    // A reader of every audience gets it.
    const all = await list(
      '?filter[product]=north&filter[kind]=attachment',
      READER,
    );
    expect(all.data.map((d) => d.id)).toEqual([SHEET, WIRING]);
    expect((await versions(WIRING, READER)).status).toBe(200);
  });

  it('lists an attachment replaced between two releases as two versions, the older superseded', async () => {
    const res = await versions(SHEET, READER);
    expect(res.status).toBe(200);
    const doc = DownloadVersionPageDocument.parse(res.body);
    expect(
      doc.data.map((v) => ({
        id: v.id,
        state: v.attributes.state,
        sha256: v.attributes.sha256,
        release: v.attributes.release.revision,
        at: v.attributes.release.publishedAt,
        changeNote: v.attributes.changeNote,
      })),
    ).toEqual([
      {
        id: second.id,
        state: 'current',
        sha256: sha256('sheet v2'),
        release: '2.0',
        at: second.attributes.publishedAt,
        changeNote: { notes: 'Second release.', description: 'The new sheet' },
      },
      {
        id: first.id,
        state: 'superseded',
        sha256: sha256('sheet v1'),
        release: '1.0',
        at: first.attributes.publishedAt,
        changeNote: { notes: 'First release.', description: 'The first sheet' },
      },
    ]);
    expect(doc.meta).toMatchObject({ page: { total: 2 }, truncated: false });
  });

  it('lists the current attachments of the product, with their facts and links', async () => {
    const doc = await list('?filter[kind]=attachment', READER);
    const sheet = doc.data.find((d) => d.id === SHEET);
    expect(sheet?.attributes).toEqual({
      kind: 'attachment',
      product: 'north',
      lang: 'en',
      name: 'Name of sheet',
      description: 'The new sheet',
      sha256: sha256('sheet v2'),
      size: 'sheet v2'.length,
      mediaType: 'application/zip',
      fileName: 'sheet.zip',
      moduleId: 'datasheet',
      blockId: 'sheet',
      manualId: null,
      variant: null,
      release: {
        id: second.id,
        tag: second.attributes.tag,
        revision: '2.0',
        publishedAt: second.attributes.publishedAt,
      },
    });
    expect(sheet?.meta).toEqual({ moduleTitle: 'Title of datasheet' });
    // A module for another product is not this product's.
    expect(doc.data.some((d) => d.attributes.moduleId === 'south-sheet')).toBe(
      false,
    );
    const files = await fileAt(SHEET, second.id, READER);
    expect(files.status).toBe(200);
    expect(sheet?.links.file).toBe(
      `/downloads/${encodeURIComponent(SHEET)}/versions/${second.id}/file`,
    );
  });

  it('sends each version’s file with the safe download headers', async () => {
    const old = await fileAt(SHEET, first.id, READER);
    expect(old.status).toBe(200);
    expect((old.body as Buffer).toString('utf8')).toBe('sheet v1');
    expect(old.headers).toMatchObject({
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="sheet.zip"; filename*=UTF-8''sheet.zip`,
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${sha256('sheet v1')}"`,
    });
    const now = await fileAt(SHEET, second.id, READER);
    expect((now.body as Buffer).toString('utf8')).toBe('sheet v2');
    t.actAs(READER);
    const query = await t.get(
      `/downloads/${encodeURIComponent(SHEET)}/versions/${second.id}/file?x=1`,
    );
    expect(query.status).toBe(400);
    expect(codeOf(bodyOf(query.body))).toBe('unsupported-parameter');
  });

  it('refuses a malformed filter and an ID that names no download', async () => {
    t.actAs(READER);
    for (const query of [
      '?filter[kind]=image',
      '?filter[mediaType]=Application/PDF',
      '?filter[lang]=not a tag',
      '?filter[other]=x',
    ]) {
      const res = await t.get(`/downloads${query}`);
      expect(res.status).toBe(400);
    }
    for (const id of [
      'nope',
      'attachment:north:datasheet:nope:en',
      'attachment:south:datasheet:sheet:en',
    ]) {
      const res = await versions(id, READER);
      expect(res.status).toBe(404);
      expect(codeOf(res.body)).toBe('not-found');
    }
  });

  it('lists a release’s PDFs as downloads of kind manual once they are rendered', async () => {
    // Nothing rendered yet: none listed.
    expect((await list('?filter[kind]=manual', READER)).meta.page.total).toBe(
      0,
    );
    await t.runJobs();
    const doc = await list('?filter[kind]=manual&filter[lang]=en', READER);
    expect(doc.data.map((d) => d.id)).toEqual([
      'manual:north:operating:en:model=large',
      'manual:north:operating:en:model=small',
      'manual:north:service:en:model=large',
    ]);
    const operating = doc.data[1];
    expect(operating?.attributes).toMatchObject({
      kind: 'manual',
      name: 'Operating manual',
      mediaType: 'application/pdf',
      fileName: 'operating_model-small_en_2.0.pdf',
      manualId: 'operating',
      variant: 'model=small',
      moduleId: null,
      release: { id: second.id },
    });
    // The internal service manual is not the public reader's.
    const seen = await list(
      '?filter[kind]=manual&filter[lang]=en',
      publicReader,
    );
    expect(seen.data.map((d) => d.attributes.manualId)).toEqual([
      'operating',
      'operating',
    ]);
    // The second release changed no manual: its PDF is the first's file, one version.
    const res = await versions('manual:north:operating:en:model=small', READER);
    const history = DownloadVersionPageDocument.parse(res.body);
    expect(history.data.map((v) => [v.id, v.attributes.state])).toEqual([
      [first.id, 'current'],
    ]);
    const pdf = await fileAt(
      'manual:north:operating:en:model=small',
      second.id,
      READER,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(
      'operating_model-small_en_2.0.pdf',
    );
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    );
    expect(operating?.attributes.sha256).toBe(
      history.data[0]?.attributes.sha256,
    );
  });
});
