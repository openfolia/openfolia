import { execFileSync } from 'node:child_process';
import {
  coverUnitKey,
  type Manifest,
  parseManifest,
  printManifest,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { TranslationCoveragePageDocument } from '../src/reports/api/reports.resources.js';
import {
  MarkedCurrentDocument,
  TranslationImportDocument,
} from '../src/translations/api/translation-import.resources.js';
import { TranslationJobDocument } from '../src/translations/api/translation-job.resources.js';
import {
  TranslationStatusDocument,
  TranslationStatusPageDocument,
} from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * A manual's cover image alternative text (#656) in the translation status, a delta export, an
 * import, the coverage report, the checks and marking a translation current, over the sample
 * repository with a cover image of its own and a variant's on `operating`; and its page design
 * (`classic` from `addSamplePageDesigns`: a German title page text without a record, a footer
 * the same in every language) in the coverage report, the checks and marking it current.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const translator = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
  'translation.manage',
]);

const ASSET = 'sha256:' + 'a'.repeat(64);
let variantKey: string;

const upload = (xliff: string) =>
  t
    .anonymous()
    .post('/translations/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1')
    .attach('file', Buffer.from(xliff, 'utf8'), 'translation.xlf');

/** Each `<source>` of the manual's file given a `<target>`. */
const translated = (
  xml: string,
  translate: (unit: string, source: string) => string,
) =>
  xml.replace(/<file id="manual\.[^"]+"[\s\S]*?<\/file>/g, (file) =>
    file.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
      unit.replace(
        /<source>(.*?)<\/source>/gs,
        (_, source: string) =>
          `<source>${source}</source><target>${translate(id, source)}</target>`,
      ),
    ),
  );

/** The manual's `outdated-translation` findings at `ref`: what each names. */
const outdated = async (ref: string) =>
  CheckPageDocument.parse(
    (
      await t.get(
        `/manuals/operating/checks?ref=${encodeURIComponent(ref)}&page[size]=100`,
      )
    ).body,
  )
    .data.filter((c) => c.attributes.code === 'outdated-translation')
    .map((c) => c.attributes.params ?? {})
    .filter((p) => p['at'] !== undefined || p['design'] !== undefined);

const manualRows = async (ref = 'main') =>
  TranslationStatusPageDocument.parse(
    (
      await t.get(
        `/translations/status?ref=${ref}&filter[kind]=manual&filter[manual]=operating&filter[lang]=de`,
      )
    ).body,
  ).data.map(
    (r) =>
      `${r.id} ${r.attributes.kind} ${r.attributes.manualId} ${r.attributes.state} ${r.meta.outdatedBlocks}/${r.meta.totalBlocks}`,
  );

beforeAll(async () => {
  t = await createTestApp();
  await addSamplePageDesigns(dir());
  const manifest = parseManifest(git('show', 'main:manuals/operating.yaml'), {
    id: 'operating',
  });
  const [first] = manifest.variants;
  variantKey = coverUnitKey(first ?? {});
  const head = git('rev-parse', 'main');
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: head,
    changes: [
      {
        path: 'manuals/operating.yaml',
        content: printManifest({
          ...manifest,
          design: 'classic',
          coverImage: {
            default: { asset: ASSET, alt: 'The vehicle' },
            variants: [
              { variant: first ?? {}, asset: ASSET, alt: 'The large vehicle' },
            ],
          },
        } as Manifest),
      },
    ],
    message: 'Cover images',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}, 60_000);
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('a manual’s cover image alternative text (#656)', () => {
  let xliff: string;
  let branch: string;

  it('shows in the translation status and the coverage report as missing', async () => {
    t.actAs(translator);
    expect(await manualRows()).toEqual([
      'de/manuals/operating manual operating missing 3/3',
    ]);
    const one = await t.get('/translations/status/de/manuals/operating');
    expect(one.status).toBe(200);
    // The manual's title first (#731).
    expect(TranslationStatusDocument.parse(one.body).data.meta.blocks).toEqual([
      { blockId: 'title', state: 'missing' },
      { blockId: 'coverImage.default', state: 'missing' },
      { blockId: variantKey, state: 'missing' },
    ]);
    expect(
      (await t.get('/translations/status/de/manuals/no-such-manual')).status,
    ).toBe(404);
    const report = TranslationCoveragePageDocument.parse(
      (
        await t.get(
          '/reports/translations?filter[manual]=operating&filter[lang]=de',
        )
      ).body,
    );
    expect(report.data[0]?.meta.cover).toEqual({
      total: 3,
      upToDate: 0,
      outdated: 0,
      atProvider: 0,
      missing: 3,
    });
    // Its page design's text: the title page's German without a record, the footer missing.
    expect(report.data[0]?.meta.design).toEqual({
      total: 2,
      upToDate: 0,
      outdated: 1,
      atProvider: 0,
      missing: 1,
    });
    // Nothing of the cover text is outdated yet (it is missing); the design's is.
    expect(await outdated('main')).toEqual([
      { lang: 'de', blocks: '1', design: 'classic' },
    ]);
  });

  it('goes out in its own file of a delta export', async () => {
    t.actAs(translator);
    const res = await t.post('/translations/exports').send({
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['de'],
          subject: { type: 'manuals', manualIds: ['operating'] },
          ref: 'main',
        },
      },
    });
    expect(res.status).toBe(201);
    const job = TranslationJobDocument.parse(res.body).data;
    expect(job.attributes.subject).toEqual({
      type: 'manuals',
      manualIds: ['operating'],
    });
    const file = await t.get(`/translations/exports/${job.id}/file?lang=de`);
    expect(file.status).toBe(200);
    xliff = file.text;
    expect(xliff).toContain(
      '<file id="manual.operating" original="manuals/operating.yaml"',
    );
    expect(await manualRows()).toEqual([
      'de/manuals/operating manual operating at-provider 0/3',
    ]);
  });

  it('comes back in with an import: the manifest’s German text and record, up to date', async () => {
    t.actAs(translator);
    const res = await upload(
      translated(xliff, (unit) =>
        unit === 'coverImage.default'
          ? 'Das Fahrzeug #set &lt;b&gt;'
          : unit === 'title'
            ? 'Betriebsanleitung'
            : 'Das große Fahrzeug',
      ),
    );
    expect(res.status).toBe(201);
    const checked = TranslationImportDocument.parse(res.body);
    expect(checked.data.meta.report).toEqual([
      expect.objectContaining({
        moduleId: 'manual.operating',
        manualId: 'operating',
      }),
    ]);
    expect(checked.data.meta.counts).toMatchObject({ units: 3, ok: 3 });
    const applied = await t.post(
      `/translations/imports/${checked.data.id}/apply`,
    );
    expect(applied.status).toBe(200);
    const doc = TranslationImportDocument.parse(applied.body);
    branch = `change-sets/${doc.data.relationships.changeSet.data?.id}`;
    const manifest = parseManifest(
      git('show', `${branch}:manuals/operating.yaml`),
      { id: 'operating' },
    );
    expect(manifest.coverImage?.default?.alt).toEqual({
      en: 'The vehicle',
      de: 'Das Fahrzeug #set <b>',
    });
    expect(manifest.title).toEqual({
      en: 'Operating manual',
      de: 'Betriebsanleitung',
    });
    expect(Object.keys(manifest.translations?.['de']?.blocks ?? {})).toEqual(
      ['coverImage.default', variantKey, 'title'].sort(),
    );
    expect(await manualRows(branch)).toEqual([
      'de/manuals/operating manual operating up-to-date 0/3',
    ]);
  });

  it('is marked current after a source change, in the import’s change set', async () => {
    t.actAs(translator);
    // The English text changes in the change set: outdated there.
    const manifest = parseManifest(
      git('show', `${branch}:manuals/operating.yaml`),
      { id: 'operating' },
    );
    const writer = new GitWriter(dir());
    await writer.commit({
      branch,
      parent: git('rev-parse', branch),
      changes: [
        {
          path: 'manuals/operating.yaml',
          content: printManifest({
            ...manifest,
            coverImage: {
              ...manifest.coverImage,
              variants: manifest.coverImage?.variants ?? [],
              default: {
                asset: ASSET,
                alt: { en: 'The vehicle, new', de: 'Das Fahrzeug #set <b>' },
              },
            },
          }),
        },
      ],
      message: 'A source fix',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    expect(await manualRows(branch)).toEqual([
      'de/manuals/operating manual operating outdated 1/3',
    ]);
    expect(await outdated(branch)).toEqual(
      expect.arrayContaining([{ lang: 'de', blocks: '1', at: 'coverImage' }]),
    );
    const res = await t.post('/translations/mark-current').send({
      data: {
        type: 'TranslationMarkCurrent',
        attributes: {
          changeSetId: branch.slice('change-sets/'.length),
          manualId: 'operating',
          lang: 'de',
        },
      },
    });
    expect(res.status).toBe(200);
    expect(MarkedCurrentDocument.parse(res.body).data.attributes).toMatchObject(
      { manualId: 'operating', moduleId: 'manual.operating', blocks: 3 },
    );
    expect(await manualRows(branch)).toEqual([
      'de/manuals/operating manual operating up-to-date 0/3',
    ]);
    expect(await outdated(branch)).toEqual([
      { lang: 'de', blocks: '1', design: 'classic' },
    ]);
  });

  it('marks the page design’s text current in the same change set, not for a role limited by audience', async () => {
    const attributes = {
      changeSetId: branch.slice('change-sets/'.length),
      designId: 'classic',
      lang: 'de',
    };
    t.actAs(
      actorWith(
        [
          'content.read',
          'content.read.draft',
          'content.edit',
          'translation.manage',
        ],
        { maxAudience: 'public' },
      ),
    );
    const refused = await t
      .post('/translations/mark-current')
      .send({ data: { type: 'TranslationMarkCurrent', attributes } });
    expect(refused.status).toBe(403);
    t.actAs(translator);
    const res = await t
      .post('/translations/mark-current')
      .send({ data: { type: 'TranslationMarkCurrent', attributes } });
    expect(res.status).toBe(200);
    expect(MarkedCurrentDocument.parse(res.body).data.attributes).toMatchObject(
      { designId: 'classic', moduleId: 'design.classic', blocks: 1 },
    );
    expect(await outdated(branch)).toEqual([]);
    const report = TranslationCoveragePageDocument.parse(
      (
        await t.get(
          `/reports/translations?ref=${encodeURIComponent(branch)}&filter[manual]=operating&filter[lang]=de`,
        )
      ).body,
    );
    expect(report.data[0]?.meta.design).toMatchObject({
      upToDate: 1,
      outdated: 0,
    });
  });

  it('refuses mark-current naming two subjects, and a reader without the permissions', async () => {
    t.actAs(translator);
    const two = await t.post('/translations/mark-current').send({
      data: {
        type: 'TranslationMarkCurrent',
        attributes: {
          changeSetId: 'x',
          manualId: 'operating',
          moduleId: 'operating',
          lang: 'de',
        },
      },
    });
    expect(two.status).toBe(400);
    t.actAs(actorWith(['content.read']));
    const res = await t.get('/translations/status/de/manuals/operating');
    expect(res.status).toBe(403);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
  });
});
