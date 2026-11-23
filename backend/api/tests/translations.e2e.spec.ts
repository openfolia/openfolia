import { execFileSync } from 'node:child_process';
import {
  parseModule,
  printModule,
  printTranslationRecord,
  translationRecordOf,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Permission } from '../src/access/core/permissions.js';
import type { Scope } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CommitDocument } from '../src/change-sets/api/commit.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  TranslationStatusDocument,
  TranslationStatusPageDocument,
} from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { FakeTranslationJobs } from './fakes/fake-translation-jobs.js';
import { createTestApp, type TestApp } from './test-app.js';

const jobs = new FakeTranslationJobs();
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp({}, { translationJobs: jobs });
});
afterAll(() => t?.close());
afterEach(() => {
  t?.actAs(undefined);
  jobs.units = [];
});

const manager = (scope: Scope = {}) =>
  actorWith(['content.read', 'translation.manage'], scope);
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const rows = (body: unknown) =>
  TranslationStatusPageDocument.parse(body).data.map(
    ({ id, attributes, meta }) =>
      `${id} ${attributes.state} ${meta.outdatedBlocks}/${meta.totalBlocks}`,
  );

describe('GET /translations/status', () => {
  it('answers on the sample with its outdated German translation', async () => {
    t.actAs(manager());
    const res = await t.get('/translations/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.api\+json/);
    expect(res.headers['x-ccms-commit']).toBe(t.commits.main);
    // `charging` (the intro changed since the German was made; no French),
    // `internals`, `safety-note`: by title.
    // The project labels and the manuals' titles first (#731).
    expect(rows(res.body)).toEqual([
      'de/config/project missing 12/12',
      'fr/config/project missing 12/12',
      'de/manuals/operating missing 1/1',
      'fr/manuals/operating missing 1/1',
      'de/manuals/service missing 2/2',
      'fr/manuals/service missing 2/2',
      'de/charging outdated 1/2',
      'fr/charging missing 2/2',
      'de/internals missing 1/1',
      'fr/internals missing 1/1',
      'de/safety-note missing 2/2',
      'fr/safety-note missing 2/2',
    ]);
    const doc = TranslationStatusPageDocument.parse(res.body);
    expect(doc.data[6]).toEqual({
      type: 'TranslationStatus',
      id: 'de/charging',
      attributes: {
        kind: 'module',
        moduleId: 'charging',
        lang: 'de',
        state: 'outdated',
      },
      meta: {
        title: 'Charging',
        totalBlocks: 2,
        outdatedBlocks: 1,
        atProviderBlocks: 0,
        sourceCommit: t.commits.v1,
      },
    });
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 1,
      perPage: 50,
      total: 12,
    });
  });

  it('counts a translation without a record (at v1) as outdated in every block', async () => {
    t.actAs(manager());
    // v1 has no record yet: every block of the German file is outdated.
    const v1 = await t.get(
      '/translations/status?ref=v1&filter[lang]=de&filter[kind]=module',
    );
    expect(rows(v1.body)[0]).toBe('de/charging outdated 2/2');
  });

  it('filters before paging', async () => {
    t.actAs(manager());
    const res = await t.get(
      '/translations/status?filter[kind]=module&filter[state]=missing&page[size]=2&page[number]=2',
    );
    const doc = TranslationStatusPageDocument.parse(res.body);
    expect(doc.meta.page.total).toBe(5);
    expect(rows(res.body)).toEqual([
      'fr/internals missing 1/1',
      'de/safety-note missing 2/2',
    ]);
    expect(
      rows(
        (
          await t.get(
            '/translations/status?filter[kind]=module&filter[lang]=de&filter[manual]=operating',
          )
        ).body,
      ),
      // `safety-note` through `charging`'s module reference.
    ).toEqual([
      'de/charging outdated 1/2',
      'de/internals missing 1/1',
      'de/safety-note missing 2/2',
    ]);
    expect(
      rows(
        (
          await t.get(
            '/translations/status?filter[folder]=procedure&filter[q]=charg',
          )
        ).body,
      ),
    ).toEqual(['de/charging outdated 1/2', 'fr/charging missing 2/2']);
  });

  it('pages by row with page[by]=row: a row with all its statuses, counted once (#689)', async () => {
    t.actAs(manager());
    const first = await t.get(
      '/translations/status?filter[kind]=module&filter[state]=missing&page[by]=row&page[size]=2',
    );
    expect(first.status).toBe(200);
    const doc = TranslationStatusPageDocument.parse(first.body);
    // Missing: charging in French only, internals and safety-note in both.
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 2,
      perPage: 2,
      total: 3,
    });
    expect(rows(first.body)).toEqual([
      'fr/charging missing 2/2',
      'de/internals missing 1/1',
      'fr/internals missing 1/1',
    ]);
    expect(doc.links.next).toContain('page%5Bby%5D=row');
    const second = await t.get(doc.links.next!);
    expect(rows(second.body)).toEqual([
      'de/safety-note missing 2/2',
      'fr/safety-note missing 2/2',
    ]);
    // Without it, statuses: a page of two statuses, five in all.
    expect(
      TranslationStatusPageDocument.parse(
        (
          await t.get(
            '/translations/status?filter[kind]=module&filter[state]=missing&page[by]=status&page[size]=2',
          )
        ).body,
      ).meta.page.total,
    ).toBe(5);
    const refused = await t.get('/translations/status?page[by]=module');
    expect(refused.status).toBe(400);
    expect(ErrorDocument.parse(refused.body).errors[0]?.source).toEqual({
      parameter: 'page[by]',
    });
  });

  it('lists a page of the content list’s modules with filter[module], as the reader sees them (#694)', async () => {
    t.actAs(manager());
    const res = await t.get(
      '/translations/status?filter[module]=charging,internals,nope&page[by]=row',
    );
    expect(res.status).toBe(200);
    expect(rows(res.body)).toEqual([
      'de/charging outdated 1/2',
      'fr/charging missing 2/2',
      'de/internals missing 1/1',
      'fr/internals missing 1/1',
    ]);
    expect(TranslationStatusPageDocument.parse(res.body).meta.page.total).toBe(
      2,
    );
    expect(TranslationStatusPageDocument.parse(res.body).links.self).toContain(
      'filter%5Bmodule%5D=charging%2Cinternals%2Cnope',
    );
    // Nothing outside the reader's scope: internals is internal, French is not theirs.
    t.actAs(manager({ languages: ['en', 'de'], maxAudience: 'public' }));
    expect(
      rows(
        (
          await t.get(
            '/translations/status?filter[module]=charging,internals&page[by]=row',
          )
        ).body,
      ),
    ).toEqual(['de/charging outdated 1/2']);
    // Capped like filter[id] on /module-summaries, and each a module ID.
    t.actAs(manager());
    const many = Array.from({ length: 201 }, (_, i) => `m-${i}`).join(',');
    for (const value of [many, 'Not An ID', '', 'a,,b']) {
      const refused = await t.get(
        `/translations/status?filter[module]=${encodeURIComponent(value)}`,
      );
      expect([value.slice(0, 20), refused.status]).toEqual([
        value.slice(0, 20),
        400,
      ]);
      expect(ErrorDocument.parse(refused.body).errors[0]?.source).toEqual({
        parameter: 'filter[module]',
      });
    }
  });

  it('never counts modules or languages outside the reader’s scope', async () => {
    t.actAs(manager({ languages: ['en', 'de'], maxAudience: 'public' }));
    const res = await t.get('/translations/status?filter[kind]=module');
    expect(rows(res.body)).toEqual([
      'de/charging outdated 1/2',
      'de/safety-note missing 2/2',
    ]);
    expect(TranslationStatusPageDocument.parse(res.body).meta.page.total).toBe(
      2,
    );
    t.actAs(manager({ languages: ['de'] }));
    // Without the source language, no module; the project labels are read in every language,
    // as a page design's text is, and a manual's own text where it is read in German (#731).
    expect(rows((await t.get('/translations/status')).body)).toEqual([
      'de/config/project missing 12/12',
      'fr/config/project missing 12/12',
      'de/manuals/operating missing 1/1',
      'de/manuals/service missing 2/2',
    ]);
  });

  it('shows the blocks at a provider', async () => {
    jobs.units = [{ lang: 'de', moduleId: 'charging', blockId: 'intro' }];
    t.actAs(manager());
    expect(
      rows(
        (await t.get('/translations/status?filter[state]=at-provider')).body,
      ),
    ).toEqual(['de/charging at-provider 0/2']);
  });

  it('needs translation.manage or content.read.draft, and refuses unknown parameters', async () => {
    t.actAs(as(['content.read']));
    const refused = await t.get('/translations/status');
    expect(refused.status).toBe(403);
    expect(ErrorDocument.parse(refused.body).errors[0]?.code).toBe('forbidden');
    t.actAs(as(['content.read', 'content.read.draft']));
    expect((await t.get('/translations/status')).status).toBe(200);
    t.actAs(manager());
    for (const query of [
      'filter[state]=stale',
      'filter[folder]=a/b/c',
      'filter[lang]=not a tag',
      'filter[nope]=1',
    ]) {
      const res = await t.get(`/translations/status?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });
});

describe('GET /translations/status/:lang/:moduleId', () => {
  it('lists the blocks with their state', async () => {
    t.actAs(manager());
    const res = await t.get('/translations/status/de/charging');
    expect(res.status).toBe(200);
    expect(TranslationStatusDocument.parse(res.body).data.meta.blocks).toEqual([
      { blockId: 'intro', state: 'outdated' },
      { blockId: 'photo', state: 'up-to-date' },
    ]);
  });

  it('is not found outside the target languages and the reader’s scope', async () => {
    t.actAs(manager({ languages: ['en', 'de'], maxAudience: 'public' }));
    for (const path of [
      '/translations/status/en/charging',
      '/translations/status/fr/charging',
      '/translations/status/de/internals',
      '/translations/status/de/nope',
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('not-found');
    }
  });
});

describe('a source edit', () => {
  it('makes exactly the edited block outdated, in every language with a record, and warns in the checks', async () => {
    const writer = new GitWriter(dir());
    const main = git('rev-parse', 'refs/heads/main');
    // On a branch of its own, so `main` stays as the other tests read it.
    const branch = 'translation-edits';
    await writer.createBranch(branch, main);
    const source = parseModule(git('show', 'main:modules/en/charging.adoc'), {
      id: 'charging',
    });
    const french = {
      ...source,
      meta: { ...source.meta, lang: 'fr', title: 'Charge' },
    };
    // A French translation made from the current text, then a reformatting
    // (the same canonical module) and an edit of the image's alt text.
    const translated = await writer.commit({
      branch,
      parent: main,
      changes: [
        { path: 'modules/fr/charging.adoc', content: printModule(french) },
        {
          path: 'modules/fr/charging.translation.yaml',
          content: printTranslationRecord(translationRecordOf(source, main)),
        },
      ],
      message: 'Translate into French',
      author: { name: 'Test', email: 'test@example.com' },
    });
    // Reads the branch's commits: drafts.
    t.actAs(as(['content.read', 'content.read.draft', 'translation.manage']));
    const before = rows(
      (
        await t.get(
          `/translations/status?ref=${translated.commit}&filter[q]=charging`,
        )
      ).body,
    );
    expect(before).toEqual([
      'de/charging outdated 1/2',
      'fr/charging up-to-date 0/2',
    ]);
    const reformatted = await writer.commit({
      branch,
      parent: translated.commit,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          // Extra blank lines the canonical printer does not write.
          content: printModule(source).replace(/\n\n/g, '\n\n\n'),
        },
      ],
      message: 'Reformat',
      author: { name: 'Test', email: 'test@example.com' },
    });
    expect(
      rows(
        (
          await t.get(
            `/translations/status?ref=${reformatted.commit}&filter[q]=charging`,
          )
        ).body,
      ),
    ).toEqual(before);
    const edited = await writer.commit({
      branch,
      parent: reformatted.commit,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule({
            ...source,
            blocks: source.blocks.map((b) =>
              b.type === 'image' ? { ...b, alt: 'The new charger' } : b,
            ),
          }),
        },
      ],
      message: 'Edit the alt text',
      author: { name: 'Test', email: 'test@example.com' },
    });
    const after = await t.get(
      `/translations/status/fr/charging?ref=${edited.commit}`,
    );
    expect(
      TranslationStatusDocument.parse(after.body).data.meta.blocks,
    ).toEqual([
      { blockId: 'intro', state: 'up-to-date' },
      { blockId: 'photo', state: 'outdated' },
    ]);
    expect(
      rows(
        (
          await t.get(
            `/translations/status?ref=${edited.commit}&filter[q]=charging`,
          )
        ).body,
      ),
    ).toEqual(['de/charging outdated 2/2', 'fr/charging outdated 1/2']);
    const checks = CheckPageDocument.parse(
      (await t.get(`/manuals/operating/checks?ref=${edited.commit}`)).body,
    );
    expect(
      checks.data
        .filter((c) => c.attributes.code === 'outdated-translation')
        .map((c) => [
          c.id.length > 0,
          c.attributes.subject,
          c.attributes.params,
        ]),
    ).toEqual([
      [
        true,
        { type: 'module', lang: 'de', moduleId: 'charging' },
        { lang: 'de', blocks: '2' },
      ],
      [
        true,
        { type: 'module', lang: 'fr', moduleId: 'charging' },
        { lang: 'fr', blocks: '1' },
      ],
    ]);
  });
});

describe('a translation deleted (#287)', () => {
  const german = { type: 'module', lang: 'de', moduleId: 'charging' };
  const translator = {
    ...as([
      'content.read',
      'content.read.draft',
      'content.edit',
      'translation.manage',
    ]),
    id: 'sample-translator',
  };
  // Another change set's lock on the module would hold the next test's.
  afterEach(async () => {
    await t.database.db.execute(sql`delete from working_copies`);
    await t.database.db.execute(sql`delete from locks`);
  });
  const files = (ref: string) =>
    git('ls-tree', '--name-only', ref, 'modules/de/').split('\n');
  const blocks = async (ref?: string) => {
    const res = await t.get(
      `/translations/status/de/charging${ref ? `?ref=${ref}` : ''}`,
    );
    expect(res.status).toBe(200);
    return TranslationStatusDocument.parse(res.body).data.meta.blocks;
  };

  /** A change set of the translator's that deleted the German version. */
  async function deleted(): Promise<{
    id: string;
    branch: string;
    commit: string;
  }> {
    t.actAs(translator);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Translate again' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    await lock(id);
    const res = await t.post(`/change-sets/${id}/commits`).send(
      JSON.stringify({
        data: {
          type: 'Commit',
          attributes: { subjects: [], deletes: [german] },
        },
      }),
    );
    expect(res.status).toBe(201);
    return {
      id,
      branch: attributes.branch,
      commit: CommitDocument.parse(res.body).data.id,
    };
  }

  async function lock(id: string) {
    const res = await t.post(`/change-sets/${id}/locks`).send(
      JSON.stringify({
        data: { type: 'Lock', attributes: { subject: german } },
      }),
    );
    expect(res.status).toBe(201);
  }

  it('takes its record along, so one started again is outdated in every block', async () => {
    t.actAs(translator);
    // On main, the German record has the image up to date.
    expect(await blocks()).toContainEqual({
      blockId: 'photo',
      state: 'up-to-date',
    });
    const cs = await deleted();
    expect(files(cs.branch)).not.toContain('modules/de/charging.adoc');
    expect(files(cs.branch)).not.toContain(
      'modules/de/charging.translation.yaml',
    );

    // Translate: a working copy copying the source's blocks, committed.
    const source = parseModule(git('show', 'main:modules/en/charging.adoc'), {
      id: 'charging',
    });
    const saved = await t
      .put(`/change-sets/${cs.id}/modules/de/charging/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: { ...source, meta: { ...source.meta, lang: 'de' } },
            },
          },
          meta: { version: 0, baseCommit: cs.commit },
        }),
      );
    expect(saved.status).toBe(200);
    const committed = await t.post(`/change-sets/${cs.id}/commits`);
    expect(committed.status).toBe(201);
    expect(files(cs.branch)).toContain('modules/de/charging.adoc');
    expect(files(cs.branch)).not.toContain(
      'modules/de/charging.translation.yaml',
    );

    const status = await t.get(
      `/translations/status/de/charging?ref=${cs.branch}`,
    );
    const doc = TranslationStatusDocument.parse(status.body).data;
    expect(doc.attributes.state).toBe('outdated');
    expect(doc.meta.blocks).toEqual([
      { blockId: 'intro', state: 'outdated' },
      { blockId: 'photo', state: 'outdated' },
    ]);
  });

  it('puts its record back when the delete is taken out again', async () => {
    // The change set still holds the lock it deleted under.
    const cs = await deleted();
    const res = await t.post(`/change-sets/${cs.id}/reverts`).send(
      JSON.stringify({
        data: { type: 'Revert', attributes: { subjects: [german] } },
      }),
    );
    expect(res.status).toBe(200);
    expect(
      git('show', `${cs.branch}:modules/de/charging.translation.yaml`),
    ).toBe(git('show', 'main:modules/de/charging.translation.yaml'));
    expect(await blocks(cs.branch)).toEqual(await blocks());
  });
});
