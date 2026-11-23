import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { PNG } from '@openfolia/content-repo/testing';
import { unzipSync } from 'fflate';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ReleaseOutputPageDocument } from '../src/releases/api/release-output.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders the sample's PDFs, then six packages, then opens one in a browser.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A PNG of its own (the sample's, bytes added after its end), and an attached file: both only in an internal module. */
const ATTACHED = Buffer.from('%PDF-1.4\n% Internal wiring diagram\n%%EOF\n');
const INTERNAL_TEXT = 'Internal only.';
/** An author's SVG that runs script when opened as a document, and reaches out. */
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20" onload="alert(1)">' +
    '<script>alert(2)</script><rect width="20" height="20" fill="#c00" onmouseover="alert(3)"/>' +
    '<a xlink:href="javascript:alert(4)"><circle r="5"/></a></svg>',
);

let t: TestApp;
let releaseId = '';
let revision = '';
let internalImage = '';
let internalAttachment = '';
let hostileSvg = '';
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

type Package = Record<string, Uint8Array>;
const packages = new Map<string, { id: string; files: Package }>();

const list = async (as: Actor, query = '') => {
  t.actAs(as);
  const res = await t.get(
    `/releases/${releaseId}/outputs?filter[kind]=offline-package${query}`,
  );
  expect(res.status).toBe(200);
  return ReleaseOutputPageDocument.parse(res.body);
};

const download = (id: string, as: Actor) => {
  t.actAs(as);
  return t
    .get(`/releases/${releaseId}/outputs/${id}/file`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
};

beforeAll(async () => {
  t = await createTestApp({ CCMS_OFFLINE_PACKAGES: 'true' });
  // An image and an attached file only the internal module shows, from the blob store.
  const png = await t.blobs.put(
    Readable.from([Buffer.concat([PNG, Buffer.from('internal')])]),
    {
      contentType: 'image/png',
      maxBytes: 1_000_000,
    },
  );
  const attached = await t.blobs.put(Readable.from([ATTACHED]), {
    contentType: 'application/pdf',
    maxBytes: 1_000_000,
  });
  hostileSvg = (
    await t.blobs.put(Readable.from([HOSTILE_SVG]), {
      contentType: 'image/svg+xml',
      maxBytes: 1_000_000,
    })
  ).sha256;
  internalImage = png.sha256;
  internalAttachment = attached.sha256;
  const path = 'modules/en/internals.adoc';
  const internals = parseModule(git('show', `main:${path}`), {
    id: 'internals',
  });
  const changed: Module = {
    ...internals,
    blocks: [
      ...internals.blocks,
      {
        type: 'image',
        id: 'wiring',
        asset: `sha256:${internalImage}`,
        alt: 'Wiring',
      },
      {
        type: 'image',
        id: 'drawn',
        asset: `sha256:${hostileSvg}`,
        alt: 'Drawn',
      },
      {
        type: 'attachment',
        id: 'diagram',
        asset: `sha256:${internalAttachment}`,
        name: 'Wiring diagram',
        fileName: 'wiring.pdf',
        mediaType: 'application/pdf',
        size: ATTACHED.length,
      },
    ],
  };
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [{ path, content: printModule(changed) }],
    message: 'Internal wiring',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  revision = '7.0';
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  releaseId = ReleaseDocument.parse(res.body).data.id;
  // Planning, every PDF, then the packages (each waits for the PDFs).
  while ((await t.runJobs()) > 0);
  for (const o of (await list(publisher)).data) {
    const res = await download(o.id, publisher);
    expect(res.status).toBe(200);
    packages.set(`${o.attributes.lang}/${o.attributes.audience}`, {
      id: o.id,
      files: unzipSync(new Uint8Array(res.body as Buffer)),
    });
  }
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const pkg = (key: string) => {
  const found = packages.get(key);
  if (!found) throw new Error(`No package ${key}: ${[...packages.keys()]}`);
  return found;
};

describe('offline packages (#59)', () => {
  it('are one per language and audience level, done once the PDFs are, a ZIP by its name', async () => {
    const page = await list(publisher);
    expect(
      page.data
        .map(
          (o) =>
            `${o.attributes.state} ${o.attributes.lang}/${o.attributes.audience}`,
        )
        .sort(),
    ).toEqual([
      'done de/internal',
      'done de/public',
      'done en/internal',
      'done en/public',
      'done fr/internal',
      'done fr/public',
    ]);
    for (const o of page.data) {
      expect(o.attributes).toMatchObject({
        kind: 'offline-package',
        manual: null,
        variant: null,
      });
      expect(o.meta.design).toBeUndefined();
    }
    const one = await download(pkg('en/public').id, publisher);
    expect(one.headers['content-type']).toBe('application/zip');
    expect(one.headers['content-disposition']).toContain(
      `offline_public_en_${revision}.zip`,
    );
    // The PDFs only, with no kind filter: the packages are listed beside them.
    t.actAs(publisher);
    const pdfs = await t.get(`/releases/${releaseId}/outputs?filter[kind]=pdf`);
    expect(pdfs.status).toBe(200);
    expect(
      ReleaseOutputPageDocument.parse(pdfs.body).data.every(
        (o) => o.attributes.kind === 'pdf',
      ),
    ).toBe(true);
  });

  it('holds, at a lower level, no text, image, attachment, page or PDF of what is above it', () => {
    for (const lang of ['en', 'de', 'fr']) {
      const files = pkg(`${lang}/public`).files;
      const names = Object.keys(files);
      for (const name of names) {
        if (name.endsWith('.html') || name.endsWith('.json')) {
          const body = text(files[name] as Uint8Array);
          expect(body, name).not.toContain(INTERNAL_TEXT);
          expect(body, name).not.toContain(internalImage);
          expect(body, name).not.toContain(internalAttachment);
          expect(body, name).not.toContain('Service manual');
        }
        expect(name).not.toContain(internalImage);
        expect(name).not.toContain(internalAttachment);
        expect(name).not.toMatch(/(^|\/)service(\/|$)/);
      }
      // What it does hold: the public manual in both variants, and its PDFs.
      expect(names).toEqual(
        expect.arrayContaining([
          'index.html',
          'manifest.json',
          'manuals/operating/model-small.html',
          'manuals/operating/model-large.html',
          `pdf/operating/${lang}/model-small.pdf`,
        ]),
      );
      // Not one file whose bytes are an internal one's.
      const hashes = new Set(names.map((n) => sha(files[n] as Uint8Array)));
      expect(hashes.has(internalImage)).toBe(false);
      expect(hashes.has(internalAttachment)).toBe(false);
    }
    // The internal level's holds them.
    const internal = pkg('en/internal').files;
    const names = Object.keys(internal);
    expect(names).toEqual(
      expect.arrayContaining([
        'manuals/service/model-large.html',
        'pdf/service/en/model-large.pdf',
        `media/${internalImage}.png`,
        `media/${internalAttachment}.pdf`,
      ]),
    );
    expect(
      text(internal['manuals/service/model-large.html'] as Uint8Array),
    ).toContain(INTERNAL_TEXT);
  });

  it('lists every other file in its manifest, with the size and SHA-256 it holds', () => {
    for (const [key, { files }] of packages) {
      const manifest = JSON.parse(text(files['manifest.json'] as Uint8Array));
      const [lang, audience] = key.split('/');
      expect(manifest).toMatchObject({
        format: 'openfolia-offline-package',
        version: 1,
        release: { id: releaseId, tag: `release/north/${revision}` },
        product: 'north',
        revision,
        lang,
        audience,
        leftOut: [],
      });
      const listed = manifest.files as {
        path: string;
        size: number;
        sha256: string;
      }[];
      expect(listed.map((f) => f.path).sort()).toEqual(
        Object.keys(files)
          .filter((n) => n !== 'manifest.json')
          .sort(),
      );
      for (const f of listed) {
        const bytes = files[f.path] as Uint8Array;
        expect(f.size, f.path).toBe(bytes.length);
        expect(f.sha256, f.path).toBe(sha(bytes));
      }
    }
  });

  it("writes an author's SVG made inert: no script, event handler or script link (the rest in the unit tests)", () => {
    const files = pkg('en/internal').files;
    const body = text(files[`media/${hostileSvg}.svg`] as Uint8Array);
    expect(body).toContain('<rect width="20" height="20" fill="#c00">');
    expect(body).not.toMatch(
      /script|alert|onload|onmouseover|javascript|<a[ >]/i,
    );
    expect(
      Object.values(files).some((bytes) =>
        Buffer.from(bytes).includes(HOSTILE_SVG),
      ),
    ).toBe(false);
  });

  it('is listed to a reader only at or below their level; the one above is 404', async () => {
    const seen = await list(publicReader);
    expect(seen.data.map((o) => o.attributes.audience)).toEqual([
      'public',
      'public',
      'public',
    ]);
    const above = await download(pkg('en/internal').id, publicReader);
    expect(above.status).toBe(404);
    const own = await download(pkg('en/public').id, publicReader);
    expect(own.status).toBe(200);
  });

  it('opens from the file system with every network request refused: pages, images, attachments, PDFs and the search', async () => {
    const require = createRequire(import.meta.url);
    let chromium: typeof import('playwright-core').chromium;
    try {
      ({ chromium } =
        require('playwright-core') as typeof import('playwright-core'));
    } catch {
      throw new Error('playwright-core is not installed: run `pnpm install`.');
    }
    const root = mkdtempSync(join(tmpdir(), 'openfolia-offline-'));
    try {
      for (const [name, bytes] of Object.entries(pkg('en/internal').files)) {
        const path = join(root, ...name.split('/'));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      let browser;
      try {
        browser = await chromium.launch();
      } catch (error) {
        throw new Error(
          `No browser for the offline package's test: run \`pnpm exec playwright-core install chromium-headless-shell\`. ${String(error)}`,
          { cause: error },
        );
      }
      try {
        // A phone's screen.
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
        });
        const refused: string[] = [];
        const failed: string[] = [];
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith('file:')) return route.continue();
          refused.push(url);
          return route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        page.on('requestfailed', (r) => failed.push(r.url()));
        const index = pathToFileURL(join(root, 'index.html')).href;
        await page.goto(index);
        await expect.poll(() => page.title()).toBe(`North ${revision}`);
        // The theme's stylesheets apply (its font, its colours), and nothing scrolls sideways.
        expect(
          await page.evaluate(() => getComputedStyle(document.body).fontFamily),
        ).toMatch(/\w/);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);

        // The search: shown once its script runs, finds a heading, and its link opens the page.
        const search = page.locator('#of-search');
        await search.waitFor({ state: 'visible' });
        await search.fill('internals');
        const hit = page.locator('#of-search-results a').first();
        await hit.waitFor();
        await hit.click();
        await page.waitForURL(/manuals\/.+\.html#of-/);
        await expect
          .poll(() => page.locator('main').innerText())
          .toContain(INTERNAL_TEXT);

        // Back to the index, then a manual by its link.
        await page.locator('.of-offline__home').click();
        await page.waitForURL(index);
        await page
          .locator('a[href="manuals/service/model-large.html"]')
          .first()
          .click();
        await page.waitForURL(/manuals\/service\/model-large\.html$/);
        // The theme's fonts, from the package.
        expect(
          await page.evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].filter((f) => f.status === 'loaded')
              .length;
          }),
        ).toBeGreaterThan(0);
        // Every image loaded from the package.
        const images = await page.evaluate(() =>
          [...document.images].map((i) => ({ src: i.src, w: i.naturalWidth })),
        );
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
          expect(image.src.startsWith('file:'), image.src).toBe(true);
          expect(image.w, image.src).toBeGreaterThan(0);
        }
        expect(images.some((i) => i.src.includes(internalImage))).toBe(true);
        // The attachment and the PDF link to files the package holds.
        const links = await page.evaluate(() =>
          [...document.querySelectorAll('a[href]')].map(
            (a) => (a as HTMLAnchorElement).href,
          ),
        );
        const local = (suffix: string) =>
          links.find((l) => l.endsWith(suffix)) ?? '';
        expect(local(`media/${internalAttachment}.pdf`)).toMatch(/^file:/);
        expect(local('pdf/service/en/model-large.pdf')).toMatch(/^file:/);
        // Each link, resolved by the browser, is a file of the package with the bytes it should
        // have (a file a browser hands to its viewer or saves; the pages' policy frames nothing).
        for (const [href, hash] of [
          [local(`media/${internalAttachment}.pdf`), internalAttachment],
          [
            local('pdf/service/en/model-large.pdf'),
            (
              JSON.parse(
                text(pkg('en/internal').files['manifest.json'] as Uint8Array),
              ).files as { path: string; sha256: string }[]
            ).find((f) => f.path === 'pdf/service/en/model-large.pdf')?.sha256,
          ],
        ] as const) {
          expect(sha(readFileSync(fileURLToPath(href))), href).toBe(hash);
        }
        // The author's SVG, opened on its own as a document: nothing runs.
        const dialogs: string[] = [];
        page.on('dialog', (d) => {
          dialogs.push(d.message());
          void d.dismiss();
        });
        await page.goto(
          pathToFileURL(join(root, 'media', `${hostileSvg}.svg`)).href,
        );
        await page.locator('rect').waitFor({ state: 'attached' });
        await page.mouse.move(5, 5);
        await page.waitForTimeout(200);
        expect(dialogs).toEqual([]);
        expect(failed.filter((u) => !u.startsWith('file:'))).toEqual(refused);
        expect(refused).toEqual([]);
        expect(failed).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
