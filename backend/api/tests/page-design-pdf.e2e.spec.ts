import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  parseConfig,
  parseModule,
  printConfig,
  printModule,
  type ProjectConfig,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import {
  addSamplePageDesigns,
  SAMPLE_MANUFACTURER,
  SAMPLE_PAGE_DESIGNS,
} from '@openfolia/content-repo/testing';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { LayoutWarningPageDocument } from '../src/manuals/api/manual.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #391: a manual's PDF is laid out by its page design (the manifest's, else `pdf.design`):
 * the PDF and its page images change, stay PDF/UA-1, and what the layout cannot fit is a
 * warning in the manual's checks.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

/** A running head far too long for one line, and a footer region far too long for its slot. */
const LONG = [
  'schemaVersion: 1',
  'name: Long texts',
  'preset: minimal',
  'colours:',
  '  primary: "#1f4e79"',
  '  accent: "#b45309"',
  '  text: "#1f2328"',
  'regions:',
  '  footer: |-',
  ...Array.from({ length: 14 }, (_, i) => [
    `    [#p${i}]`,
    '    A footer paragraph that takes a line of its own.',
    ...(i < 13 ? [''] : []),
  ]).flat(),
  'header:',
  '  default:',
  `    left: ${'An unusually long running head that cannot fit on one line '.repeat(4).trim()}`,
  '    right: placeholder:chapter[]',
  '',
].join('\n');

/** A footer only in German, and a German region text with a block the English one has not. */
const GERMAN = [
  'schemaVersion: 1',
  'name: German texts',
  'preset: classic',
  'colours:',
  '  primary: "#1f4e79"',
  '  accent: "#b45309"',
  '  text: "#1f2328"',
  'regions:',
  '  above-title:',
  '    en: |-',
  '      [#intro]',
  '      Instructions',
  '    de: |-',
  '      [#intro]',
  '      Anleitung',
  '',
  '      [#extra]',
  '      Nur auf Deutsch',
  'footer:',
  '  default:',
  '    left:',
  '      de: Nur Deutsch',
  '',
].join('\n');

/**
 * A branch off `parent` whose configuration names `design` as `pdf.design`; `unprintable` ends
 * the `charging` module with a character no font shows, which PDF/UA-1 refuses.
 */
async function branch(
  name: string,
  parent: string,
  design: string,
  unprintable = false,
  settings: Partial<ProjectConfig> = { manufacturer: SAMPLE_MANUFACTURER },
): Promise<void> {
  git('branch', name, parent);
  const config = parseConfig(git('show', 'main:openfolia.yaml'));
  const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  await new GitWriter(dir()).commit({
    branch: name,
    parent,
    changes: [
      { path: 'design/long.yaml', content: LONG },
      { path: 'design/german.yaml', content: GERMAN },
      {
        path: 'openfolia.yaml',
        content: printConfig({
          ...config,
          pdf: { ...config.pdf, design },
          release: { checkManufacturer: true },
          ...settings,
        }),
      },
      ...(unprintable
        ? [
            {
              path: 'modules/en/charging.adoc',
              content: printModule({
                ...charging,
                blocks: [
                  ...charging.blocks,
                  {
                    type: 'paragraph' as const,
                    id: 'glyph',
                    content: [{ type: 'text' as const, text: 'Charged \u{7}' }],
                  },
                ],
              }),
            },
          ]
        : []),
    ],
    message: `Page design: ${design}`,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}

const pdf = (ref: string) =>
  t
    .get(`/manuals/operating/variants/model=large/en/pdf?ref=${ref}`)
    .set('Accept', 'application/pdf')
    .buffer(true);
const checks = async (ref: string) => {
  const res = await t.get(`/manuals/operating/checks?ref=${ref}`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body);
};

beforeAll(async () => {
  t = await createTestApp();
  const withDesigns = await addSamplePageDesigns(dir());
  await branch('designed-classic', withDesigns, 'classic');
  await branch('designed-long', withDesigns, 'long');
  await branch('designed-long-refused', withDesigns, 'long', true);
  await branch('designed-german', withDesigns, 'german');
  // The check turned on, and no manufacturer details (#395).
  await branch('designed-unsigned', withDesigns, 'classic', false, {});
}, 60_000);
afterAll(() => t?.close());

const PAGE = '/manuals/operating/variants/model=large/en/pdf/pages';
const page = (n: number, query: string) =>
  t
    .get(`${PAGE}/${n}.png?width=120&${query}`)
    .set('Accept', 'image/png')
    .buffer(true);
const warnings = async (query: string) => {
  const res = await t.get(
    `/manuals/operating/variants/model=large/en/pdf/layout-warnings?${query}`,
  );
  expect(res.status).toBe(200);
  return LayoutWarningPageDocument.parse(res.body);
};

describe('page designs in the PDF (#391)', () => {
  it('lays a manual out by the design the configuration names, PDF/UA-1 kept', async () => {
    const [plain, designed] = await Promise.all([
      pdf('main'),
      pdf('designed-classic'),
    ]);
    expect(plain.status).toBe(200);
    expect(designed.status).toBe(200);
    const body = (designed.body as Buffer).toString('latin1');
    expect(body).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // The design's logo is not stored: its slot stays empty, the PDF still renders.
    expect(body.startsWith('%PDF-')).toBe(true);
    expect((designed.body as Buffer).equals(plain.body as Buffer)).toBe(false);
    // The back page's manufacturer link is the configuration's (#395).
    expect(body).toContain('(https://example.com)');
  });

  it('warns at the manual while the project turns the check on and has no manufacturer details (#395)', async () => {
    const found = (ref: string) =>
      checks(ref).then((page) =>
        page.data
          .map((c) => c.attributes)
          .filter((c) => c.code === 'missing-manufacturer'),
      );
    const unsigned = await found('designed-unsigned');
    expect(
      unsigned.map((c) => [c.code, c.severity, c.category, c.subject]),
    ).toEqual([
      [
        'missing-manufacturer',
        'warning',
        'validation',
        { type: 'manual', manualId: 'operating' },
      ],
    ]);
    // With the details set (the check on too), nothing.
    expect(await found('designed-classic')).toEqual([]);
    // Without the details, the back page prints none: no manufacturer link.
    const res = await pdf('designed-unsigned');
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString('latin1')).not.toContain(
      '(https://example.com)',
    );
  });

  it('reports a clipped region and a shortened running head as warnings', async () => {
    const res = await pdf('designed-long');
    expect(res.status).toBe(200);
    const found = (await checks('designed-long')).data
      .map((c) => c.attributes)
      .filter((c) =>
        ['page-design-overflow', 'running-head-truncated'].includes(c.code),
      );
    expect(found.map((c) => [c.code, c.severity, c.params['at']])).toEqual([
      ['page-design-overflow', 'warning', 'regions.footer'],
      ['running-head-truncated', 'warning', 'header.default.left'],
    ]);
    expect(found[1]?.params['text']).toMatch(/^An unusually long running head/);
    expect(found[0]?.subject).toEqual({
      type: 'manual',
      manualId: 'operating',
    });
  });

  it('keeps them when PDF/UA-1 refuses the PDF, beside the refusal (#554)', async () => {
    expect((await pdf('designed-long-refused')).status).toBe(422);
    const found = (await checks('designed-long-refused')).data.map(
      (c) => c.attributes,
    );
    expect(found.map((c) => c.code)).toEqual(
      expect.arrayContaining([
        'pdf-accessibility',
        'page-design-overflow',
        'running-head-truncated',
      ]),
    );
  });

  it('reports what resolving the design found: a text left out, one in the source language, a translation with other blocks (#554)', async () => {
    const found = (await checks('designed-german')).data
      .map((c) => ({ ...c.attributes, languages: c.meta.languages }))
      .filter((c) => c.code.startsWith('page-design-'));
    expect(
      found.map((c) => [c.code, c.severity, c.params, c.languages]),
    ).toEqual([
      [
        'page-design-dropped-text',
        'warning',
        { design: 'german', at: 'footer.default.left' },
        ['en', 'fr'],
      ],
      // French has no version of the region: the English one is used, and said.
      [
        'page-design-missing-translation',
        'warning',
        { design: 'german', at: 'regions.above-title' },
        ['fr'],
      ],
      [
        'page-design-region-languages-differ',
        'warning',
        { design: 'german', at: 'regions.above-title', name: 'en' },
        ['de'],
      ],
    ]);
  });

  it('reports none of them without a design', async () => {
    expect(
      (await checks('main')).data
        .map((c) => c.attributes.code)
        .filter((code) =>
          ['page-design-overflow', 'running-head-truncated'].includes(code),
        ),
    ).toEqual([]);
  });
});

describe('the design screen’s preview (#392)', () => {
  it('lays a manual out with another design (`?design=`), and lists what its layout cannot fit', async () => {
    // `designed-classic` names `classic`; `long` is on that branch too.
    const [own, long, builtin] = await Promise.all([
      page(1, 'ref=designed-classic'),
      page(1, 'ref=designed-classic&design=long'),
      page(1, 'ref=designed-classic&design=builtin'),
    ]);
    expect([own.status, long.status, builtin.status]).toEqual([200, 200, 200]);
    expect((own.body as Buffer).equals(long.body as Buffer)).toBe(false);
    expect((own.body as Buffer).equals(builtin.body as Buffer)).toBe(false);

    const listed = await warnings('ref=designed-classic&design=long');
    expect(
      listed.data.map((w) => [w.id, w.attributes.code, w.attributes.at]),
    ).toEqual([
      [
        'page-design-overflow:regions.footer',
        'page-design-overflow',
        'regions.footer',
      ],
      [
        'running-head-truncated:header.default.left',
        'running-head-truncated',
        'header.default.left',
      ],
    ]);
    expect(listed.data[1]?.attributes.text).toMatch(
      /^An unusually long running head/,
    );
    expect(listed.data[1]?.attributes.page).toBeGreaterThan(1);
    expect(listed.meta.page).toMatchObject({ total: 2 });
    // Paged like every list.
    const second = await warnings(
      'ref=designed-classic&design=long&page[size]=1&page[number]=2',
    );
    expect(second.data.map((w) => w.attributes.code)).toEqual([
      'running-head-truncated',
    ]);
    // The manual's own design and the built-in one fit.
    expect((await warnings('ref=designed-classic')).data).toEqual([]);
    expect((await warnings('ref=designed-long&design=builtin')).data).toEqual(
      [],
    );
  });

  it('refuses a malformed design and an unknown parameter', async () => {
    for (const query of ['design=Not_An_Id', 'design=', 'colour=red']) {
      expect((await page(1, `ref=main&${query}`)).status).toBe(400);
      const res = await t.get(
        `/manuals/operating/variants/model=large/en/pdf/layout-warnings?ref=main&${query}`,
      );
      expect(res.status).toBe(400);
    }
    // A design that is not there: the built-in one, as for a manual naming one.
    expect((await page(1, 'ref=main&design=nowhere')).status).toBe(200);
    expect((await warnings('ref=main&design=nowhere')).data).toEqual([]);
  });

  it('previews a design’s working copy, made in the change set, for its author', async () => {
    const author = {
      ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
      id: 'design-author',
    };
    t.actAs(author);
    try {
      const created = await t.post('/change-sets').send(
        JSON.stringify({
          data: { type: 'ChangeSet', attributes: { title: 'Design' } },
        }),
      );
      expect(created.status).toBe(201);
      const cs = ChangeSetDocument.parse(created.body).data;
      const locked = await t.post(`/change-sets/${cs.id}/locks`).send(
        JSON.stringify({
          data: {
            type: 'Lock',
            attributes: { subject: { type: 'design', designId: 'draft-only' } },
          },
        }),
      );
      expect(locked.status).toBe(201);
      const saved = await t
        .put(`/change-sets/${cs.id}/page-designs/draft-only/working-copy`)
        .send(
          JSON.stringify({
            data: {
              type: 'WorkingCopy',
              attributes: {
                content: {
                  schemaVersion: 1,
                  id: 'draft-only',
                  name: 'Draft only',
                  preset: 'minimal',
                  colours: {
                    primary: '#1f4e79',
                    accent: '#b45309',
                    text: '#1f2328',
                  },
                  header: {
                    default: {
                      left: [
                        {
                          type: 'text',
                          text: 'A running head far too long to fit on one line of a page '.repeat(
                            5,
                          ),
                        },
                      ],
                    },
                  },
                },
              },
            },
            meta: { version: 0, baseCommit: cs.attributes.baseCommit },
          }),
        );
      expect(saved.status).toBe(200);
      const ref = encodeURIComponent(`change-sets/${cs.id}`);
      // Nothing committed: without the working copies the design is not there.
      expect((await warnings(`ref=${ref}&design=draft-only`)).data).toEqual([]);
      const live = await warnings(
        `ref=${ref}&workingCopy=true&design=draft-only`,
      );
      expect(live.data.map((w) => w.id)).toEqual([
        'running-head-truncated:header.default.left',
      ]);
      expect(
        (await page(1, `ref=${ref}&workingCopy=true&design=draft-only`)).status,
      ).toBe(200);
      // Only its author previews them.
      t.actAs({ ...author, id: 'someone-else' });
      expect(
        (
          await t.get(
            `/manuals/operating/variants/model=large/en/pdf/layout-warnings?ref=${ref}&workingCopy=true&design=draft-only`,
          )
        ).status,
      ).toBe(403);
    } finally {
      t.actAs(undefined);
    }
  });
});

describe('a design’s files in the PDF’s cache key (#552)', () => {
  it('renders the PDF again once a missing logo is stored, and shows it', async () => {
    const logo = await sharp({
      create: { width: 64, height: 32, channels: 3, background: '#1f4e79' },
    })
      .png()
      .toBuffer();
    const hash = createHash('sha256').update(logo).digest('hex');
    const design = SAMPLE_PAGE_DESIGNS['classic']!.replace(
      '1'.repeat(64),
      hash,
    ).replace('id: classic', 'id: with-logo');
    git('branch', 'designed-logo', 'main');
    const config = parseConfig(git('show', 'main:openfolia.yaml'));
    await new GitWriter(dir()).commit({
      branch: 'designed-logo',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        { path: 'design/with-logo.yaml', content: design },
        {
          path: 'openfolia.yaml',
          content: printConfig({
            ...config,
            pdf: { ...config.pdf, design: 'with-logo' },
          }),
        },
      ],
      message: 'Page design with a logo',
      author: { name: 'Someone', email: 'someone@example.com' },
    });

    const before = await pdf('designed-logo');
    expect(before.status).toBe(200);
    // The logo is not stored yet: the same PDF again, from the cache.
    const again = await pdf('designed-logo');
    expect((again.body as Buffer).equals(before.body as Buffer)).toBe(true);

    await t.blobs.put(Readable.from([logo]), {
      contentType: 'image/png',
      maxBytes: 1_000_000,
    });
    const after = await pdf('designed-logo');
    expect(after.status).toBe(200);
    // A new rendering, with the logo in it: an image the PDF did not have before.
    expect((after.body as Buffer).equals(before.body as Buffer)).toBe(false);
    const images = (body: Buffer) =>
      body.toString('latin1').match(/\/Subtype\s*\/Image/g)?.length ?? 0;
    expect(images(after.body as Buffer)).toBeGreaterThan(
      images(before.body as Buffer),
    );
  });
});
