import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import { PNG_HASH } from '@openfolia/content-repo/testing';
import jsQRModule from 'jsqr';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { StableAddressPageDocument } from '../src/addresses/api/stable-address.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { PreviewManualAction } from '../src/preview/core/actions/preview-manual.action.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders the PDFs of a few releases.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// jsqr is CommonJS typed as an ES module: at run time its default import is the function.
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;

const PUBLIC_URL = 'https://docs.example.com/manuals/';
const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp({
    CCMS_PUBLIC_URL: PUBLIC_URL,
    // Invented names: a prefix and one parameter of a link shared elsewhere (#553).
    CCMS_DELIVERY_IGNORED_QUERY: 'utm_*,click_ref',
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const commit = async (path: string, content: string, message: string) =>
  new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [{ path, content }],
    message,
    author: { name: 'Someone', email: 'someone@example.com' },
  });

/** The configuration on main with `delivery` set to `yaml` (indented lines). */
const original = { config: '' };
const delivery = async (yaml: string) => {
  if (original.config === '')
    original.config = git('show', 'main:openfolia.yaml');
  const config = `${original.config.trimEnd()}\ndelivery:\n${yaml}\n`;
  // Already set: nothing to commit.
  if (git('show', 'main:openfolia.yaml') === config.trim()) return;
  await commit('openfolia.yaml', config, 'Delivery settings');
};

const cut = async (revision: string) => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  t.actAs(undefined);
  await t.runJobs();
  return ReleaseDocument.parse(res.body).data;
};

const BASE = '/d/north/operating/model=large';

/** The OpenAPI document's answers of a route, by its path template (`/d/{product}/…`). */
let openapi: { paths: Record<string, { get?: { responses: object } }> };
const documented = async (template: string) => {
  openapi ??= (await t.anonymous().get('/openapi.json')).body as typeof openapi;
  return Object.keys(openapi.paths[template]?.get?.responses ?? {});
};
const ADDRESS = '/d/{product}/{manual}/{variant}/{lang}';
/** Checks that the route of `template` documents `status`, as answered. */
const expectDocumented = async (template: string, status: number) => {
  expect(await documented(template)).toContain(String(status));
};

/** As `as` with the token (`null`: without a token), the body as bytes. */
const read = (path: string, as: Actor | null = READER) => {
  t.actAs(as ?? undefined);
  return (as ? t.get(path) : t.anonymous().get(path))
    .set('Accept', '*/*')
    .redirects(0)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
};
const text = (body: unknown) => (body as Buffer).toString('utf8');
const codeOf = (body: unknown) =>
  ErrorDocument.parse(JSON.parse(text(body))).errors[0]?.code;

/** What a QR code PNG holds, read as a scanner would. */
const decode = async (image: Buffer) => {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
};

/**
 * What a QR code SVG holds: its path drawn at 8 pixels a unit, then read. (The API blocks
 * sharp's SVG loader process-wide, so it cannot rasterise it here.)
 */
const decodeSvg = (svg: string) => {
  const side = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1]);
  const scale = 8;
  const width = side * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  const path = /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row++) {
      for (
        let col = Number(x) * scale;
        col < (Number(x) + Number(w)) * scale;
        col++
      ) {
        const at = (row * width + col) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width, width)?.data;
};

describe('stable addresses (#450)', () => {
  let first: Awaited<ReturnType<typeof cut>>;
  let second: Awaited<ReturnType<typeof cut>>;

  it('opens nothing before a release, and needs a token by default', async () => {
    expect((await read(`${BASE}/en`)).status).toBe(404);
    const anonymous = await read(`${BASE}/en`, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
  });

  it('opens the latest release’s manual, its PDF and QR codes; a pinned address for good', async () => {
    first = await cut('1.0');
    const page = await read(`${BASE}/en`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('private, no-cache');
    expect(page.headers['vary']).toMatch(/Authorization/);
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
    expect(page.headers['x-ccms-issues']).toBeUndefined();
    // Stylesheets from the address pages' own route, relative to the page.
    expect(text(page.body)).toContain('href="../../../../d/-/theme.css"');
    const etag = page.headers['etag'] as string;
    t.actAs(READER);
    // The ETag is known before rendering (#552): a revalidation renders nothing.
    const renders = vi.spyOn(t.app.get(PreviewManualAction), 'handle');
    try {
      expect(
        (await t.get(`${BASE}/en`).set('If-None-Match', etag)).status,
      ).toBe(304);
      expect(renders).not.toHaveBeenCalled();
      // Another theme is another page.
      expect(
        (await t.get(`${BASE}/en?theme=dark`).set('If-None-Match', etag))
          .status,
      ).toBe(200);
      expect(renders).toHaveBeenCalledTimes(1);
    } finally {
      renders.mockRestore();
    }
    const css = await read('/d/-/theme.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);

    const pinned = await read(`${BASE}/en@1.0`);
    expect(pinned.status).toBe(200);
    // Pinned, yet revalidated: a withdrawal must reach every cache.
    expect(pinned.headers['cache-control']).toBe('private, no-cache');

    const pdf = await read(`${BASE}/en/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^inline; /);
    expect(text(pdf.body).startsWith('%PDF')).toBe(true);

    const svg = await read(`${BASE}/en/qr.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(decodeSvg(text(svg.body))).toBe(
      `${PUBLIC_URL}d/north/operating/model=large/en`,
    );
    const png = await read(`${BASE}/en@1.0/pdf/qr.png`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(await decode(png.body as Buffer)).toBe(
      `${PUBLIC_URL}d/north/operating/model=large/en@1.0/pdf`,
    );
    // Only for an address that opens.
    expect((await read('/d/north/operating/model=huge/en/qr.svg')).status).toBe(
      404,
    );
  });

  it('moves the latest address to a new release at once; the pinned one stays', async () => {
    const before = text((await read(`${BASE}/de`)).body);
    await commit(
      'modules/de/charging.adoc',
      git('show', 'main:modules/de/charging.adoc').replace(
        /Das \{product-name\} [^\n]*/,
        'Das {product-name} lädt jetzt neu.',
      ),
      'Reword German charging',
    );
    // On main, not released: no address shows it.
    expect(text((await read(`${BASE}/de`)).body)).toBe(before);
    second = await cut('2.0');
    expect(text((await read(`${BASE}/de`)).body)).toContain('lädt jetzt neu');
    expect(text((await read(`${BASE}/de@1.0`)).body)).not.toContain(
      'lädt jetzt neu',
    );

    t.actAs(READER);
    const latest = await t.get('/stable-addresses?filter[manual]=operating');
    expect(latest.status).toBe(200);
    const doc = StableAddressPageDocument.parse(latest.body);
    expect(doc.meta).toMatchObject({
      access: 'signed-in',
      publicUrl: PUBLIC_URL,
    });
    expect(doc.data.every((a) => a.attributes.revision === '2.0')).toBe(true);
    const large = doc.data.find(
      (a) =>
        a.attributes.variant === 'model=large' && a.attributes.lang === 'en',
    );
    expect(large?.attributes.latest.html).toEqual({
      path: '/d/north/operating/model=large/en',
      url: `${PUBLIC_URL}d/north/operating/model=large/en`,
    });
    expect(large?.attributes.pinned.pdf.path).toBe(
      '/d/north/operating/model=large/en@2.0/pdf',
    );
    expect(large?.meta).toEqual({
      latestRelease: true,
      withdrawn: false,
      pdfReady: true,
    });
    const old = StableAddressPageDocument.parse(
      (
        await t.get(
          `/stable-addresses?filter[release]=${first.id}&page[size]=1`,
        )
      ).body,
    );
    expect(old.data[0]?.meta.latestRelease).toBe(false);
    expect(old.meta.page.total).toBeGreaterThan(1);
  });

  it('keeps manuals beyond the reader’s scope out, alike', async () => {
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    expect((await read('/d/north/service/model=large/en')).status).toBe(200);
    const hidden = await read('/d/north/service/model=large/en', publicOnly);
    expect(hidden.status).toBe(404);
    expect(codeOf(hidden.body)).toBe('not-found');
    const listed = StableAddressPageDocument.parse(
      (await (t.actAs(publicOnly), t.get('/stable-addresses'))).body,
    );
    expect(listed.data.some((a) => a.attributes.manual === 'service')).toBe(
      false,
    );
    // Without content.read: 403, before anything is looked up.
    const nobody = await read(`${BASE}/en`, actorWith([]));
    expect(nobody.status).toBe(403);
  });

  it('opens public addresses without a token, as the public audience reads them', async () => {
    await delivery('  access: public');
    const page = await read(`${BASE}/en`, null);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('public, no-cache');
    expect((await read(`${BASE}/en/pdf`, null)).status).toBe(200);
    // An internal manual is no public one.
    expect((await read('/d/north/service/model=large/en', null)).status).toBe(
      404,
    );
    // Never a branch: only release tags are read.
    expect(
      (await read('/d/north/operating/model=large/en@main', null)).status,
    ).toBe(404);
  });

  it('redirects a language’s case and a moved manual, and offers the languages there are', async () => {
    await delivery(
      '  access: public\n  manuals:\n    operating: { slug: guide }',
    );
    const moved = await read(`${BASE}/EN`, null);
    expect(moved.status).toBe(301);
    await expectDocumented(ADDRESS, 301);
    const movedPdf = await read(`${BASE}/EN/pdf`, null);
    expect(movedPdf.status).toBe(301);
    await expectDocumented(`${ADDRESS}/pdf`, 301);
    expect(moved.headers['location']).toBe(
      '../../../../d/north/guide/model=large/en',
    );
    expect(moved.headers['cache-control']).toBe('public, no-cache');
    // A hash that is not one is 404 before any redirect could carry it.
    expect(
      (await read(`${BASE}/EN/assets/..%2F..%2Fapi%2Fmanuals`, null)).status,
    ).toBe(404);
    expect((await read('/d/north/guide/model=large/en', null)).status).toBe(
      200,
    );
    expect(
      (await read('/d/north/guide/model=large/en@1.0/pdf', null)).status,
    ).toBe(200);
    // A moved address of a manual the reader may not see: not found, not moved.
    await delivery(
      '  access: public\n  manuals:\n    service: { slug: staff }',
    );
    expect((await read('/d/north/service/model=large/en', null)).status).toBe(
      404,
    );

    const picker = await read(`${BASE}/es`, null);
    expect(picker.status).toBe(300);
    expect(picker.headers['content-type']).toBe('text/html; charset=utf-8');
    await expectDocumented(ADDRESS, 300);
    expect(text(picker.body)).toContain(
      'href="../../../../d/north/operating/model=large/de"',
    );
    await delivery('  access: public\n  missingLanguage: source');
    const source = await read(`${BASE}/es`, null);
    expect(source.status).toBe(302);
    await expectDocumented(ADDRESS, 302);
    expect((await read(`${BASE}/es/qr.svg`, null)).status).toBe(302);
    await expectDocumented(`${ADDRESS}/qr.svg`, 302);
    expect(source.headers['location']).toBe(
      '../../../../d/north/operating/model=large/en',
    );
  });

  it('shows a withdrawn release’s notice, and the latest address goes back to the one before', async () => {
    // A page's image, before: kept a day by a reader's browser, but a shared cache (a proxy,
    // a CDN) must ask again within minutes (#552), cheaply, by its ETag.
    const image = `${BASE}/de@2.0/assets/${PNG_HASH}`;
    expect(text((await read(`${BASE}/de@2.0`, null)).body)).toContain(
      `assets/${PNG_HASH}`,
    );
    const before = await read(image, null);
    expect(before.status).toBe(200);
    expect(before.headers['cache-control']).toBe(
      'public, max-age=86400, s-maxage=300, proxy-revalidate',
    );
    expect(before.headers['etag']).toBe(`"${PNG_HASH}"`);
    const revalidate = () =>
      t.anonymous().get(image).set('If-None-Match', `"${PNG_HASH}"`);
    expect((await revalidate()).status).toBe(304);
    // A token changes nothing on a public address (#608): the public's answer.
    const withToken = await read(image);
    expect(withToken.headers['cache-control']).toBe(
      before.headers['cache-control'],
    );
    expect(withToken.headers['vary']).toBe(before.headers['vary']);
    // A signed-in reader's, on a `signed-in` address: never in a shared cache.
    await delivery('  access: signed-in');
    const signedIn = await read(image);
    expect(signedIn.headers['cache-control']).toBe('private, max-age=86400');
    expect(signedIn.headers['vary']).toMatch(/Authorization/);
    await delivery('  access: public');

    t.actAs(publisher);
    const withdrawn = await t
      .post(`/releases/${second.id}/withdraw`)
      .send(JSON.stringify({ meta: { reason: 'Wrong values.' } }));
    expect(withdrawn.status).toBe(200);
    const notice = await read(`${BASE}/de@2.0`, null);
    expect(notice.status).toBe(410);
    expect(notice.headers['content-type']).toBe('text/html; charset=utf-8');
    await expectDocumented(ADDRESS, 410);
    expect(text(notice.body)).toContain('zurückgezogen');
    expect(text(notice.body)).toContain(
      'href="../../../../d/north/operating/model=large/de"',
    );
    // The shared cache's revalidation: gone.
    expect((await revalidate()).status).toBe(410);
    const gone = await read(`${BASE}/de@2.0/pdf`, null);
    expect(gone.status).toBe(410);
    expect(codeOf(gone.body)).toBe('release-withdrawn');
    expect(ErrorDocument.safeParse(JSON.parse(text(gone.body))).success).toBe(
      true,
    );
    for (const route of [
      '/pdf',
      '/qr.svg',
      '/qr.png',
      '/pdf/qr.svg',
      '/pdf/qr.png',
      '/assets/{hash}',
      '/symbols/{id}',
    ]) {
      await expectDocumented(`${ADDRESS}${route}`, 410);
      await expectDocumented(`${ADDRESS}${route}`, 301);
      await expectDocumented(`${ADDRESS}${route}`, 302);
    }
    expect(text((await read(`${BASE}/de`, null)).body)).not.toContain(
      'lädt jetzt neu',
    );
  });

  it('ignores the configured tracking parameters, and refuses any other (#553)', async () => {
    await delivery('  access: public');
    const plain = await read(`${BASE}/en`, null);
    expect(plain.status).toBe(200);
    const shared = await read(`${BASE}/en?utm_source=x&click_ref=y`, null);
    expect(shared.status).toBe(200);
    expect(text(shared.body)).toBe(text(plain.body));
    expect(shared.headers['etag']).toBe(plain.headers['etag']);
    // The route's own parameter stays, beside them.
    const dark = await read(`${BASE}/en?utm_medium=x&theme=dark`, null);
    expect(dark.status).toBe(200);
    expect(text(dark.body)).toBe(
      text((await read(`${BASE}/en?theme=dark`, null)).body),
    );
    expect((await read(`${BASE}/en/pdf?utm_source=x`, null)).status).toBe(200);
    expect((await read(`${BASE}/en/qr.svg?click_ref=y`, null)).status).toBe(
      200,
    );
    // A moved address goes on without them.
    const moved = await read(`${BASE}/EN?utm_source=x`, null);
    expect(moved.status).toBe(301);
    expect(moved.headers['location']).toBe(
      '../../../../d/north/operating/model=large/en',
    );
    // Anything else is still refused, on the page and on its files.
    for (const path of [
      `${BASE}/en?utm_source=x&other=1`,
      `${BASE}/en/pdf?other=1`,
      `${BASE}/en/qr.svg?click_refs=1`,
    ]) {
      const refused = await read(path, null);
      expect(refused.status).toBe(400);
      expect(codeOf(refused.body)).toBe('unsupported-parameter');
    }
    await expectDocumented(ADDRESS, 400);
  });

  it('answers nobody when the addresses are off', async () => {
    await delivery('  access: off');
    expect((await read(`${BASE}/en`, null)).status).toBe(404);
    expect((await read(`${BASE}/en`)).status).toBe(404);
  });
});
