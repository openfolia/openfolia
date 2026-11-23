import { execFileSync } from 'node:child_process';
import {
  parseModule,
  printModule,
  printTranslationRecord,
  translationRecordOf,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { strFromU8, unzipSync } from 'fflate';
import type { Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  TranslationJobDocument,
  TranslationJobPageDocument,
} from '../src/translations/api/translation-job.resources.js';
import { TranslationStatusDocument } from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const BRANCH = 'export-edits';
const author = { name: 'Test', email: 'test@example.com' };
/** The commit on `BRANCH` with two blocks of `charging` edited since both translations were made. */
let edited: string;

const manager = (scope: Scope = {}) =>
  actorWith(
    ['content.read', 'content.read.draft', 'translation.manage'],
    scope,
  );
/** A translation manager other than the exporter. */
const colleague = (scope: Scope = {}) => ({
  ...manager(scope),
  id: 'other-manager',
});
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const exportBody = (
  attributes: Record<string, unknown>,
  meta?: Record<string, unknown>,
) => ({
  data: {
    type: 'TranslationJob',
    attributes: {
      languages: ['de', 'fr'],
      subject: { type: 'modules', moduleIds: ['charging'] },
      ref: BRANCH,
      ...attributes,
    },
  },
  ...(meta && { meta }),
});

const units = (xliff: string) =>
  [...xliff.matchAll(/<unit id="([^"]+)"/g)].map((m) => m[1]);

beforeAll(async () => {
  t = await createTestApp();
  // On a branch of its own: German and French translations made from
  // `charging` as it is on `main`, then both of its blocks edited.
  const writer = new GitWriter(dir());
  const main = git('rev-parse', 'refs/heads/main');
  await writer.createBranch(BRANCH, main);
  const source = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  const translation = (lang: string): Module => ({
    ...source,
    meta: { ...source.meta, lang },
  });
  const translated = await writer.commit({
    branch: BRANCH,
    parent: main,
    changes: ['de', 'fr'].flatMap((lang) => [
      {
        path: `modules/${lang}/charging.adoc`,
        content: printModule(translation(lang)),
      },
      {
        path: `modules/${lang}/charging.translation.yaml`,
        content: printTranslationRecord(translationRecordOf(source, main)),
      },
    ]),
    message: 'Translate',
    author,
  });
  const changed: Module = {
    ...source,
    blocks: source.blocks.map((b) =>
      b.type === 'image'
        ? { ...b, alt: 'The new charger' }
        : b.type === 'paragraph'
          ? {
              ...b,
              content: [
                { type: 'text', text: 'Plug in the ' },
                { type: 'text', text: 'charger', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' & wait.' },
              ],
            }
          : b,
    ),
  };
  edited = (
    await writer.commit({
      branch: BRANCH,
      parent: translated.commit,
      changes: [
        { path: 'modules/en/charging.adoc', content: printModule(changed) },
      ],
      message: 'Edit two blocks',
      author,
    })
  ).commit;
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('POST /translations/exports', () => {
  it('sends exactly the two edited blocks per language, recording nothing on a dry run', async () => {
    t.actAs(manager());
    const dry = await t
      .post('/translations/exports')
      .send(exportBody({ dueDate: '2026-12-01' }, { dryRun: true }));
    expect(dry.status).toBe(200);
    expect(dry.headers['location']).toBeUndefined();
    const planned = TranslationJobDocument.parse(dry.body).data;
    expect(planned.attributes).toMatchObject({
      languages: ['de', 'fr'],
      ref: BRANCH,
      commit: edited,
      state: 'sent',
      dueDate: '2026-12-01',
    });
    expect(planned.meta).toMatchObject({
      modules: 1,
      units: 4,
      dryRun: true,
      languages: [
        { lang: 'de', modules: 1, units: 2 },
        { lang: 'fr', modules: 1, units: 2 },
      ],
    });
    const list = await t.get('/translations/exports');
    expect(TranslationJobPageDocument.parse(list.body).meta.page.total).toBe(0);
    const status = await t.get(
      `/translations/status/de/charging?ref=${BRANCH}`,
    );
    expect(
      TranslationStatusDocument.parse(status.body).data.meta.blocks,
    ).toEqual([
      { blockId: 'intro', state: 'outdated' },
      { blockId: 'photo', state: 'outdated' },
    ]);
  });

  it('records a job whose units are at a provider, downloads its XLIFF, and cancels it', async () => {
    t.actAs(manager());
    const res = await t.post('/translations/exports').send(exportBody({}));
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.api\+json/);
    const job = TranslationJobDocument.parse(res.body).data;
    expect(res.headers['location']).toBe(`/translations/exports/${job.id}`);
    expect(job.meta).toMatchObject({ units: 4 });
    expect(job.meta.dryRun).toBeUndefined();

    const status = await t.get(
      `/translations/status/fr/charging?ref=${BRANCH}`,
    );
    expect(TranslationStatusDocument.parse(status.body).data).toMatchObject({
      attributes: { state: 'at-provider' },
      meta: { atProviderBlocks: 2, outdatedBlocks: 0 },
    });

    const read = await t.get(`/translations/exports/${job.id}`);
    expect(TranslationJobDocument.parse(read.body).data.id).toBe(job.id);
    const listed = TranslationJobPageDocument.parse(
      (await t.get('/translations/exports?page[size]=1')).body,
    );
    expect(listed.data.map((j) => j.id)).toEqual([job.id]);
    expect(listed.meta.page.total).toBe(1);

    const de = await t.get(`/translations/exports/${job.id}/file?lang=de`);
    expect(de.status).toBe(200);
    expect(de.headers['content-type']).toBe(
      'application/xliff+xml; charset=utf-8',
    );
    expect(de.headers['content-disposition']).toBe(
      `attachment; filename="translation-${job.id}-de.xlf"`,
    );
    expect(de.headers['x-content-type-options']).toBe('nosniff');
    const xliff = de.text;
    expect(xliff).toContain('srcLang="en" trgLang="de"');
    expect(xliff).toContain(`ccms:commit="${edited}"`);
    expect(units(xliff)).toEqual(['intro', 'photo']);
    expect(xliff).toContain(
      '<source>Plug in the <pc id="1" type="fmt" subType="xlf:b">charger</pc> &amp; wait.</source>',
    );
    expect(xliff).toContain('<source>The new charger</source>');

    const zip = await t
      .get(`/translations/exports/${job.id}/file`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toBe(
      `attachment; filename="translation-${job.id}.zip"`,
    );
    const files = unzipSync(new Uint8Array(zip.body as Buffer));
    expect(Object.keys(files)).toEqual([
      `translation-${job.id}-de.xlf`,
      `translation-${job.id}-fr.xlf`,
    ]);
    expect(
      units(strFromU8(files[`translation-${job.id}-fr.xlf`] as Uint8Array)),
    ).toEqual(['intro', 'photo']);

    // Sent already: nothing left to send.
    const again = await t.post('/translations/exports').send(exportBody({}));
    expect(again.status).toBe(422);
    expect(ErrorDocument.parse(again.body).errors[0]?.code).toBe(
      'nothing-to-translate',
    );

    const cancelled = await t.post(`/translations/exports/${job.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(
      TranslationJobDocument.parse(cancelled.body).data.attributes.state,
    ).toBe('cancelled');
    const twice = await t.post(`/translations/exports/${job.id}/cancel`);
    expect(twice.status).toBe(409);
    expect(ErrorDocument.parse(twice.body).errors[0]?.code).toBe(
      'job-not-open',
    );
    const after = await t.get(`/translations/status/fr/charging?ref=${BRANCH}`);
    expect(
      TranslationStatusDocument.parse(after.body).data.attributes.state,
    ).toBe('outdated');
  });

  it('exports the sample manual once per module, its snippet through the module reference included', async () => {
    const dryRun = async (actor: ReturnType<typeof manager>) => {
      t.actAs(actor);
      const res = await t.post('/translations/exports').send(
        exportBody(
          {
            ref: 'main',
            languages: ['de'],
            subject: { type: 'manual', manualId: 'operating' },
          },
          { dryRun: true },
        ),
      );
      expect(res.status).toBe(200);
      return TranslationJobDocument.parse(res.body).data.meta;
    };
    // `charging`'s changed intro, `internals` and `safety-note` (reached
    // through `charging`'s module reference), beside the manual's title (#731).
    expect(await dryRun(manager())).toMatchObject({ modules: 4, units: 5 });
    // The project labels (12) too for one who may change the configuration, so import them.
    expect(
      await dryRun(
        actorWith(
          [
            'content.read',
            'content.read.draft',
            'content.edit',
            'translation.manage',
            'admin.roles',
          ],
          {},
        ),
      ),
    ).toMatchObject({ modules: 5, units: 17 });
  });

  it('needs translation.manage within the language scope, without revealing modules', async () => {
    t.actAs(as(['content.read', 'content.read.draft']));
    const forbidden = await t
      .post('/translations/exports')
      .send(exportBody({}));
    expect(forbidden.status).toBe(403);
    expect(ErrorDocument.parse(forbidden.body).errors[0]?.code).toBe(
      'forbidden',
    );
    t.actAs(manager({ languages: ['en', 'de'] }));
    for (const subject of [
      { type: 'modules', moduleIds: ['charging'] },
      { type: 'modules', moduleIds: ['nope'] },
    ]) {
      const outside = await t
        .post('/translations/exports')
        .send(exportBody({ subject }));
      expect(outside.status).toBe(422);
      // The same answer whether the module exists or not.
      expect(ErrorDocument.parse(outside.body).errors).toEqual([
        expect.objectContaining({
          code: 'invalid-parameter',
          source: { pointer: '/data/attributes/languages/1' },
        }),
      ]);
    }
    const unknown = await t
      .post('/translations/exports')
      .send(exportBody({ languages: ['es'] }));
    expect(unknown.status).toBe(422);
    expect(ErrorDocument.parse(unknown.body).errors[0]?.code).toBe(
      'invalid-parameter',
    );
  });

  it('refuses a malformed body and unknown parameters', async () => {
    t.actAs(manager());
    for (const body of [
      exportBody({ languages: [] }),
      exportBody({ languages: ['de', 'de'] }),
      exportBody({ subject: { type: 'manual' } }),
      exportBody({ dueDate: '2026-02-30' }),
      exportBody({ extra: true }),
      exportBody({}, { dryRun: 'yes' }),
    ]) {
      const res = await t.post('/translations/exports').send(body);
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    const job = TranslationJobDocument.parse(
      (
        await t
          .post('/translations/exports')
          .send(exportBody({ languages: ['de'] }))
      ).body,
    ).data;
    const query = await t.get(`/translations/exports/${job.id}/file?x=1`);
    expect(query.status).toBe(400);
    expect(ErrorDocument.parse(query.body).errors[0]?.code).toBe(
      'unsupported-parameter',
    );
    const lang = await t.get(`/translations/exports/${job.id}/file?lang=fr`);
    expect(lang.status).toBe(404);
    await t.post(`/translations/exports/${job.id}/cancel`);
  });
});

describe('who sees a job', () => {
  it('is its exporter, or who reads and manages everything in its languages; to anyone else it is not found', async () => {
    t.actAs(manager());
    const job = TranslationJobDocument.parse(
      (await t.post('/translations/exports').send(exportBody({}))).body,
    ).data;
    const hidden = async () => {
      for (const path of [
        `/translations/exports/${job.id}`,
        `/translations/exports/${job.id}/file?lang=de`,
        '/translations/exports/nope',
        '/translations/exports/00000000-0000-7000-8000-000000000000/file',
      ]) {
        const res = await t.get(path);
        expect([path, res.status]).toEqual([path, 404]);
        expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('not-found');
      }
      expect(
        (await t.post(`/translations/exports/${job.id}/cancel`)).status,
      ).toBe(404);
      const list = await t.get('/translations/exports');
      expect(
        TranslationJobPageDocument.parse(list.body).data.map((j) => j.id),
      ).not.toContain(job.id);
    };
    // A language of it outside their scope.
    t.actAs(colleague({ languages: ['en', 'de'] }));
    await hidden();
    // Its subject could name modules they may not read.
    t.actAs(colleague({ maxAudience: 'public' }));
    await hidden();
    // It was made from a draft: its ref and commit are for draft readers.
    t.actAs({ ...as(['content.read', 'translation.manage']), id: 'no-drafts' });
    await hidden();
    t.actAs(as(['content.read']));
    expect((await t.get('/translations/exports')).status).toBe(403);
    t.actAs(colleague());
    expect(
      TranslationJobDocument.parse(
        (await t.get(`/translations/exports/${job.id}`)).body,
      ).data.attributes.ref,
    ).toBe(BRANCH);
    expect(
      (await t.post(`/translations/exports/${job.id}/cancel`)).status,
    ).toBe(200);
  });

  it('shows another’s draft job only to a reader of drafts in all of its languages', async () => {
    t.actAs(manager());
    const job = TranslationJobDocument.parse(
      (await t.post('/translations/exports').send(exportBody({}))).body,
    ).data;
    const reader = (draftScope: Scope) => ({
      kind: 'user' as const,
      id: 'draft-reader',
      roles: [
        {
          id: 'm',
          name: 'M',
          permissions: ['content.read', 'translation.manage'] as Permission[],
          scope: {},
        },
        {
          id: 'd',
          name: 'D',
          permissions: ['content.read.draft'] as Permission[],
          scope: draftScope,
        },
      ],
    });
    t.actAs(reader({ maxAudience: 'public' }));
    expect((await t.get(`/translations/exports/${job.id}`)).status).toBe(404);
    t.actAs(reader({ languages: ['en', 'de', 'fr'] }));
    expect((await t.get(`/translations/exports/${job.id}`)).status).toBe(200);
    t.actAs(manager());
    await t.post(`/translations/exports/${job.id}/cancel`);
  });

  it('shows a job of released content to a manager without content.read.draft', async () => {
    t.actAs(manager());
    const job = TranslationJobDocument.parse(
      (
        await t.post('/translations/exports').send(
          exportBody({
            ref: 'main',
            languages: ['de'],
            subject: { type: 'modules', moduleIds: ['charging'] },
          }),
        )
      ).body,
    ).data;
    t.actAs({ ...as(['content.read', 'translation.manage']), id: 'no-drafts' });
    expect((await t.get(`/translations/exports/${job.id}`)).status).toBe(200);
    t.actAs(manager());
    await t.post(`/translations/exports/${job.id}/cancel`);
  });
});
