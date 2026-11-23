import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseConfig, printConfig } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { actorWith } from './fakes/actors.js';
import { renamedFont, themeFont, woffFromSfnt } from './fonts.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * #555: fonts for page designs are uploaded into a change set (`kind=font`), checked by their
 * structure, listed with what they say of themselves, served (with a design's logo) to every
 * reader of a design, and used by the PDF; a design whose font is missing renders with the
 * default font and gets a check finding.
 */
const MAX = 200_000;
const FAMILY = 'Upload Test Sans';
const LICENCE =
  'This Font Software is licensed under the SIL Open Font License, Version 1.1.';
const COPYRIGHT = 'Copyright 2026 The Geist Project Authors';

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'font-author',
};

/** Reads drafts (the test's branches), uses no module and edits nothing. */
const reader: Actor = {
  ...actorWith(['content.read', 'content.read.draft']),
  id: 'font-reader',
};

const TTF = Buffer.from(
  renamedFont(themeFont('ttf/Geist-Regular.ttf'), FAMILY, {
    copyright: COPYRIGHT,
    licence: LICENCE,
    licenceUrl: 'https://openfontlicense.org',
  }),
);
const WOFF = Buffer.from(
  woffFromSfnt(
    renamedFont(themeFont('ttf/Geist-Bold.ttf'), FAMILY, {
      subfamily: 'Bold',
    }),
  ),
);
const WOFF2 = Buffer.from(themeFont('Geist-Variable.woff2'));

let t: TestApp;
let cs: string;
beforeAll(async () => {
  t = await createTestApp({ CCMS_MAX_FONT_BYTES: String(MAX) });
  t.actAs(author);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Fonts' } },
    }),
  );
  expect(res.status).toBe(201);
  cs = ChangeSetDocument.parse(res.body).data.id;
}, 60_000);
afterAll(async () => {
  delete process.env['CCMS_MAX_FONT_BYTES'];
  await t?.close();
});
afterEach(() => t?.actAs(author));

/** A multipart upload as a browser sends it, claiming a harmless type and name. */
const upload = (data: Buffer, kind = 'font', filename = 'font.txt') =>
  t
    .anonymous()
    .post(`/change-sets/${cs}/assets?kind=${kind}`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set(REQUEST_HEADER, '1')
    .attach('file', data, { filename, contentType: 'text/plain' });

describe('uploading a font (#555)', () => {
  it('takes TrueType, WOFF and WOFF2 by their structure, whatever the name and type claim', async () => {
    for (const [data, type] of [
      [TTF, 'font/ttf'],
      [WOFF, 'font/woff'],
      [WOFF2, 'font/woff2'],
    ] as const) {
      const res = await upload(data);
      expect(res.status, type).toBe(201);
      const { attributes } = ChangeSetAssetDocument.parse(res.body).data;
      expect(attributes).toMatchObject({
        reference: `sha256:${sha256(data)}`,
        contentType: type,
        size: data.byteLength,
      });
    }
    // The same font again: the first upload, nothing new.
    expect((await upload(TTF)).status).toBe(200);
  });

  it('refuses a file that is no font, a malformed font and one too large, with stable codes', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    for (const [data, reason] of [
      [png, 'not-a-font'],
      [Buffer.from('OTTO but not really a font'), 'malformed'],
      [TTF.subarray(0, 4000), 'malformed'],
      [Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(64)]), 'not-a-font'],
    ] as const) {
      const res = await upload(Buffer.from(data), 'font', 'font.ttf');
      expect(res.status, reason).toBe(422);
      const [error] = errors(res.body);
      expect(error).toMatchObject({
        code: 'unsupported-font-type',
        meta: {
          accepted: ['font/ttf', 'font/otf', 'font/woff', 'font/woff2'],
          reason,
        },
      });
    }
    const large = await upload(randomBytes(MAX + 1));
    expect(large.status).toBe(422);
    expect(errors(large.body)[0]).toMatchObject({
      code: 'too-large',
      meta: { max: MAX },
    });
    // A font is no image, and no image a font.
    expect((await upload(TTF, 'image')).status).toBe(422);
  });

  it('lists the change set’s fonts with their family, style, copyright and licence', async () => {
    const res = await t.get(
      `/assets?ref=change-sets/${cs}&filter[changeSet]=${cs}&filter[type]=font`,
    );
    expect(res.status).toBe(200);
    const listed = AssetPageDocument.parse(res.body).data;
    const byHash = new Map(listed.map((a) => [a.id, a.attributes]));
    expect(byHash.get(sha256(TTF))).toMatchObject({
      contentType: 'font/ttf',
      font: {
        format: 'ttf',
        family: FAMILY,
        subfamily: 'Regular',
        weight: 400,
        italic: false,
        copyright: COPYRIGHT,
        licence: LICENCE,
        licenceUrl: 'https://openfontlicense.org',
      },
    });
    expect(byHash.get(sha256(WOFF))?.font).toMatchObject({
      format: 'woff',
      family: FAMILY,
      weight: 700,
    });
    expect(byHash.get(sha256(WOFF2))?.font).toMatchObject({
      format: 'woff2',
      family: 'Geist',
    });
    expect(listed.every((a) => a.meta.uploaded)).toBe(true);
    // An image list never holds them as attachments.
    const attachments = await t.get(
      `/assets?ref=change-sets/${cs}&filter[changeSet]=${cs}&filter[type]=attachment`,
    );
    expect(AssetPageDocument.parse(attachments.body).data).toEqual([]);
  });
});

describe('a design’s fonts and logo (#555)', () => {
  const logo = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="4" height="4"/></svg>',
  );
  const missing = 'f'.repeat(64);
  let pngLogo: Buffer;

  beforeAll(async () => {
    pngLogo = await sharp({
      create: { width: 8, height: 4, channels: 3, background: '#1f4e79' },
    })
      .png()
      .toBuffer();
    t.actAs(author);
    const png = await upload(pngLogo, 'image', 'logo.png');
    expect(png.status).toBe(201);
    const design = (id: string, heading: string, logoHash: string) =>
      [
        'schemaVersion: 1',
        `name: ${id}`,
        'preset: classic',
        'colours:',
        '  primary: "#1f4e79"',
        '  accent: "#b45309"',
        '  text: "#1f2328"',
        'logo:',
        `  light: sha256:${logoHash}`,
        'fonts:',
        '  heading:',
        `    family: ${FAMILY}`,
        `    regular: sha256:${heading}`,
        '  embeddingAllowed: true',
        '',
      ].join('\n');
    const config = parseConfig(git('show', 'main:openfolia.yaml'));
    const writer = new GitWriter(dir());
    const head = git('rev-parse', 'main');
    for (const [branch, heading, logoHash] of [
      ['fonts-designed', sha256(TTF), sha256(pngLogo)],
      ['fonts-missing', missing, sha256(logo)],
    ] as const) {
      git('branch', branch, head);
      await writer.commit({
        branch,
        parent: head,
        changes: [
          {
            path: 'design/fonts.yaml',
            content: design('fonts', heading, logoHash),
          },
          // An old-layout file the design names: an SVG that would run as a page.
          { path: `assets/${sha256(logo)}`, content: logo },
          {
            path: 'openfolia.yaml',
            content: printConfig({
              ...config,
              pdf: { ...config.pdf, design: 'fonts' },
            }),
          },
        ],
        message: 'A design with an uploaded font',
        author: { name: 'Someone', email: 'someone@example.com' },
      });
    }
  }, 60_000);

  it('serves the font to every reader of the design, as a font and never sniffed', async () => {
    t.actAs(reader);
    const hash = sha256(TTF);
    // No design names it on main: not found, as any file the reader may not see.
    expect((await t.get(`/assets/${hash}?ref=main`)).status).toBe(404);
    const res = await t
      .get(`/assets/${hash}?ref=fonts-designed`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('font/ttf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect((res.body as Buffer).equals(TTF)).toBe(true);
  });

  it('serves the logo in place, and an SVG a design names only as a download of no type', async () => {
    t.actAs(reader);
    const png = await t.get(`/assets/${sha256(pngLogo)}?ref=fonts-designed`);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toBe('inline');
    const svg = await t.get(`/assets/${sha256(logo)}?ref=fonts-missing`);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toBe('application/octet-stream');
    expect(svg.headers['content-disposition']).toMatch(/^attachment/);
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never deletes a font a design on main names, however old', async () => {
    // Stored days ago, no upload record: only the design keeps it.
    const kept = Buffer.from(
      renamedFont(themeFont('ttf/Geist-Regular.ttf'), 'Kept Sans'),
    );
    const { sha256: hash } = await t.blobs.put(Readable.from([kept]), {
      contentType: 'font/ttf',
      maxBytes: 10_000_000,
    });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(
      join(process.env['CCMS_BLOB_FS_ROOT'] as string, hash.slice(0, 2), hash),
      old,
      old,
    );
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'main'),
      changes: [
        {
          path: 'design/kept.yaml',
          content: [
            'schemaVersion: 1',
            'name: Kept',
            'preset: classic',
            'fonts:',
            '  body:',
            '    family: Kept Sans',
            `    regular: sha256:${hash}`,
            '  embeddingAllowed: true',
            '',
          ].join('\n'),
        },
      ],
      message: 'A design naming a font',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const res = await t.delete(`/assets/${hash}`);
    expect(res.status).toBe(409);
    expect(errors(res.body)[0]).toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [expect.not.objectContaining({ in: 'recent-upload' })] },
    });
    expect(await t.blobs.exists(hash)).toBe(true);
  });

  it('lists the fonts the designs at the ref name to a reader', async () => {
    t.actAs(reader);
    const res = await t.get('/assets?ref=fonts-designed&filter[type]=font');
    expect(res.status).toBe(200);
    const listed = AssetPageDocument.parse(res.body).data;
    expect(listed.map((a) => [a.id, a.attributes.font?.family])).toEqual([
      [sha256(TTF), FAMILY],
    ]);
  });

  it('lays the PDF’s headings out in the uploaded font', async () => {
    const res = await t
      .get('/manuals/operating/variants/model=large/en/pdf?ref=fonts-designed')
      .set('Accept', 'application/pdf')
      .buffer(true);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString('latin1')).toMatch(
      /\/BaseFont\s*\/[A-Z]{6}\+UploadTestSans-Regular/,
    );
  });

  it('renders a design whose font is missing with the default font, and says so in the checks', async () => {
    const pdf = await t
      .get('/manuals/operating/variants/model=large/en/pdf?ref=fonts-missing')
      .set('Accept', 'application/pdf')
      .buffer(true);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString('latin1')).not.toContain(
      'UploadTestSans',
    );
    const res = await t.get('/manuals/operating/checks?ref=fonts-missing');
    expect(res.status).toBe(200);
    const found = CheckPageDocument.parse(res.body)
      .data.map((c) => c.attributes)
      .filter((c) => c.code === 'page-design-missing-font');
    expect(found.map((c) => [c.severity, c.params])).toEqual([
      [
        'warning',
        {
          design: 'fonts',
          at: 'fonts.heading.regular',
          asset: `sha256:${missing}`,
        },
      ],
    ]);
    const fine = await t.get('/manuals/operating/checks?ref=fonts-designed');
    expect(
      CheckPageDocument.parse(fine.body).data.filter(
        (c) => c.attributes.code === 'page-design-missing-font',
      ),
    ).toEqual([]);
  });
});
