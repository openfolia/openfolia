import { execFileSync } from 'node:child_process';
import { parsePageDesign } from '@openfolia/content-model';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { TranslationImportDocument } from '../src/translations/api/translation-import.resources.js';
import { TranslationJobDocument } from '../src/translations/api/translation-job.resources.js';
import {
  TranslationStatusDocument,
  TranslationStatusPageDocument,
} from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * A page design's region text in the translation status, a delta export and an import (#568),
 * over the sample repository with its designs (`addSamplePageDesigns`: `classic` has a title
 * page text in English and German, without a record, and a footer of a placeholder the same in
 * every language; `minimal` has no region text).
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

const upload = (xliff: string) =>
  t
    .anonymous()
    .post('/translations/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1')
    .attach('file', Buffer.from(xliff, 'utf8'), 'translation.xlf');

/** Each `<source>` given a `<target>`. */
const translated = (
  xml: string,
  translate: (unit: string, source: string) => string,
) =>
  xml.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
    unit.replace(
      /<source>(.*?)<\/source>/gs,
      (_, source: string) =>
        `<source>${source}</source><target>${translate(id, source)}</target>`,
    ),
  );
const toGerman = (unit: string, source: string) =>
  unit === 'above-title.intro' ? 'Betriebsanleitung für <ph id="1"/>' : source;

const designRows = async (ref = 'main') =>
  TranslationStatusPageDocument.parse(
    (
      await t.get(
        `/translations/status?ref=${ref}&filter[kind]=design&filter[lang]=de`,
      )
    ).body,
  ).data.map(
    (r) =>
      `${r.id} ${r.attributes.kind} ${r.attributes.designId} ${r.attributes.state} ${r.meta.outdatedBlocks}/${r.meta.totalBlocks}`,
  );

/** Exports the classic design's region text into German; its job and XLIFF. */
async function exportClassic() {
  const res = await t.post('/translations/exports').send({
    data: {
      type: 'TranslationJob',
      attributes: {
        languages: ['de'],
        subject: { type: 'designs', designIds: ['classic', 'minimal'] },
        ref: 'main',
      },
    },
  });
  expect(res.status).toBe(201);
  const job = TranslationJobDocument.parse(res.body).data;
  const file = await t.get(`/translations/exports/${job.id}/file?lang=de`);
  expect(file.status).toBe(200);
  return { job, xliff: file.text };
}

beforeAll(async () => {
  t = await createTestApp();
  await addSamplePageDesigns(dir());
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('a page design’s region text (#568)', () => {
  let jobId: string;
  let xliff: string;

  it('shows in the translation status: outdated without a record, the footer missing', async () => {
    t.actAs(translator);
    expect(await designRows()).toEqual([
      'de/designs/classic design classic outdated 2/2',
    ]);
    const one = await t.get('/translations/status/de/designs/classic');
    expect(one.status).toBe(200);
    expect(TranslationStatusDocument.parse(one.body).data.meta.blocks).toEqual([
      { blockId: 'above-title.intro', state: 'outdated' },
      { blockId: 'footer.release', state: 'missing' },
    ]);
    const none = await t.get('/translations/status/de/designs/minimal');
    expect(none.status).toBe(404);
  });

  it('goes out in its own file of a delta export, then is at the provider', async () => {
    t.actAs(translator);
    const exported = await exportClassic();
    jobId = exported.job.id;
    xliff = exported.xliff;
    expect(exported.job.meta).toMatchObject({ modules: 1, units: 2 });
    expect(xliff).toContain(
      '<file id="design.classic" original="design/classic.yaml"',
    );
    expect(xliff).toContain('<unit id="footer.release"');
    expect(xliff).toContain('subType="ccms:placeholder"');
    expect(await designRows()).toEqual([
      'de/designs/classic design classic at-provider 0/2',
    ]);
  });

  it('refuses an unknown placeholder in an import, naming its unit', async () => {
    t.actAs(translator);
    const res = await upload(
      translated(xliff, (unit, source) =>
        unit === 'footer.release'
          ? `${source} <ph id="7" type="other" subType="ccms:placeholder" disp="[secret]" ccms:key="secret"/>`
          : toGerman(unit, source),
      ),
    );
    expect(res.status).toBe(201);
    const doc = TranslationImportDocument.parse(res.body);
    expect(doc.data.meta.report).toEqual([
      expect.objectContaining({
        lang: 'de',
        moduleId: 'design.classic',
        designId: 'classic',
        units: [
          expect.objectContaining({
            blockId: 'above-title.intro',
            state: 'ok',
          }),
          expect.objectContaining({
            blockId: 'footer.release',
            state: 'broken-markup',
          }),
        ],
      }),
    ]);
  });

  it('comes back in with an import: the design’s German text and record in one save point, up to date', async () => {
    t.actAs(translator);
    const res = await upload(translated(xliff, toGerman));
    expect(res.status).toBe(201);
    const checked = TranslationImportDocument.parse(res.body);
    expect(checked.data.meta.counts).toMatchObject({ units: 2, ok: 2 });
    const applied = await t.post(
      `/translations/imports/${checked.data.id}/apply`,
    );
    expect(applied.status).toBe(200);
    const doc = TranslationImportDocument.parse(applied.body);
    const branch = `change-sets/${doc.data.relationships.changeSet.data?.id}`;
    expect(git('rev-list', '--count', `main..${branch}`)).toBe('1');
    const design = parsePageDesign(
      git('show', `${branch}:design/classic.yaml`),
      { id: 'classic' },
    );
    expect(
      (design.regions['above-title'] as Record<string, unknown>)['de'],
    ).toEqual([
      {
        type: 'paragraph',
        id: 'intro',
        content: [
          { type: 'text', text: 'Betriebsanleitung für ' },
          { type: 'attribute', name: 'product-name' },
        ],
      },
    ]);
    // The footer, the same in every language before, is English and German now.
    expect(Object.keys(design.regions['footer'] as object).sort()).toEqual([
      'de',
      'en',
    ]);
    expect(Object.keys(design.translations?.['de']?.blocks ?? {})).toEqual([
      'above-title.intro',
      'footer.release',
    ]);
    expect(design.translations?.['de']?.sourceCommit).toBe(
      TranslationJobDocument.parse(
        (await t.get(`/translations/exports/${jobId}`)).body,
      ).data.attributes.commit,
    );
    expect(await designRows(branch)).toEqual([
      'de/designs/classic design classic up-to-date 0/2',
    ]);
  });

  it('is not for a reader without translation.manage or content.read.draft', async () => {
    t.actAs(actorWith(['content.read']));
    const res = await t.get('/translations/status/de/designs/classic');
    expect(res.status).toBe(403);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
  });
});
