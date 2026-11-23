import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { PNG_HASH } from '@openfolia/content-repo/testing';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { ImageResizer } from '../src/assets/core/image-resizer.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { DeleteAssetAction } from '../src/assets/core/actions/delete-asset.action.js';
import { ListAssetsAction } from '../src/assets/core/actions/list-assets.action.js';
import {
  releaseOutputs,
  releases,
} from '../src/releases/repos/releases.tables.js';
import { StorageUsageDocument } from '../src/storage-usage/api/storage-usage.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const blobRoot = () => process.env['CCMS_BLOB_FS_ROOT'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const AUTHOR = { name: 'Test', email: 'test@example.com' };
const DAY = 24 * 60 * 60 * 1000;

const editor: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-editor',
};
const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};

let t: TestApp;
let writer: GitWriter;

beforeAll(async () => {
  t = await createTestApp();
  writer = new GitWriter(dir());
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

/** Stores `data` in the app's blob store, `daysAgo` days old. */
async function store(
  data: Buffer,
  contentType: string,
  daysAgo = 0,
): Promise<string> {
  const { sha256 } = await t.blobs.put(Readable.from([data]), {
    contentType,
    maxBytes: 100_000_000,
  });
  if (daysAgo > 0) {
    const at = new Date(Date.now() - daysAgo * DAY);
    utimesSync(join(blobRoot(), sha256.slice(0, 2), sha256), at, at);
  }
  return sha256;
}

/** Commits `modules/en/gallery.adoc` on main showing `hashes` (none: removes it); the new commit. */
async function gallery(...hashes: string[]): Promise<string> {
  const main = git('rev-parse', 'refs/heads/main');
  const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  const module: Module = {
    ...charging,
    id: 'gallery',
    meta: { ...charging.meta, title: 'Gallery' },
    blocks: hashes.map((hash, n) => ({
      type: 'image',
      id: `image-${n}`,
      asset: `sha256:${hash}`,
      alt: 'A picture',
    })),
  };
  const path = 'modules/en/gallery.adoc';
  const done = await writer.commit({
    branch: 'main',
    parent: main,
    changes: [
      hashes.length > 0
        ? { path, content: printModule(module) }
        : { path, delete: true },
    ],
    message: 'Gallery',
    author: AUTHOR,
  });
  return done.commit;
}

const errorOf = (body: unknown) => ErrorDocument.parse(body).errors[0];

describe('renditions', () => {
  it('makes a 640-pixel WebP of a 4000-pixel image once, then serves it from the store', async () => {
    const big = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: '#468' },
    })
      .png()
      .toBuffer();
    const hash = await store(big, 'image/png');
    await gallery(hash);
    const resizer = t.app.get(ImageResizer);
    const made = vi.spyOn(resizer, 'toWebp');
    try {
      for (let n = 0; n < 2; n++) {
        const res = await t
          .get(`/assets/${hash}?width=640`)
          .buffer(true)
          .parse((r, done) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => done(null, Buffer.concat(chunks)));
          });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/webp');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        const meta = await sharp(res.body as Buffer).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual([
          'webp',
          640,
          320,
        ]);
      }
      expect(made).toHaveBeenCalledTimes(1);
    } finally {
      made.mockRestore();
    }
  });

  it('never upscales, and reads the old layout too', async () => {
    // The sample's PNG (480×300) is in the repository, not the store.
    const res = await t
      .get(`/assets/${PNG_HASH}?width=1280`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const meta = await sharp(res.body as Buffer).metadata();
    expect([meta.format, meta.width]).toEqual(['webp', 480]);
  });

  it('is 404 outside the reader’s scope, like the original', async () => {
    t.actAs(actorWith(['content.read'], { languages: ['xx'] }));
    for (const path of [
      `/assets/${PNG_HASH}`,
      `/assets/${PNG_HASH}?width=320`,
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(errorOf(res.body)?.code).toBe('not-found');
    }
  });

  it('refuses another width, and a rendition of an SVG (400 invalid-parameter)', async () => {
    const svg = await store(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
      ),
      'image/svg+xml',
    );
    await gallery(svg);
    for (const path of [
      `/assets/${PNG_HASH}?width=500`,
      `/assets/${svg}?width=320`,
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(errorOf(res.body)).toMatchObject({
        code: 'invalid-parameter',
        source: { parameter: 'width' },
      });
    }
  });

  it('gives the author a rendition of an upload into their change set', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Pictures' } },
      }),
    );
    const changeSetId = ChangeSetDocument.parse(created.body).data.id;
    const png = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#864' },
    })
      .png()
      .toBuffer();
    const uploaded = await t
      .post(`/change-sets/${changeSetId}/assets`)
      .set('Content-Type', 'multipart/form-data')
      .set(REQUEST_HEADER, '1')
      .attach('file', png, 'picture.png');
    expect(uploaded.status).toBe(201);
    const hash = (uploaded.body as { data: { id: string } }).data.id.split(
      '/',
    )[1];
    const res = await t.get(
      `/change-sets/${changeSetId}/assets/${hash}?width=320`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const other = await t.get(
      `/change-sets/${changeSetId}/assets/${hash}?width=7`,
    );
    expect(other.status).toBe(400);
  });
});

describe('GET /assets: languages', () => {
  it('names the languages using a file, and filters by one', async () => {
    const all = AssetPageDocument.parse((await t.get('/assets')).body);
    const png = all.data.find((a) => a.id === PNG_HASH);
    expect(png?.meta.languages).toContain('en');
    const english = AssetPageDocument.parse(
      (await t.get('/assets?filter[lang]=en')).body,
    );
    expect(english.data.map((a) => a.id)).toContain(PNG_HASH);
    const none = AssetPageDocument.parse(
      (await t.get('/assets?filter[lang]=xx')).body,
    );
    expect(none.data).toEqual([]);
    expect(none.meta.page.total).toBe(0);
  });
});

describe('unused files', () => {
  const unusedIds = async () => {
    const res = await t.get('/assets?filter[unused]=true&page[size]=200');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    return AssetPageDocument.parse(res.body).data.map((a) => a.id);
  };

  it('keeps a file only an old release tag refers to, and deletes it once nothing does', async () => {
    const data = Buffer.concat([
      await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#123' },
      })
        .png()
        .toBuffer(),
      Buffer.from('#released-once'),
    ]);
    const hash = await store(data, 'image/png', 3);
    const tagged = await gallery(hash);
    await writer.createTag({
      name: 'v-old',
      commit: tagged,
      message: 'An old release',
      tagger: AUTHOR,
    });
    await gallery();
    t.actAs(editor);
    expect(await unusedIds()).not.toContain(hash);
    const refused = await t.delete(`/assets/${hash}`);
    expect(refused.status).toBe(409);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'release', ref: 'v-old' }] },
    });
    // Its last reference goes (a tag is never removed through the API).
    git('tag', '-d', 'v-old');
    expect(await unusedIds()).toContain(hash);
    const deleted = await t.delete(`/assets/${hash}`);
    expect(deleted.status).toBe(204);
    expect(await t.blobs.exists(hash)).toBe(false);
    expect(await unusedIds()).not.toContain(hash);
    expect((await t.delete(`/assets/${hash}`)).status).toBe(404);
    t.actAs(actorWith(['admin.roles']));
    const audit = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=asset.delete')).body,
    );
    expect(audit.data.map((e) => e.attributes.subject)).toContainEqual({
      type: 'asset',
      id: hash,
    });
  });

  it('keeps where files are used as an index of the refs’ commits, rebuilt when dropped (#476)', async () => {
    const hash = await store(Buffer.from('#indexed'), 'text/plain', 3);
    t.actAs(editor);
    // A push (not through the API) is seen on the next request.
    const shown = await gallery(hash);
    expect(await unusedIds()).not.toContain(hash);
    const indexed = async () =>
      (
        await t.database.db.execute<{ commit: string }>(
          sql`select commit from asset_reference_commits where ${hash} = any(hashes)`,
        )
      ).rows.map((row) => row.commit);
    expect(await indexed()).toEqual([shown]);
    // Dropped (as by hand): the next request builds what it needs again.
    await t.database.db.execute(sql`delete from asset_reference_commits`);
    const removed = await gallery();
    expect(await unusedIds()).toContain(hash);
    const commits = (
      await t.database.db.execute<{ commit: string }>(
        sql`select commit from asset_reference_commits`,
      )
    ).rows.map((row) => row.commit);
    expect(commits).toContain(removed);
    expect(commits).not.toContain(shown);
    // Shown again: refused, naming main.
    await gallery(hash);
    const refused = await t.delete(`/assets/${hash}`);
    expect(refused.status).toBe(409);
    expect(errorOf(refused.body)?.meta).toMatchObject({
      usedIn: [{ in: 'main', ref: 'main' }],
    });
    await gallery();
  });

  it('keeps an archived release PDF: never unused, a delete refused unaudited, and only its uploads deleted (#429)', async () => {
    const pdf = Buffer.from('%PDF-1.7\n% an archived release file\n%%EOF\n');
    const hash = await store(pdf, 'application/pdf', 3);
    // A done release output whose file it is.
    const releaseId = '01900000-0000-7000-8000-000000000429';
    const at = new Date(Date.now() - 3 * DAY);
    await t.database.db.insert(releases).values({
      id: releaseId,
      product: 'north',
      productFacet: 'product',
      revision: 'archived-429',
      tag: 'north/archived-429',
      commit: 'a'.repeat(40),
      publishedByKind: 'user',
      publishedById: 'sample-publisher',
      publishedAt: at,
    });
    await t.database.db.insert(releaseOutputs).values({
      id: '01900000-0000-7000-8000-000000000430',
      releaseId,
      kind: 'pdf',
      manualId: 'm',
      variant: 'model=large',
      lang: 'en',
      state: 'done',
      sha256: hash,
      size: pdf.length,
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    });
    const admin = actorWith(['admin.roles']);
    const totals = async () => {
      t.actAs(admin);
      const res = await t.get('/storage-usage');
      expect(res.status).toBe(200);
      const { media, archivedPdfs } = StorageUsageDocument.parse(res.body).data
        .attributes;
      return { media, archivedPdfs };
    };
    const deletions = async () => {
      t.actAs(admin);
      const res = await t.get(
        '/audit-events?filter[action]=asset.delete&page[size]=100',
      );
      expect(res.status).toBe(200);
      return AuditEventPageDocument.parse(res.body).data.filter(
        (e) => e.attributes.subject.id === hash,
      );
    };
    const before = await totals();

    t.actAs(editor);
    expect(await unusedIds()).not.toContain(hash);
    const refused = await t.delete(`/assets/${hash}`);
    expect(refused.status).toBe(409);
    expect(refused.headers['content-type']).toBe(JSON_API);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'release-output' }] },
    });
    expect(await t.blobs.exists(hash)).toBe(true);
    expect(await deletions()).toEqual([]);
    expect(await totals()).toEqual(before);

    // Someone attaches the release's PDF in a change set that is then abandoned.
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Attach a manual' } },
      }),
    );
    const changeSetId = ChangeSetDocument.parse(created.body).data.id;
    const uploaded = await t
      .post(`/change-sets/${changeSetId}/assets?kind=attachment`)
      .set('Content-Type', 'multipart/form-data')
      .set(REQUEST_HEADER, '1')
      .attach('file', pdf, {
        filename: 'manual.pdf',
        contentType: 'application/pdf',
      });
    expect(uploaded.status).toBe(201);
    expect((await t.post(`/change-sets/${changeSetId}/abandon`)).status).toBe(
      200,
    );
    expect(await totals()).toEqual(before);
    // Past the upload's grace period.
    const later = Date.now() + 2 * DAY;
    const list = t.app.get(ListAssetsAction);
    const del = t.app.get(DeleteAssetAction);
    const clocks = [
      vi.spyOn(list, 'now').mockReturnValue(later),
      vi.spyOn(del, 'now').mockReturnValue(later),
    ];
    try {
      t.actAs(editor);
      expect(await unusedIds()).toContain(hash);
      expect((await t.delete(`/assets/${hash}`)).status).toBe(204);
      // The uploads went, the archived file stays.
      expect(await t.blobs.exists(hash)).toBe(true);
      expect(await unusedIds()).not.toContain(hash);
      const refusedAgain = await t.delete(`/assets/${hash}`);
      expect(errorOf(refusedAgain.body)).toMatchObject({
        code: 'asset-in-use',
        meta: { usedIn: [{ in: 'release-output' }] },
      });
    } finally {
      for (const clock of clocks) clock.mockRestore();
    }
    const events = await deletions();
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes.data).toMatchObject({
      uploads: 1,
      fileKept: true,
    });
    expect(await totals()).toEqual(before);
  });

  it('keeps a file stored within a day', async () => {
    const hash = await store(Buffer.from('#fresh'), 'application/zip');
    t.actAs(editor);
    expect(await unusedIds()).not.toContain(hash);
    const refused = await t.delete(`/assets/${hash}`);
    expect(refused.status).toBe(409);
    expect(errorOf(refused.body)?.meta).toMatchObject({
      usedIn: [{ in: 'recent-upload' }],
    });
  });

  it('is only for content.read.draft and content.edit whose scope restricts nothing', async () => {
    const hash = await store(Buffer.from('#old orphan'), 'image/png', 3);
    for (const actor of [
      actorWith(['content.read', 'content.read.draft', 'content.edit'], {
        languages: ['en'],
      }),
      actorWith(['content.read']),
      // A contributor: unused files include other people's draft uploads (#137).
      actorWith(['content.read', 'content.edit']),
    ]) {
      t.actAs(actor);
      expect((await t.get('/assets?filter[unused]=true')).status).toBe(403);
      expect((await t.delete(`/assets/${hash}`)).status).toBe(403);
    }
    expect(await t.blobs.exists(hash)).toBe(true);
  });

  it('refuses a malformed hash and a bad filter value (400)', async () => {
    t.actAs(editor);
    expect((await t.delete('/assets/nope')).status).toBe(404);
    expect((await t.get('/assets?filter[unused]=yes')).status).toBe(400);
  });
});
