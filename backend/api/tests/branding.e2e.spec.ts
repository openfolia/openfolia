import sharp from 'sharp';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { DeleteAssetAction } from '../src/assets/core/actions/delete-asset.action.js';
import { ListAssetsAction } from '../src/assets/core/actions/list-assets.action.js';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import {
  BrandingDocument,
  BrandingImageDocument,
} from '../src/branding/api/branding.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const brander: Actor = {
  ...actorWith(['admin.branding']),
  id: 'sample-brander',
};
const roleAdmin: Actor = actorWith(['admin.roles', 'content.read']);
const auditor: Actor = actorWith(['admin.roles']);
const librarian: Actor = actorWith([
  'content.read',
  'content.edit',
  'content.read.draft',
]);
const DAY = 24 * 60 * 60 * 1000;

const png = (width: number, height = width, background = '#4a7740') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

const body = (attributes: Record<string, unknown>) =>
  JSON.stringify({ data: { type: 'Branding', id: 'branding', attributes } });

function upload(t: TestApp, file: Buffer, name = 'logo.png') {
  t.actAs(brander);
  return t
    .post('/branding/images')
    .set('Content-Type', 'multipart/form-data')
    .set(REQUEST_HEADER, '1')
    .attach('file', file, name);
}

async function uploaded(t: TestApp, file: Buffer): Promise<string> {
  const res = await upload(t, file);
  expect([200, 201]).toContain(res.status);
  return BrandingImageDocument.parse(res.body).data.attributes.reference;
}

function patch(t: TestApp, attributes: Record<string, unknown>) {
  t.actAs(brander);
  return t.patch('/branding').send(body(attributes));
}

describe('branding', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('answers the neutral defaults to anyone, without a token, cacheable with an ETag', async () => {
    const res = await t.anonymous().get('/branding').set('Accept', JSON_API);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(res.headers['cache-control']).toBe('public, no-cache');
    const etag = res.headers['etag'] as string;
    expect(etag).toMatch(/^"branding-[\w-]+"$/);
    expect(BrandingDocument.parse(res.body).data).toEqual({
      type: 'Branding',
      id: 'branding',
      attributes: {
        productName: null,
        logoLight: null,
        logoDark: null,
        mark: null,
        favicon: null,
        appIcon: null,
        primary: null,
        accent: null,
        updatedAt: null,
      },
      meta: { tokens: null, contrast: [] },
    });
    const again = await t
      .anonymous()
      .get('/branding')
      .set('If-None-Match', etag);
    expect(again.status).toBe(304);
    expect(again.headers['etag']).toBe(etag);
  });

  it('refuses a change to anyone without admin.branding, an admin of roles too', async () => {
    for (const actor of [roleAdmin, actorWith(['content.read'])]) {
      t.actAs(actor);
      const res = await t.patch('/branding').send(body({ productName: 'X' }));
      expect(res.status).toBe(403);
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
      const sent = await t
        .post('/branding/images')
        .set('Content-Type', 'multipart/form-data')
        .set(REQUEST_HEADER, '1')
        .attach('file', await png(16), 'x.png');
      expect(sent.status).toBe(403);
    }
    expect(
      (
        await t
          .anonymous()
          .patch('/branding')
          .set('Content-Type', JSON_API)
          .send(body({ productName: 'X' }))
      ).status,
    ).toBe(401);
  });

  it('changes name, images and colours, serves the images to anyone, and audits it', async () => {
    const logo = await uploaded(t, await png(240, 48));
    const icon = await uploaded(t, await png(64));
    const before = (await t.anonymous().get('/branding')).headers['etag'];

    const res = await patch(t, {
      productName: '  Example Docs  ',
      logoLight: logo,
      mark: icon,
      favicon: icon,
      appIcon: icon,
      primary: '#1D4ED8',
    });
    expect(res.status).toBe(200);
    const data = BrandingDocument.parse(res.body).data;
    expect(data.attributes).toMatchObject({
      productName: 'Example Docs',
      logoLight: logo,
      logoDark: null,
      mark: icon,
      favicon: icon,
      appIcon: icon,
      primary: '#1d4ed8',
      accent: null,
    });
    expect(data.attributes.updatedAt).not.toBeNull();
    expect(data.meta.tokens?.light.primary).toBe('#1d4ed8');
    expect(data.meta.tokens?.dark.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(data.meta.tokens?.dark.primary).not.toBe('#1d4ed8');
    expect(data.meta.contrast.every((c) => c.ratio >= c.required)).toBe(true);
    // No status or safety colour, ever.
    for (const theme of [data.meta.tokens?.light, data.meta.tokens?.dark]) {
      for (const name of Object.keys(theme ?? {})) {
        expect(name).not.toMatch(/safety|destructive|success|warning|info/);
      }
    }

    const read = await t.anonymous().get('/branding');
    expect(read.headers['etag']).not.toBe(before);
    expect(BrandingDocument.parse(read.body).data.attributes.productName).toBe(
      'Example Docs',
    );

    const hash = logo.slice('sha256:'.length);
    const image = await t.anonymous().get(`/branding/images/${hash}`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.headers['cache-control']).toBe('public, no-cache');
    expect(image.headers['etag']).toBe(`"${hash}"`);
    const again = await t
      .anonymous()
      .get(`/branding/images/${hash}`)
      .set('If-None-Match', `"${hash}"`);
    expect(again.status).toBe(304);
    expect(
      Buffer.from(image.body as Buffer)
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');

    t.actAs(auditor);
    const events = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[subject]=branding')).body,
    ).data;
    const update = events.find(
      (e) => e.attributes.action === 'branding.update',
    );
    expect(update?.attributes.actor).toEqual({
      kind: 'user',
      id: 'sample-brander',
    });
    expect(update?.attributes.data).toMatchObject({
      changed: {
        productName: { from: null, to: 'Example Docs' },
        primary: { from: null, to: '#1d4ed8' },
      },
    });
    expect(
      events.filter((e) => e.attributes.action === 'branding.image-upload'),
    ).toHaveLength(2);
  });

  it('serves no image the branding does not use: an unused upload, a content image, a missing one', async () => {
    const unused = (await uploaded(t, await png(32, 32, '#123456'))).slice(7);
    expect((await t.anonymous().get(`/branding/images/${unused}`)).status).toBe(
      404,
    );
    const missing = 'a'.repeat(64);
    const res = await t.anonymous().get(`/branding/images/${missing}`);
    expect(res.status).toBe(404);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('not-found');
    expect((await t.anonymous().get('/branding/images/nothex')).status).toBe(
      400,
    );
  });

  it('refuses a colour under 4.5:1 with the pair, the ratio and the field, and changes nothing', async () => {
    const before = BrandingDocument.parse(
      (await t.anonymous().get('/branding')).body,
    );
    const res = await patch(t, { primary: '#8fc07f' });
    expect(res.status).toBe(422);
    const errors = ErrorDocument.parse(res.body).errors;
    const failing = errors.find(
      (e) => e.meta?.['pair'] === 'primary/background',
    );
    expect(failing).toMatchObject({
      code: 'insufficient-contrast',
      source: { pointer: '/data/attributes/primary' },
      meta: { theme: 'light', required: 4.5 },
    });
    expect(failing?.meta?.['ratio']).toBeLessThan(4.5);
    expect(failing?.detail).toContain('4.5:1');
    const after = BrandingDocument.parse(
      (await t.anonymous().get('/branding')).body,
    );
    expect(after).toEqual(before);
  });

  it('refuses an image nobody uploaded and a favicon that is not square', async () => {
    const wide = await uploaded(t, await png(64, 32));
    const res = await patch(t, {
      logoDark: `sha256:${'b'.repeat(64)}`,
      favicon: wide,
    });
    expect(res.status).toBe(422);
    const errors = ErrorDocument.parse(res.body).errors;
    expect(errors.map((e) => [e.code, e.source?.pointer])).toEqual([
      ['unknown-image', '/data/attributes/logoDark'],
      ['image-not-square', '/data/attributes/favicon'],
    ]);
    expect(errors[1]?.meta).toEqual({ width: 64, height: 32 });
  });

  it('takes PNG and WebP only: SVG, JPEG and text are refused from the bytes, whatever the name', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    for (const [file, name] of [
      [svg, 'logo.png'],
      [jpeg, 'logo.png'],
      [Buffer.from('hello'), 'logo.webp'],
    ] as const) {
      const res = await upload(t, file, name);
      expect(res.status).toBe(422);
      expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
        code: 'unsupported-image-type',
        meta: { accepted: ['image/png', 'image/webp'] },
      });
    }
    const webp = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#000' },
    })
      .webp()
      .toBuffer();
    const sent = await upload(t, webp, 'icon.webp');
    expect(sent.status).toBe(201);
    expect(
      BrandingImageDocument.parse(sent.body).data.attributes,
    ).toMatchObject({
      contentType: 'image/webp',
      width: 16,
      height: 16,
    });
  });

  it('answers the same image again with its first upload, and refuses one past the size cap', async () => {
    const file = await png(20);
    const first = await upload(t, file);
    const second = await upload(t, file);
    expect([first.status, second.status]).toEqual([201, 200]);
    // The first upload, its upload time moved (#559).
    const attributes = (res: { body: unknown }) =>
      BrandingImageDocument.parse(res.body).data.attributes;
    expect({ ...attributes(second), uploadedAt: null }).toEqual({
      ...attributes(first),
      uploadedAt: null,
    });

    // One byte past the cap, within the multipart allowance: read up to just
    // past the limit, then refused (a far larger body is refused on its
    // Content-Length before reading, the connection closed under the client).
    const large = Buffer.concat([
      file,
      Buffer.alloc(1024 * 1024 + 1 - file.byteLength),
    ]);
    const res = await upload(t, large);
    expect(res.status).toBe(422);
    expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
      code: 'too-large',
      meta: { max: 1024 * 1024 },
    });
  });

  it('keeps its images out of the media library: never listed as unused, never deleted there', async () => {
    const reference = await uploaded(t, await png(24, 24, '#123456'));
    const hash = reference.slice('sha256:'.length);
    // Past the grace period of a fresh upload.
    const later = Date.now() + 2 * DAY;
    vi.spyOn(t.app.get(ListAssetsAction), 'now').mockReturnValue(later);
    vi.spyOn(t.app.get(DeleteAssetAction), 'now').mockReturnValue(later);
    try {
      t.actAs(librarian);
      const unused = AssetPageDocument.parse(
        (await t.get('/assets?filter[unused]=true&page[size]=100')).body,
      );
      expect(unused.data.map((a) => a.id)).not.toContain(hash);
      const deleted = await t.delete(`/assets/${hash}`);
      expect(deleted.status).toBe(409);
      expect(ErrorDocument.parse(deleted.body).errors[0]).toMatchObject({
        code: 'asset-in-use',
        meta: { usedIn: [{ in: 'branding' }] },
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(await t.blobs.exists(hash)).toBe(true);
  });

  it('refuses a name with control, format or line-break characters', async () => {
    for (const name of ['Docs\u0007', 'Docs\u202e', 'Docs\u2028Two']) {
      const res = await patch(t, { productName: name });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
  });

  it('needs X-Ccms-Request on the upload, as every form does', async () => {
    t.actAs(brander);
    const res = await t
      .post('/branding/images')
      .set('Content-Type', 'multipart/form-data')
      .attach('file', await png(8), 'x.png');
    expect(res.status).toBe(403);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'request-header-required',
    );
  });

  it('resets to the defaults with nulls, and an unknown attribute is refused', async () => {
    const unknown = await patch(t, { font: 'Comic' });
    expect(unknown.status).toBe(400);
    const res = await patch(t, {
      productName: null,
      logoLight: null,
      logoDark: null,
      mark: null,
      favicon: null,
      appIcon: null,
      primary: null,
      accent: null,
    });
    expect(res.status).toBe(200);
    const data = BrandingDocument.parse(res.body).data;
    expect(data.meta).toEqual({ tokens: null, contrast: [] });
    expect(Object.values(data.attributes).filter((v) => v !== null)).toEqual([
      data.attributes.updatedAt,
    ]);
  });
});
