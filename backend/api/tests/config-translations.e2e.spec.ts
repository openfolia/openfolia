import { execFileSync } from 'node:child_process';
import {
  type Manifest,
  parseConfig,
  parseManifest,
  printConfig,
  printManifest,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ManualDocument } from '../src/manuals/api/manual.resources.js';
import { ResolvedManualDocument } from '../src/manuals/api/manual.resources.js';
import { ProjectConfigDocument } from '../src/project/api/project.resources.js';
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
import { VariantAttributePageDocument } from '../src/variants/api/variant.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Titles and labels per language (#731), over the sample repository: `operating` given a title
 * and a group title per language, delivered as stored and resolved in the manual's language; the
 * project labels (`openfolia.yaml`) in the translation status, a delta export, an import, marking
 * them current, the coverage report and the protection of their translation record (#663).
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

/** Manages every language's translation and may change the configuration. */
const manager = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
  'translation.manage',
  'admin.roles',
]);
/** Manages translations; may not change the configuration (no `admin.roles`). */
const translator = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
  'translation.manage',
]);
/** May change the configuration; manages no translation. */
const admin = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
  'admin.roles',
]);

const upload = (xliff: string) =>
  t
    .anonymous()
    .post('/translations/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1')
    .attach('file', Buffer.from(xliff, 'utf8'), 'translation.xlf');

/** Each `<source>` of the labels' file given a `<target>`. */
const translated = (
  xml: string,
  translate: (unit: string, source: string) => string,
) =>
  xml.replace(/<file id="config\.project"[\s\S]*?<\/file>/g, (file) =>
    file.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
      unit.replace(
        /<source>(.*?)<\/source>/gs,
        (_, source: string) =>
          `<source>${source}</source><target>${translate(id, source)}</target>`,
      ),
    ),
  );

const configRows = async (query = '', ref = 'main') =>
  TranslationStatusPageDocument.parse(
    (
      await t.get(
        `/translations/status?ref=${encodeURIComponent(ref)}&filter[lang]=de${query}`,
      )
    ).body,
  ).data.map(
    (r) =>
      `${r.id} ${r.attributes.kind} ${r.attributes.state} ${r.meta.outdatedBlocks}/${r.meta.totalBlocks}`,
  );

/** The 12 labels of the sample configuration. */
const LABELS = 12;

beforeAll(async () => {
  t = await createTestApp();
  const manifest = parseManifest(git('show', 'main:manuals/operating.yaml'), {
    id: 'operating',
  });
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'main'),
    changes: [
      {
        path: 'manuals/operating.yaml',
        content: printManifest({
          ...manifest,
          title: { en: 'Operating manual', de: 'Betriebsanleitung' },
          entries: [
            {
              title: { en: 'Everyday use', de: 'Im Alltag' },
              entries: manifest.entries,
            },
          ],
        } as Manifest),
      },
    ],
    message: 'Titles per language',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}, 60_000);
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('a manual’s title and group titles per language (#731)', () => {
  it('are delivered as stored on the manual, in the source language in its listing’s labels', async () => {
    const res = await t.get('/manuals/operating');
    expect(res.status).toBe(200);
    const manual = ManualDocument.parse(res.body).data;
    expect(manual.attributes.title).toEqual({
      en: 'Operating manual',
      de: 'Betriebsanleitung',
    });
    expect(manual.attributes.entries[0]).toMatchObject({
      title: { en: 'Everyday use', de: 'Im Alltag' },
    });
    expect(manual.meta.variants.map((v) => v.label)).toEqual([
      'Small',
      'Large',
    ]);
  });

  it('are resolved in the manual’s language, the source language’s where it has none', async () => {
    for (const [lang, title, group] of [
      ['de', 'Betriebsanleitung', 'Im Alltag'],
      ['en', 'Operating manual', 'Everyday use'],
      ['fr', 'Operating manual', 'Everyday use'],
    ] as const) {
      const res = await t.get(
        `/manuals/operating/variants/model=large/${lang}`,
      );
      expect(res.status).toBe(200);
      const resolved = ResolvedManualDocument.parse(res.body).data.attributes;
      expect(resolved.title).toBe(title);
      expect(resolved.entries[0]).toMatchObject({
        kind: 'group',
        title: group,
      });
    }
  });

  it('are the German title in the German PDF', async () => {
    const pdf = await t
      .get('/manuals/operating/variants/model=large/de/pdf')
      .set('Accept', 'application/pdf')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    // The document's title, in its metadata (PDF/UA-1 asks for one), is the manual's in German.
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text).toContain('Betriebsanleitung');
    expect(text).not.toContain('Operating manual');
  });

  it('are units of the manual’s own text in the translation status', async () => {
    t.actAs(manager);
    const one = await t.get('/translations/status/de/manuals/operating');
    expect(one.status).toBe(200);
    const blocks = TranslationStatusDocument.parse(one.body).data.meta.blocks;
    expect(blocks[0]).toEqual({ blockId: 'title', state: 'outdated' });
    expect(blocks[1]?.blockId).toMatch(/^group\.[0-9a-f]{12}$/);
  });
});

describe('the project labels (#731)', () => {
  let xliff: string;
  let branch: string;

  it('come first in the translation status, are found by “labels”, and have a status of their own', async () => {
    t.actAs(manager);
    const rows = await configRows();
    expect(rows[0]).toBe(
      `de/config/project config missing ${LABELS}/${LABELS}`,
    );
    expect(await configRows('&filter[q]=labels')).toEqual([rows[0]]);
    expect(await configRows('&filter[kind]=config')).toEqual([rows[0]]);
    expect(await configRows('&filter[manual]=operating')).toContain(rows[0]);
    expect(await configRows('&filter[folder]=procedure')).not.toContain(
      rows[0],
    );
    const one = await t.get('/translations/status/de/config/project');
    expect(one.status).toBe(200);
    const status = TranslationStatusDocument.parse(one.body).data;
    expect(status).toMatchObject({
      id: 'de/config/project',
      attributes: { kind: 'config', lang: 'de', state: 'missing' },
      meta: { title: 'Project labels', totalBlocks: LABELS },
    });
    expect(status.attributes).not.toHaveProperty('moduleId');
    expect(status.meta.blocks[0]).toEqual({
      blockId: 'moduleTypes.concept',
      state: 'missing',
    });
    expect((await t.get('/translations/status/it/config/project')).status).toBe(
      404,
    );
    t.actAs(actorWith(['content.read']));
    expect((await t.get('/translations/status/de/config/project')).status).toBe(
      403,
    );
  });

  it('go out in a file of their own', async () => {
    t.actAs(manager);
    const res = await t.post('/translations/exports').send({
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['de'],
          subject: { type: 'config' },
          ref: 'main',
        },
      },
    });
    expect(res.status).toBe(201);
    const job = TranslationJobDocument.parse(res.body).data;
    expect(job.attributes.subject).toEqual({ type: 'config' });
    expect(job.meta).toMatchObject({ modules: 1, units: LABELS });
    const file = await t.get(`/translations/exports/${job.id}/file?lang=de`);
    expect(file.status).toBe(200);
    xliff = file.text;
    expect(xliff).toContain(
      '<file id="config.project" original="openfolia.yaml"',
    );
    expect(await configRows('&filter[kind]=config')).toEqual([
      `de/config/project config at-provider 0/${LABELS}`,
    ]);
  });

  it('are outside the scope of a translation manager who may not change the configuration', async () => {
    t.actAs(translator);
    const res = await upload(translated(xliff, (_u, s) => `${s} DE`));
    expect(res.status).toBe(201);
    const checked = TranslationImportDocument.parse(res.body);
    expect(checked.data.meta.report[0]).toMatchObject({
      moduleId: 'config.project',
      config: true,
    });
    expect(checked.data.meta.counts).toMatchObject({
      units: LABELS,
      outsideScope: LABELS,
    });
  });

  it('come back in with an import: openfolia.yaml’s German labels and record, up to date', async () => {
    t.actAs(manager);
    const res = await upload(
      translated(xliff, (unit, source) =>
        unit === 'moduleTypes.concept' ? 'Konzept' : `${source} DE`,
      ),
    );
    expect(res.status).toBe(201);
    const checked = TranslationImportDocument.parse(res.body);
    expect(checked.data.meta.counts).toMatchObject({
      units: LABELS,
      ok: LABELS,
    });
    const applied = await t.post(
      `/translations/imports/${checked.data.id}/apply`,
    );
    expect(applied.status).toBe(200);
    const doc = TranslationImportDocument.parse(applied.body);
    branch = `change-sets/${doc.data.relationships.changeSet.data?.id}`;
    const config = parseConfig(git('show', `${branch}:openfolia.yaml`));
    expect(config.moduleTypes[0]?.label).toEqual({
      en: 'Concept',
      de: 'Konzept',
    });
    expect(Object.keys(config.translations?.['de']?.blocks ?? {})).toHaveLength(
      LABELS,
    );
    expect(await configRows('&filter[kind]=config', branch)).toEqual([
      `de/config/project config up-to-date 0/${LABELS}`,
    ]);
    // Delivered as stored.
    const read = await t.get(`/config?ref=${encodeURIComponent(branch)}`);
    expect(read.status).toBe(200);
    expect(
      ProjectConfigDocument.parse(read.body).data.attributes.moduleTypes[0]
        ?.label,
    ).toEqual({ en: 'Concept', de: 'Konzept' });
    const variants = await t.get(`/variants?ref=${encodeURIComponent(branch)}`);
    expect(variants.status).toBe(200);
    expect(
      VariantAttributePageDocument.parse(variants.body).data[0]?.attributes
        .label,
    ).toEqual({ en: 'Model', de: 'Model DE' });
    // The coverage report counts them for each manual.
    const report = TranslationCoveragePageDocument.parse(
      (
        await t.get(
          `/reports/translations?ref=${encodeURIComponent(branch)}&filter[manual]=operating&filter[lang]=de`,
        )
      ).body,
    );
    expect(report.data[0]?.meta.labels).toEqual({
      total: LABELS,
      upToDate: LABELS,
      outdated: 0,
      atProvider: 0,
      missing: 0,
    });
  });

  it('are marked current after a source change, in the import’s change set', async () => {
    t.actAs(manager);
    const config = parseConfig(git('show', `${branch}:openfolia.yaml`));
    await new GitWriter(dir()).commit({
      branch,
      parent: git('rev-parse', branch),
      changes: [
        {
          path: 'openfolia.yaml',
          content: printConfig({
            ...config,
            moduleTypes: config.moduleTypes.map((m) =>
              m.id === 'concept'
                ? { ...m, label: { en: 'Concepts', de: 'Konzept' } }
                : m,
            ),
          }),
        },
      ],
      message: 'A source fix',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    expect(await configRows('&filter[kind]=config', branch)).toEqual([
      `de/config/project config outdated 1/${LABELS}`,
    ]);
    const attributes = {
      changeSetId: branch.slice('change-sets/'.length),
      config: true,
      lang: 'de',
    };
    t.actAs(translator);
    const refused = await t
      .post('/translations/mark-current')
      .send({ data: { type: 'TranslationMarkCurrent', attributes } });
    expect(refused.status).toBe(403);
    t.actAs(manager);
    const res = await t
      .post('/translations/mark-current')
      .send({ data: { type: 'TranslationMarkCurrent', attributes } });
    expect(res.status).toBe(200);
    expect(MarkedCurrentDocument.parse(res.body).data.attributes).toMatchObject(
      { moduleId: 'config.project', config: true, blocks: LABELS },
    );
    expect(await configRows('&filter[kind]=config', branch)).toEqual([
      `de/config/project config up-to-date 0/${LABELS}`,
    ]);
    const two = await t.post('/translations/mark-current').send({
      data: {
        type: 'TranslationMarkCurrent',
        attributes: { ...attributes, moduleId: 'charging' },
      },
    });
    expect(two.status).toBe(400);
    // The import's change set goes, and the configuration's lock with it.
    expect(
      (await t.post(`/change-sets/${attributes.changeSetId}/abandon`).send())
        .status,
    ).toBe(200);
  });

  it('keep their record out of reach of one who manages no translation, in a working copy of openfolia.yaml', async () => {
    t.actAs(admin);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Labels' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id } = ChangeSetDocument.parse(created.body).data;
    const locked = await t.post(`/change-sets/${id}/locks`).send(
      JSON.stringify({
        data: { type: 'Lock', attributes: { subject: { type: 'config' } } },
      }),
    );
    expect(locked.status).toBe(201);
    const path = `/change-sets/${id}/config/working-copy`;
    const read = await t.get(path);
    expect(read.status).toBe(200);
    const { content, version, baseCommit } = read.body.data.attributes as {
      content: Record<string, unknown>;
      version: number;
      baseCommit: string;
    };
    const save = (next: unknown) =>
      t.put(path).send(
        JSON.stringify({
          data: { type: 'WorkingCopy', attributes: { content: next } },
          meta: { version, baseCommit },
        }),
      );
    const record = {
      de: {
        sourceCommit: git('rev-parse', 'main'),
        blocks: { 'moduleTypes.concept': 'f'.repeat(64) },
      },
    };
    const refused = await save({ ...content, translations: record });
    expect(refused.status).toBe(422);
    expect(ErrorDocument.parse(refused.body).errors[0]).toMatchObject({
      code: 'translation-record-protected',
      meta: { subject: { type: 'config' }, languages: ['de'] },
    });
    // A label typed in German is the admin's to write; its record stays as committed (none).
    const labelled = await save({
      ...content,
      audiences: [
        { id: 'public', label: { en: 'Public', de: 'Öffentlich' } },
        { id: 'internal', label: 'Internal' },
      ],
    });
    expect(labelled.status).toBe(200);
    // A map without the source language is no configuration to store (the strict schema, as
    // for any other member it refuses).
    const sourceless = await save({
      ...content,
      audiences: [
        { id: 'public', label: { de: 'Öffentlich' } },
        { id: 'internal', label: 'Internal' },
      ],
    });
    expect(sourceless.status).toBe(400);
    expect((await t.post(`/change-sets/${id}/abandon`).send()).status).toBe(
      200,
    );
  });
});
