import { execFileSync } from 'node:child_process';
import {
  parseModule,
  parseTranslationRecord,
  printModule,
  sourceHashes,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { and, eq } from 'drizzle-orm';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import {
  MarkedCurrentDocument,
  TranslationImportDocument,
} from '../src/translations/api/translation-import.resources.js';
import { TranslationJobDocument } from '../src/translations/api/translation-job.resources.js';
import { TranslationStatusDocument } from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const show = (ref: string, path: string) => git('show', `${ref}:${path}`);

/** A translator: manages translations, edits content, reads drafts. */
const translator = (scope: Scope = {}) =>
  actorWith(
    [
      'content.read',
      'content.read.draft',
      'content.edit',
      'translation.manage',
    ],
    scope,
  );
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

const upload = (
  bytes: Uint8Array | string,
  fields: Record<string, string> = {},
) => {
  let req = t
    .anonymous()
    .post('/translations/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1');
  for (const [name, value] of Object.entries(fields))
    req = req.field(name, value);
  const data =
    typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return req.attach('file', data, 'translation.xlf');
};

/** Exports `charging` from main into `languages`; the job. */
async function exportCharging(languages: string[]) {
  const res = await t.post('/translations/exports').send({
    data: {
      type: 'TranslationJob',
      attributes: {
        languages,
        subject: { type: 'modules', moduleIds: ['charging'] },
        ref: 'main',
      },
    },
  });
  expect(res.status).toBe(201);
  return TranslationJobDocument.parse(res.body).data;
}

/** The job's XLIFF per language. */
async function filesOf(jobId: string): Promise<Record<string, string>> {
  const zip = await t
    .get(`/translations/exports/${jobId}/file`)
    .buffer(true)
    .parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
  expect(zip.status).toBe(200);
  const files = unzipSync(new Uint8Array(zip.body as Buffer));
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      /-([a-z]+)\.xlf$/.exec(name)?.[1] as string,
      strFromU8(bytes),
    ]),
  );
}

/** Each `<source>` given a `<target>`: `translate` per unit ID and segment's source. */
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

/** German and French as a translator would write them: the codes kept. */
const TRANSLATIONS: Record<string, Record<string, string>> = {
  de: {
    intro: 'Das <ph id="1"/> lädt sich automatisch.',
    photo: 'Das Ladegerät',
  },
  fr: {
    intro: 'Le <ph id="1"/> se recharge automatiquement.',
    photo: 'Le chargeur',
  },
};
const translate = (lang: string) => (unit: string, source: string) =>
  TRANSLATIONS[lang]?.[unit] ?? source;

const zipOf = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]),
    ),
  );

const changeSetCount = async () =>
  (await t.get('/change-sets?page[size]=1')).body.meta.page.total as number;

/** The upload limit here: far above any document of these tests. */
const MAX_UPLOAD = 64 * 1024;

beforeAll(async () => {
  t = await createTestApp({ CCMS_MAX_UPLOAD_BYTES: String(MAX_UPLOAD) });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('a translation import, round trip', () => {
  let jobId: string;
  let files: Record<string, string>;
  let importId: string;
  let changeSetId: string;

  it('validates a translated ZIP unit by unit and writes nothing', async () => {
    t.actAs(translator());
    const job = await exportCharging(['de', 'fr']);
    jobId = job.id;
    files = await filesOf(jobId);
    // German: only the intro was outdated; French: everything was missing.
    expect(
      [...files['de']!.matchAll(/<unit id="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(['intro']);
    const before = await changeSetCount();
    const res = await upload(
      zipOf({
        'de.xlf': translated(files['de'] as string, translate('de')),
        'fr.xlf': translated(files['fr'] as string, translate('fr')),
      }),
      { dryRun: 'true', baseRef: 'main' },
    );
    expect(res.status).toBe(201);
    const doc = TranslationImportDocument.parse(res.body);
    importId = doc.data.id;
    expect(res.headers['location']).toBe(`/translations/imports/${importId}`);
    expect(doc.data.attributes).toMatchObject({
      languages: ['de', 'fr'],
      baseRef: 'main',
      baseCommit: t.commits.main,
      state: 'validated',
    });
    expect(doc.data.relationships).toEqual({
      job: { data: { type: 'TranslationJob', id: jobId } },
      changeSet: { data: null },
    });
    expect(doc.data.meta.counts).toMatchObject({ units: 3, ok: 3 });
    expect(doc.data.meta.report).toEqual([
      {
        lang: 'de',
        moduleId: 'charging',
        title: 'Charging',
        units: [{ blockId: 'intro', kind: 'paragraph', state: 'ok' }],
      },
      {
        lang: 'fr',
        moduleId: 'charging',
        title: 'Charging',
        units: [
          { blockId: 'intro', kind: 'paragraph', state: 'ok' },
          { blockId: 'photo', kind: 'image', state: 'ok' },
        ],
      },
    ]);
    // Nothing written: no change set, no audit event, no outbox row, the job still sent.
    expect(await changeSetCount()).toBe(before);
    const events = await t.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'translation.import'));
    expect(events).toEqual([]);
    const job_ = await t.get(`/translations/exports/${jobId}`);
    expect(TranslationJobDocument.parse(job_.body).data.attributes.state).toBe(
      'sent',
    );

    // The report pages per module.
    const page = TranslationImportDocument.parse(
      (
        await t.get(
          `/translations/imports/${importId}?page[number]=2&page[size]=1`,
        )
      ).body,
    );
    expect(page.data.meta.report.map((m) => m.lang)).toEqual(['fr']);
    expect(page.meta.page).toMatchObject({
      total: 2,
      currentPage: 2,
      lastPage: 2,
    });
    expect(decodeURIComponent(page.links.prev ?? '')).toContain(
      'page[number]=1',
    );
  });

  it('is only its uploader’s', async () => {
    t.actAs({ ...translator(), id: 'someone-else' });
    expect((await t.get(`/translations/imports/${importId}`)).status).toBe(404);
    expect(
      (await t.post(`/translations/imports/${importId}/apply`)).status,
    ).toBe(404);
  });

  it('applies into exactly one change set with one save point, the translations up to date there', async () => {
    t.actAs(translator());
    const before = await changeSetCount();
    const res = await t.post(`/translations/imports/${importId}/apply`);
    expect(res.status).toBe(200);
    const doc = TranslationImportDocument.parse(res.body);
    expect(doc.data.attributes.state).toBe('applied');
    changeSetId = doc.data.relationships.changeSet.data?.id as string;
    expect(changeSetId).toBeDefined();
    expect(await changeSetCount()).toBe(before + 1);
    const branch = `change-sets/${changeSetId}`;
    // One save point on top of the base.
    expect(git('rev-list', '--count', `main..${branch}`)).toBe('1');
    expect(doc.data.meta.commit).toBe(git('rev-parse', branch));

    // German: only the intro changed; its keywords, title, image stay.
    const de = parseModule(show(branch, 'modules/de/charging.adoc'), {
      id: 'charging',
    });
    const deBefore = parseModule(show('main', 'modules/de/charging.adoc'), {
      id: 'charging',
    });
    expect(de.meta).toEqual(deBefore.meta);
    expect(de.blocks.find((b) => b.id === 'intro')).toEqual({
      type: 'paragraph',
      id: 'intro',
      content: [
        { type: 'text', text: 'Das ' },
        { type: 'attribute', name: 'product-name' },
        { type: 'text', text: ' lädt sich automatisch.' },
      ],
    });
    expect(de.blocks.filter((b) => b.id !== 'intro')).toEqual(
      deBefore.blocks.filter((b) => b.id !== 'intro'),
    );
    // French: made from the source's structure, the image's file kept.
    const fr = parseModule(show(branch, 'modules/fr/charging.adoc'), {
      id: 'charging',
    });
    const source = parseModule(show('main', 'modules/en/charging.adoc'), {
      id: 'charging',
    });
    expect(fr.meta.lang).toBe('fr');
    expect(fr.blocks.map((b) => b.id)).toEqual(source.blocks.map((b) => b.id));
    expect(fr.blocks.find((b) => b.id === 'photo')).toEqual({
      ...source.blocks.find((b) => b.id === 'photo'),
      alt: 'Le chargeur',
    });
    // The records name the source each unit was exported from.
    const record = parseTranslationRecord(
      show(branch, 'modules/fr/charging.translation.yaml'),
    );
    expect(record.blocks).toEqual(
      Object.fromEntries(sourceHashes(source as Module)),
    );
    for (const lang of ['de', 'fr']) {
      const status = await t.get(
        `/translations/status/${lang}/charging?ref=${branch}`,
      );
      expect(
        TranslationStatusDocument.parse(status.body).data.attributes.state,
      ).toBe('up-to-date');
    }
    // The job is back; one audit event and one outbox row.
    const job = await t.get(`/translations/exports/${jobId}`);
    expect(TranslationJobDocument.parse(job.body).data.attributes.state).toBe(
      'returned',
    );
    const events = await t.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'translation.import'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subjectType: 'translation-import',
      subjectId: importId,
      data: expect.objectContaining({ jobId, changeSetId, units: 3, kept: 0 }),
    });
    const rows = await t.database.db
      .select()
      .from(outbox)
      .where(
        and(eq(outbox.topic, 'translation.imported'), eq(outbox.key, importId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      importId,
      changeSetId,
      jobId,
      languages: ['de', 'fr'],
      modules: [
        { lang: 'de', moduleId: 'charging' },
        { lang: 'fr', moduleId: 'charging' },
      ],
    });
  });

  it('is applied once', async () => {
    t.actAs(translator());
    const again = await t.post(`/translations/imports/${importId}/apply`);
    expect(again.status).toBe(409);
    expect(error(again.body)).toMatchObject({
      code: 'invalid-state',
      meta: { state: 'applied' },
    });
    const read = TranslationImportDocument.parse(
      (await t.get(`/translations/imports/${importId}`)).body,
    );
    expect(read.data.relationships.changeSet.data?.id).toBe(changeSetId);
  });

  it('marks a translation current in a change set, its text unchanged', async () => {
    t.actAs(translator());
    // The German translation on main is outdated (its intro).
    const created = await t.post('/change-sets').send({
      data: { type: 'ChangeSet', attributes: { title: 'Source fix' } },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const res = await t.post('/translations/mark-current').send({
      data: {
        type: 'TranslationMarkCurrent',
        attributes: { changeSetId: id, moduleId: 'charging', lang: 'de' },
      },
    });
    // The import's change set holds the German module's lock.
    expect(res.status).toBe(409);
    expect(error(res.body)?.code).toBe('locked');
    const abandoned = await t.post(`/change-sets/${changeSetId}/abandon`);
    expect(abandoned.status).toBe(200);
    const marked = await t.post('/translations/mark-current').send({
      data: {
        type: 'TranslationMarkCurrent',
        attributes: { changeSetId: id, moduleId: 'charging', lang: 'de' },
      },
    });
    expect(marked.status).toBe(200);
    const done = MarkedCurrentDocument.parse(marked.body).data;
    expect(done.attributes).toMatchObject({
      lang: 'de',
      moduleId: 'charging',
      blocks: 2,
    });
    const branch = `change-sets/${id}`;
    expect(show(branch, 'modules/de/charging.adoc')).toBe(
      show('main', 'modules/de/charging.adoc'),
    );
    const status = await t.get(
      `/translations/status/de/charging?ref=${branch}`,
    );
    expect(
      TranslationStatusDocument.parse(status.body).data.attributes.state,
    ).toBe('up-to-date');
    const events = await t.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'translation.mark-current'));
    expect(events).toHaveLength(1);
    await t.post(`/change-sets/${id}/abandon`);
  });
});

describe('refusing', () => {
  let xliff: string;
  let jobId: string;

  beforeAll(async () => {
    t.actAs(translator());
    const job = await exportCharging(['fr']);
    jobId = job.id;
    xliff = (await filesOf(job.id))['fr'] as string;
    t.actAs(undefined);
  });
  afterAll(async () => {
    // Its units back from the provider, for the next export.
    t.actAs(translator());
    expect((await t.post(`/translations/exports/${jobId}/cancel`)).status).toBe(
      200,
    );
    t.actAs(undefined);
  });

  it('a unit with broken markup alone, naming its block and why', async () => {
    t.actAs(translator());
    const res = await upload(
      translated(xliff, (unit, source) =>
        unit === 'intro'
          ? 'Le chargeur se recharge.'
          : translate('fr')(unit, source),
      ),
    );
    expect(res.status).toBe(201);
    const doc = TranslationImportDocument.parse(res.body);
    expect(doc.data.meta.report).toEqual([
      {
        lang: 'fr',
        moduleId: 'charging',
        title: 'Charging',
        units: [
          {
            blockId: 'intro',
            kind: 'paragraph',
            state: 'broken-markup',
            reason: 'missing-code',
            detail: expect.stringContaining('code 1'),
          },
          { blockId: 'photo', kind: 'image', state: 'ok' },
        ],
      },
    ]);
    // One state only: the units in it, and the modules with one; the counts stay whole.
    const only = await t.get(
      `/translations/imports/${doc.data.id}?filter[state]=ok`,
    );
    expect(only.status).toBe(200);
    const filtered = TranslationImportDocument.parse(only.body);
    expect(filtered.data.meta.report).toEqual([
      {
        lang: 'fr',
        moduleId: 'charging',
        title: 'Charging',
        units: [{ blockId: 'photo', kind: 'image', state: 'ok' }],
      },
    ]);
    expect(filtered.data.meta.counts).toMatchObject({
      units: 2,
      ok: 1,
      brokenMarkup: 1,
    });
    const none = TranslationImportDocument.parse(
      (
        await t.get(
          `/translations/imports/${doc.data.id}?filter[state]=source-changed`,
        )
      ).body,
    );
    expect(none.data.meta.report).toEqual([]);
    expect(none.meta.page.total).toBe(0);
    const wrong = await t.get(
      `/translations/imports/${doc.data.id}?filter[state]=fine`,
    );
    expect(wrong.status).toBe(400);
  });

  it('without translation.manage, or for a language outside the scope: 403', async () => {
    const body = translated(xliff, translate('fr'));
    t.actAs(as(['content.read', 'content.read.draft', 'content.edit']));
    expect((await upload(body)).status).toBe(403);
    t.actAs(translator({ languages: ['de'] }));
    const outside = await upload(body);
    expect(outside.status).toBe(403);
    expect(error(outside.body)?.code).toBe('forbidden');
  });

  it('hostile XML: an external entity, a billion laughs', async () => {
    t.actAs(translator());
    const header = '<?xml version="1.0" encoding="UTF-8"?>';
    const xxe = xliff
      .replace(
        header,
        `${header}<!DOCTYPE xliff [<!ENTITY e SYSTEM "file:///etc/passwd">]>`,
      )
      .replace('</source>', '&e;</source>');
    const res = await upload(xxe);
    expect(res.status).toBe(422);
    expect(error(res.body)?.code).toBe('xliff-dtd-forbidden');
    const lol = `<!DOCTYPE xliff [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]>`;
    const laughs = await upload(
      xliff
        .replace(header, `${header}${lol}`)
        .replace('</source>', '&c;</source>'),
    );
    expect(error(laughs.body)?.code).toBe('xliff-dtd-forbidden');
    const notXml = await upload('this is not xml');
    expect(error(notXml.body)?.code).toBe('xliff-not-well-formed');
    const unknown = await upload(
      xliff.replace(
        /ccms:job="[^"]+"/,
        'ccms:job="0190e3c0-0000-7000-8000-000000000000"',
      ),
    );
    expect(unknown.status).toBe(404);
    expect(error(unknown.body)?.code).toBe('unknown-job');
  });

  it('an upload past CCMS_MAX_UPLOAD_BYTES', async () => {
    t.actAs(translator());
    const res = await upload(Buffer.alloc(MAX_UPLOAD + 1, 'a'));
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'too-large',
      meta: { max: MAX_UPLOAD },
    });
  });

  it('a dry run other than true, and a request that is no upload', async () => {
    t.actAs(translator());
    const res = await upload(xliff, { dryRun: 'false' });
    expect(res.status).toBe(400);
    expect(error(res.body)?.code).toBe('invalid-body');
    const json = await t.post('/translations/imports').send({});
    expect(json.status).toBe(415);
  });
});

describe('a source changed since export', () => {
  it('is imported only with keep, and then stays outdated; skip leaves it out', async () => {
    t.actAs(translator());
    const job = await exportCharging(['fr']);
    const xliff = translated(
      (await filesOf(job.id))['fr'] as string,
      translate('fr'),
    );
    // The intro's source changes on main after the export.
    const writer = new GitWriter(dir());
    const main = git('rev-parse', 'refs/heads/main');
    const source = parseModule(show('main', 'modules/en/charging.adoc'), {
      id: 'charging',
    });
    await writer.commit({
      branch: 'main',
      parent: main,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule({
            ...source,
            blocks: source.blocks.map((b) =>
              b.id === 'intro' && b.type === 'paragraph'
                ? { ...b, content: [{ type: 'text', text: 'Charge it.' }] }
                : b,
            ),
          }),
        },
      ],
      message: 'Edit the intro',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const skipped = TranslationImportDocument.parse((await upload(xliff)).body);
    // The texts to decide on: the source as sent and as it is now, and the translation.
    expect(skipped.data.meta.report[0]?.units).toEqual([
      {
        blockId: 'intro',
        kind: 'paragraph',
        state: 'source-changed',
        texts: {
          exported: 'The {product-name} charges automatically.',
          current: 'Charge it.',
          target: 'Le {product-name} se recharge automatiquement.',
          truncated: false,
        },
      },
      { blockId: 'photo', kind: 'image', state: 'ok' },
    ]);
    const applied = await t
      .post(`/translations/imports/${skipped.data.id}/apply`)
      .send({
        meta: {
          decisions: [
            {
              lang: 'fr',
              moduleId: 'charging',
              blockId: 'intro',
              decision: 'skip',
            },
          ],
        },
      });
    expect(applied.status).toBe(200);
    const left = TranslationImportDocument.parse(applied.body).data;
    const leftBranch = `change-sets/${left.relationships.changeSet.data?.id}`;
    const leftRecord = parseTranslationRecord(
      show(leftBranch, 'modules/fr/charging.translation.yaml'),
    );
    expect(Object.keys(leftRecord.blocks)).toEqual(['photo']);
    await t.post(
      `/change-sets/${left.relationships.changeSet.data?.id}/abandon`,
    );

    const kept = TranslationImportDocument.parse((await upload(xliff)).body);
    const res = await t.post(`/translations/imports/${kept.data.id}/apply`);
    expect(res.status).toBe(200);
    const branch = `change-sets/${TranslationImportDocument.parse(res.body).data.relationships.changeSet.data?.id}`;
    const fr = parseModule(show(branch, 'modules/fr/charging.adoc'), {
      id: 'charging',
    });
    expect(fr.blocks.find((b) => b.id === 'intro')).toMatchObject({
      content: [
        { type: 'text', text: 'Le ' },
        { type: 'attribute', name: 'product-name' },
        { type: 'text', text: ' se recharge automatiquement.' },
      ],
    });
    const status = TranslationStatusDocument.parse(
      (await t.get(`/translations/status/fr/charging?ref=${branch}`)).body,
    ).data;
    expect(status.meta.blocks).toEqual([
      { blockId: 'intro', state: 'outdated' },
      { blockId: 'photo', state: 'up-to-date' },
    ]);
  });
});

describe('callout legends (#548)', () => {
  it('round-trip: exported as units of their own, imported onto their callouts, shown in the German preview', async () => {
    t.actAs(translator());
    // The source's picture gets two callouts on main, one only for the large model.
    const writer = new GitWriter(dir());
    const source = parseModule(show('main', 'modules/en/charging.adoc'), {
      id: 'charging',
    });
    await writer.commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule({
            ...source,
            blocks: source.blocks.map((b) =>
              b.id === 'photo' && b.type === 'image'
                ? {
                    ...b,
                    callouts: [
                      {
                        id: 'lid',
                        anchor: { x: 0.2, y: 0.2 },
                        legend: [
                          { type: 'text', text: 'Charging ' },
                          {
                            type: 'text',
                            text: 'lid',
                            marks: [{ type: 'strong' }],
                          },
                        ],
                      },
                      {
                        id: 'plug',
                        anchor: { x: 0.7, y: 0.6 },
                        legend: [{ type: 'text', text: 'Plug' }],
                        when: { op: 'in', attr: 'model', values: ['large'] },
                      },
                    ],
                  }
                : b,
            ),
          }),
        },
      ],
      message: 'Callouts on the charger',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const job = await exportCharging(['de']);
    const xliff = (await filesOf(job.id))['de'] as string;
    expect(xliff).toMatch(
      /<unit id="lid" [^>]*ccms:kind="callout" ccms:image="photo">/,
    );
    expect(xliff).toMatch(/<unit id="plug" [^>]*ccms:image="photo">/);
    const german: Record<string, string> = {
      lid: 'Lade<pc id="1" type="fmt" subType="xlf:b">klappe</pc>',
      plug: 'Stecker',
    };
    const res = await upload(
      translated(xliff, (unit, source) => german[unit] ?? source),
    );
    expect(res.status).toBe(201);
    const checked = TranslationImportDocument.parse(res.body);
    expect(checked.data.meta.report[0]?.units).toEqual(
      expect.arrayContaining([
        { blockId: 'lid', kind: 'callout', state: 'ok' },
        { blockId: 'plug', kind: 'callout', state: 'ok' },
      ]),
    );
    const applied = await t.post(
      `/translations/imports/${checked.data.id}/apply`,
    );
    expect(applied.status).toBe(200);
    const branch = `change-sets/${TranslationImportDocument.parse(applied.body).data.relationships.changeSet.data?.id}`;
    const de = parseModule(show(branch, 'modules/de/charging.adoc'), {
      id: 'charging',
    });
    const photo = de.blocks.find((b) => b.id === 'photo');
    expect(
      photo?.type === 'image' && photo.callouts?.map((c) => [c.id, c.legend]),
    ).toEqual([
      [
        'lid',
        [
          { type: 'text', text: 'Lade' },
          { type: 'text', text: 'klappe', marks: [{ type: 'strong' }] },
        ],
      ],
      ['plug', [{ type: 'text', text: 'Stecker' }]],
    ]);
    const html = await t
      .anonymous()
      .get(`/manuals/operating/variants/model=large/de/html?ref=${branch}`)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('<strong>klappe</strong>');
    expect(html.text).toContain('Stecker');
  });
});
