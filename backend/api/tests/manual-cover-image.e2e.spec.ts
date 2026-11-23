import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type Manifest,
  parseManifest,
  printManifest,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ManualWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ManualDocument } from '../src/manuals/api/manual.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * #394: a manual's cover image, and a variant's own: shown on the PDF's title page, served to the
 * manual's readers, listed in the media library as used by the manual, never deleted while a
 * manual names it, and a missing one a check finding rather than a broken PDF.
 */
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'cover-author',
};
const reader: Actor = {
  ...actorWith(['content.read', 'content.read.draft']),
  id: 'cover-reader',
};

const png = (background: string) =>
  sharp({ create: { width: 64, height: 48, channels: 3, background } })
    .png()
    .toBuffer();

let t: TestApp;
let manual: Buffer;
let variant: Buffer;
const missing = 'e'.repeat(64);
let manifest: Manifest;

beforeAll(async () => {
  t = await createTestApp();
  t.actAs(author);
  manual = await png('#336699');
  variant = await png('#996633');
  for (const data of [manual, variant]) {
    await t.blobs.put(Readable.from([data]), {
      contentType: 'image/png',
      maxBytes: 1_000_000,
    });
  }
  manifest = parseManifest(git('show', 'main:manuals/operating.yaml'), {
    id: 'operating',
  });
  const [first] = manifest.variants;
  const writer = new GitWriter(dir());
  const head = git('rev-parse', 'main');
  for (const [branch, coverImage] of [
    [
      'covers',
      {
        default: {
          asset: `sha256:${sha256(manual)}`,
          alt: { en: 'The vehicle', de: 'Das Fahrzeug' },
        },
        variants: [
          {
            variant: first ?? {},
            asset: `sha256:${sha256(variant)}`,
            alt: 'The large vehicle',
          },
        ],
      },
    ],
    [
      'covers-missing',
      {
        default: { asset: `sha256:${missing}`, alt: 'Gone' },
        variants: [],
      },
    ],
  ] as const) {
    git('branch', branch, head);
    await writer.commit({
      branch,
      parent: head,
      changes: [
        {
          path: 'manuals/operating.yaml',
          content: printManifest({
            ...manifest,
            coverImage: coverImage as unknown as Manifest['coverImage'],
          }),
        },
      ],
      message: 'A cover image',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
  }
}, 60_000);
afterAll(() => t?.close());
afterEach(() => t?.actAs(author));

const slugs = async (ref: string) =>
  ManualDocument.parse(
    (await t.get(`/manuals/operating?ref=${ref}`)).body,
  ).data.meta.variants.map((v) => v.slug);

const pdf = async (ref: string, slug: string, lang = 'en') => {
  const res = await t
    .get(`/manuals/operating/variants/${slug}/${lang}/pdf?ref=${ref}`)
    .set('Accept', 'application/pdf')
    .buffer(true);
  expect(res.status).toBe(200);
  return (res.body as Buffer).toString('latin1');
};

describe('a manual’s cover image (#394)', () => {
  it('is part of the manual’s resource', async () => {
    const doc = ManualDocument.parse(
      (await t.get('/manuals/operating?ref=covers')).body,
    );
    expect(doc.data.attributes.coverImage?.default?.asset).toBe(
      `sha256:${sha256(manual)}`,
    );
    expect(doc.data.attributes.coverImage?.variants).toHaveLength(1);
    expect(
      ManualDocument.parse((await t.get('/manuals/operating')).body).data
        .attributes.coverImage,
    ).toBeUndefined();
  });

  it('shows the variant’s own on its title page, the manual’s on the others', async () => {
    const [first, second] = await slugs('covers');
    expect(first).toBeDefined();
    expect(await pdf('covers', first as string)).toMatch(
      /\/S \/Figure[\s\S]*?\/Alt \(The large vehicle\)/,
    );
    if (second !== undefined) {
      const other = await pdf('covers', second, 'de');
      expect(other).toMatch(/\/S \/Figure[\s\S]*?\/Alt \(Das Fahrzeug\)/);
      expect(other).not.toContain('The large vehicle');
    }
    expect(await pdf('main', first as string)).not.toContain(
      'The large vehicle',
    );
  });

  it('is served to the manual’s readers, and not where no manual names it', async () => {
    t.actAs(reader);
    const hash = sha256(manual);
    expect((await t.get(`/assets/${hash}?ref=main`)).status).toBe(404);
    const res = await t.get(`/assets/${hash}?ref=covers`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is listed in the media library as used by the manual', async () => {
    t.actAs(reader);
    const res = await t.get('/assets?ref=covers&page[size]=100');
    expect(res.status).toBe(200);
    const listed = AssetPageDocument.parse(res.body).data;
    for (const hash of [sha256(manual), sha256(variant)]) {
      const found = listed.find((a) => a.id === hash);
      expect(found?.meta.usedInManuals).toEqual([
        { manualId: 'operating', title: manifest.title },
      ]);
    }
    const searched = AssetPageDocument.parse(
      (await t.get('/assets?ref=covers&filter[q]=operating')).body,
    ).data.map((a) => a.id);
    expect(searched).toContain(sha256(manual));
    const main = AssetPageDocument.parse(
      (await t.get('/assets?ref=main&page[size]=100')).body,
    ).data.map((a) => a.id);
    expect(main).not.toContain(sha256(manual));
  });

  it('is never deleted while a manual names it, however old', async () => {
    const hash = sha256(variant);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(
      join(process.env['CCMS_BLOB_FS_ROOT'] as string, hash.slice(0, 2), hash),
      old,
      old,
    );
    const res = await t.delete(`/assets/${hash}`);
    expect(res.status).toBe(409);
    expect(errors(res.body)[0]?.code).toBe('asset-in-use');
    expect(await t.blobs.exists(hash)).toBe(true);
  });

  it('renders without a missing one, and says so in the checks', async () => {
    const [first] = await slugs('covers-missing');
    expect(await pdf('covers-missing', first as string)).not.toContain(
      '/Alt (Gone)',
    );
    const res = await t.get('/manuals/operating/checks?ref=covers-missing');
    expect(res.status).toBe(200);
    const found = CheckPageDocument.parse(res.body)
      .data.map((c) => c.attributes)
      .filter((c) => c.code === 'missing-cover-image');
    expect(found.map((c) => [c.severity, c.params])).toEqual([
      ['warning', { at: 'coverImage.default', asset: `sha256:${missing}` }],
    ]);
    const fine = await t.get('/manuals/operating/checks?ref=covers');
    expect(
      CheckPageDocument.parse(fine.body).data.filter(
        (c) => c.attributes.code === 'missing-cover-image',
      ),
    ).toEqual([]);
  });

  it('is set in a working copy from an upload of the change set, never from a file the author may not read', async () => {
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Cover' } },
      }),
    );
    expect(created.status).toBe(201);
    const cs = ChangeSetDocument.parse(created.body).data.id;
    const locked = await t.post(`/change-sets/${cs}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'manual', manualId: 'operating' } },
        },
      }),
    );
    expect(locked.status).toBe(201);
    const upload = await t
      .anonymous()
      .post(`/change-sets/${cs}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .attach('file', await png('#669933'), {
        filename: 'cover.png',
        contentType: 'image/png',
      });
    expect(upload.status).toBe(201);
    const reference = ChangeSetAssetDocument.parse(upload.body).data.attributes
      .reference;
    const path = `/change-sets/${cs}/manuals/operating/working-copy`;
    const save = async (asset: string) => {
      const wc = ManualWorkingCopyDocument.parse((await t.get(path)).body).data
        .attributes;
      return t.put(path).send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                ...(wc.content as Manifest),
                coverImage: {
                  default: { asset, alt: 'The vehicle' },
                  variants: [],
                },
              },
            },
          },
          meta: { version: wc.version, baseCommit: wc.baseCommit },
        }),
      );
    };
    const refused = await save(`sha256:${'d'.repeat(64)}`);
    expect(refused.status).toBe(422);
    expect(errors(refused.body)[0]?.code).toBe('unknown-asset');
    const saved = await save(reference);
    expect(saved.status).toBe(200);
    const content = ManualWorkingCopyDocument.parse(saved.body).data.attributes
      .content as Manifest;
    expect(content.coverImage?.default?.asset).toBe(reference);
  });
});
