import { execFileSync } from 'node:child_process';
import { printModule } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ModuleUsagePageDocument,
  TranslationCoveragePageDocument,
} from '../src/reports/api/reports.resources.js';
import { actorWith } from './fakes/actors.js';
import { module } from './fakes/fake-content.js';
import { FakeTranslationJobs } from './fakes/fake-translation-jobs.js';
import { createTestApp, type TestApp } from './test-app.js';

const jobs = new FakeTranslationJobs();
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

/** A commit on a branch of its own adding `orphan` (in no manual), and `lonely`, a module referring to it. */
let orphans: string;

beforeAll(async () => {
  t = await createTestApp({}, { translationJobs: jobs });
  const writer = new GitWriter(dir());
  const main = git('rev-parse', 'refs/heads/main');
  await writer.createBranch('report-orphans', main);
  const orphan = module('orphan');
  const lonely = {
    ...module('lonely'),
    blocks: [{ type: 'moduleRef' as const, id: 'ref', module: 'orphan' }],
  };
  orphans = (
    await writer.commit({
      branch: 'report-orphans',
      parent: main,
      changes: [
        { path: 'modules/en/orphan.adoc', content: printModule(orphan) },
        { path: 'modules/en/lonely.adoc', content: printModule(lonely) },
      ],
      message: 'Add modules no manual includes',
      author: { name: 'Test', email: 'test@example.com' },
    })
  ).commit;
});
afterAll(() => t?.close());
afterEach(() => {
  t?.actAs(undefined);
  jobs.units = [];
});

const lead = (scope: Scope = {}) =>
  actorWith(['content.read', 'content.read.draft'], scope);
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const coverage = (body: unknown) =>
  TranslationCoveragePageDocument.parse(body).data.map(
    ({ id, meta: { modules: m, blocks: b } }) =>
      `${id} ${m.upToDate}/${m.outdated}/${m.atProvider}/${m.missing} of ${m.total}; ${b.upToDate}/${b.outdated}/${b.atProvider}/${b.missing} of ${b.total}`,
  );
const usage = (body: unknown) =>
  ModuleUsagePageDocument.parse(body).data.map(
    ({ id, meta }) => `${id} ${meta.usage.manuals}/${meta.usage.modules}`,
  );

describe('GET /reports/translations', () => {
  it('reports each manual per target language on the sample', async () => {
    t.actAs(lead());
    const res = await t.get('/reports/translations');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.api\+json/);
    expect(res.headers['x-ccms-commit']).toBe(t.commits.main);
    // `charging` (outdated in German), `internals` and `safety-note`
    // (through `charging`'s reference): missing.
    expect(coverage(res.body)).toEqual([
      'operating/de 0/1/0/2 of 3; 1/1/0/3 of 5',
      'operating/fr 0/0/0/3 of 3; 0/0/0/5 of 5',
      'service/de 0/1/0/2 of 3; 1/1/0/3 of 5',
      'service/fr 0/0/0/3 of 3; 0/0/0/5 of 5',
    ]);
    const doc = TranslationCoveragePageDocument.parse(res.body);
    expect(doc.data[0]).toMatchObject({
      type: 'TranslationCoverage',
      attributes: { manualId: 'operating', lang: 'de' },
      meta: { title: 'Operating manual', deprecated: false },
    });
    expect(doc.meta.page.total).toBe(4);
  });

  it('counts the modules the translation status lists for that manual and language', async () => {
    t.actAs(lead());
    jobs.units = [{ lang: 'de', moduleId: 'charging', blockId: 'intro' }];
    const res = await t.get(
      '/reports/translations?filter[manual]=operating&filter[lang]=de',
    );
    expect(coverage(res.body)).toEqual([
      'operating/de 0/0/1/2 of 3; 1/0/1/3 of 5',
    ]);
    const status = await t.get(
      '/translations/status?filter[manual]=operating&filter[lang]=de',
    );
    // The modules, and beside them the project labels and the manual's title (#731).
    expect(
      (status.body as { meta: { page: { total: number } } }).meta.page.total,
    ).toBe(5);
  });

  it('names and counts nothing outside the reader’s scope', async () => {
    t.actAs(lead({ languages: ['en', 'de'], maxAudience: 'public' }));
    const res = await t.get('/reports/translations');
    // No French, no service manual, no `internals`.
    expect(coverage(res.body)).toEqual([
      'operating/de 0/1/0/1 of 2; 1/1/0/2 of 4',
    ]);
    expect(
      TranslationCoveragePageDocument.parse(res.body).meta.page.total,
    ).toBe(1);
    const csv = await t.get('/reports/translations/csv');
    expect(csv.text).not.toMatch(/service|internals/);
    expect(csv.headers['x-ccms-rows']).toBe('1');
  });

  it('pages, and refuses what it does not take', async () => {
    t.actAs(lead());
    const res = await t.get(
      '/reports/translations?page[size]=1&page[number]=2',
    );
    expect(coverage(res.body)).toEqual([
      'operating/fr 0/0/0/3 of 3; 0/0/0/5 of 5',
    ]);
    expect(
      TranslationCoveragePageDocument.parse(res.body).links.next,
    ).toContain('page%5Bnumber%5D=3');
    for (const query of [
      'filter[lang]=not a tag',
      'filter[nope]=1',
      'sort=id',
    ]) {
      const refused = await t.get(`/reports/translations?${query}`);
      expect([query, refused.status]).toEqual([query, 400]);
    }
  });

  it('needs content.read.draft', async () => {
    t.actAs(as(['content.read', 'translation.manage']));
    for (const path of ['/reports/translations', '/reports/translations/csv']) {
      const refused = await t.get(path);
      expect([path, refused.status]).toEqual([path, 403]);
      expect(ErrorDocument.parse(refused.body).errors[0]?.code).toBe(
        'forbidden',
      );
    }
  });
});

describe('GET /reports/translations/csv', () => {
  it('downloads the whole report as CSV', async () => {
    t.actAs(lead());
    const res = await t.get('/reports/translations/csv?filter[lang]=de');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'text/csv; charset=utf-8; header=present',
    );
    expect(res.headers['content-disposition']).toContain(
      `filename="translation-coverage-${t.commits.main.slice(0, 12)}.csv"`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-ccms-rows']).toBe('2');
    expect(res.text.split('\r\n')).toEqual([
      'manual,title,language,deprecated,modules,modules up to date,modules outdated,modules at provider,modules missing,percent up to date,blocks,blocks up to date,blocks outdated,blocks at provider,blocks missing,percent blocks up to date,design units,design units up to date,design units outdated,design units at provider,design units missing,cover units,cover units up to date,cover units outdated,cover units at provider,cover units missing,label units,label units up to date,label units outdated,label units at provider,label units missing',
      'operating,Operating manual,de,false,3,0,1,0,2,0,5,1,1,0,3,20,0,0,0,0,0,1,0,0,0,1,12,0,0,0,12',
      'service,Service manual,de,false,3,0,1,0,2,0,5,1,1,0,3,20,0,0,0,0,0,2,0,0,0,2,12,0,0,0,12',
      '',
    ]);
  });

  it('changes its ETag when blocks go to a provider, on the same commit', async () => {
    t.actAs(lead());
    const before = await t.get('/reports/translations/csv');
    jobs.units = [{ lang: 'de', moduleId: 'charging', blockId: 'intro' }];
    const after = await t
      .get('/reports/translations/csv')
      .set('If-None-Match', before.headers['etag'] as string);
    expect(after.status).toBe(200);
    expect(after.headers['etag']).not.toBe(before.headers['etag']);
    const again = await t
      .get('/reports/translations/csv')
      .set('If-None-Match', after.headers['etag'] as string);
    expect(again.status).toBe(304);
  });

  it('refuses a parameter it does not take, as JSON:API', async () => {
    t.actAs(lead());
    const res = await t.get('/reports/translations/csv?page[size]=2');
    expect(res.status).toBe(400);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'unsupported-parameter',
    );
  });
});

describe('GET /reports/module-usage', () => {
  it('lists every module with its use counts', async () => {
    t.actAs(lead());
    const res = await t.get('/reports/module-usage');
    expect(res.status).toBe(200);
    // By title: Charging, Internals, Safety note.
    expect(usage(res.body)).toEqual([
      'charging 2/0',
      'internals 2/0',
      'safety-note 2/1',
    ]);
    const doc = ModuleUsagePageDocument.parse(res.body);
    expect(doc.data[0]).toMatchObject({
      type: 'ModuleUsage',
      attributes: {
        moduleId: 'charging',
        title: 'Charging',
        type: 'procedure',
        deprecated: false,
      },
      meta: { languages: ['en', 'de'] },
    });
    expect(doc.data[2]?.meta.usedIn).toEqual([
      {
        kind: 'manual',
        id: 'operating',
        title: 'Operating manual',
        direct: false,
        deprecated: false,
      },
      {
        kind: 'manual',
        id: 'service',
        title: 'Service manual',
        direct: false,
        deprecated: false,
      },
      {
        kind: 'module',
        id: 'charging',
        title: 'Charging',
        direct: true,
        deprecated: false,
      },
    ]);
  });

  it('lists a module no manual includes as unused, not one included only through a module reference', async () => {
    t.actAs(lead());
    const unused = await t.get(
      `/reports/module-usage?ref=${orphans}&filter[unused]=true`,
    );
    expect(unused.status).toBe(200);
    // `orphan` is referred to by `lonely`, which no manual includes either;
    // `safety-note`, reached through `charging`, is not unused.
    expect(usage(unused.body)).toEqual(['lonely 0/0', 'orphan 0/1']);
    expect(
      usage(
        (
          await t.get(
            `/reports/module-usage?ref=${orphans}&filter[unused]=false&sort=-modules,id`,
          )
        ).body,
      ),
    ).toEqual(['safety-note 2/1', 'charging 2/0', 'internals 2/0']);
    expect(
      usage(
        (
          await t.get(
            `/reports/module-usage?ref=${orphans}&filter[type]=procedure`,
          )
        ).body,
      ),
    ).toEqual(['charging 2/0']);
  });

  it('names and counts nothing outside the reader’s scope', async () => {
    t.actAs(lead({ maxAudience: 'public' }));
    const res = await t.get('/reports/module-usage');
    // No `internals`, no service manual.
    expect(usage(res.body)).toEqual(['charging 1/0', 'safety-note 1/1']);
    const doc = ModuleUsagePageDocument.parse(res.body);
    expect(doc.meta.page.total).toBe(2);
    expect(JSON.stringify(doc)).not.toMatch(/service|internals/i);
  });

  it('refuses a malformed filter or sort, and needs content.read.draft', async () => {
    t.actAs(lead());
    for (const query of [
      'filter[unused]=yes',
      'filter[type]=Not A Key',
      'sort=nope',
      'sort=id,-id',
      'filter[lang]=de',
    ]) {
      const res = await t.get(`/reports/module-usage?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
    t.actAs(as(['content.read']));
    expect((await t.get('/reports/module-usage')).status).toBe(403);
    expect((await t.get('/reports/module-usage/csv')).status).toBe(403);
  });

  it('needs content.read.draft even with a matching If-None-Match (#365)', async () => {
    // A reader's ETag for the commit, from a route it may read.
    t.actAs(as(['content.read']));
    const etag = (await t.get('/manuals')).headers['etag'] as string;
    for (const path of ['/reports/module-usage', '/reports/module-usage/csv']) {
      const res = await t.get(path).set('If-None-Match', etag);
      expect([path, res.status]).toEqual([path, 403]);
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
    }
    // A lead's own ETag still gets its 304.
    t.actAs(lead());
    const own = await t.get('/reports/module-usage');
    expect(
      (
        await t
          .get('/reports/module-usage')
          .set('If-None-Match', own.headers['etag'] as string)
      ).status,
    ).toBe(304);
  });
});

describe('GET /reports/module-usage/csv', () => {
  it('downloads every module with all its uses', async () => {
    t.actAs(lead());
    const res = await t.get(`/reports/module-usage/csv?ref=${orphans}&sort=id`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'text/csv; charset=utf-8; header=present',
    );
    expect(res.headers['content-disposition']).toContain(
      `filename="module-usage-${orphans.slice(0, 12)}.csv"`,
    );
    expect(res.headers['x-ccms-rows']).toBe('5');
    expect(res.text.split('\r\n')).toEqual([
      'module,title,type,deprecated,languages,manuals,modules,used in manuals,used in modules',
      'charging,Charging,procedure,false,en de,2,0,"operating\nservice",',
      'internals,Internals,concept,false,en,2,0,"operating\nservice",',
      'lonely,Title of lonely,concept,false,en,0,0,,',
      'orphan,Title of orphan,concept,false,en,0,1,,lonely',
      'safety-note,Safety note,concept,false,en,2,1,"operating\nservice",charging',
      '',
    ]);
  });
});
