import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleVersionPageDocument } from '../src/modules/api/module-history.resources.js';
import { ModuleSummaryPageDocument } from '../src/modules/api/module-summary.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const author = user('sample-author', [...READS, 'content.edit']);
const reviewer = user('sample-reviewer', [...READS, 'content.review']);
const publisher = user('sample-publisher', [...READS, 'release.publish']);
/** Reads only public released content. */
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});
/** A consumer of released content: `content.read` alone (#418). */
const consumer = user('sample-consumer', ['content.read']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

/**
 * A change set by `author` whose branch deletes `paths` (committed outside the API), reviewed
 * and merged into `main` through the API. The merge commit.
 */
function mergedDeletion(title: string, paths: string[]): Promise<string> {
  return mergedChange(
    title,
    paths.map((path) => ({ path, delete: true as const })),
  );
}

/** As `mergedDeletion`, with any changes. */
async function mergedChange(
  title: string,
  changes: (
    { path: string; content: string } | { path: string; delete: true }
  )[],
): Promise<string> {
  t.actAs(author);
  const created = await t
    .post('/change-sets')
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
    );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  await new GitWriter(dir()).commit({
    branch: attributes.branch,
    parent: git('rev-parse', `refs/heads/${attributes.branch}`),
    changes,
    message: title,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  for (const [actor, step] of [
    [author, 'submit'],
    [reviewer, 'approve'],
    [publisher, 'merge'],
  ] as const) {
    t.actAs(actor);
    const res = await t.post(`/change-sets/${id}/${step}`).send('');
    expect(res.status).toBe(200);
  }
  return git('rev-parse', 'refs/heads/main');
}

let merge: string;

beforeAll(async () => {
  t = await createTestApp();
  // The approver and the merger are users the directory knows (an approval needs its role).
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [reviewer, publisher].flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: `${a.id}-${r.id}` })),
      ),
      users: [reviewer, publisher].map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => `${a.id}-${r.id}`),
      })),
    }),
  );
  // `safety-note` is public, `internals` internal; both exist in English only. Released (#418):
  // their last versions are what this tag holds.
  git('tag', '-a', 'release-before-deletion', '-m', 'Before', 'main');
  merge = await mergedDeletion('Drop two modules', [
    'modules/en/safety-note.adoc',
    'modules/en/internals.adoc',
  ]);
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('GET /module-summaries?filter[status]=deleted (#320)', () => {
  it('lists the modules a merged change set deleted, from their last versions', async () => {
    t.actAs(author);
    const res = await t.get(
      '/module-summaries?filter[status]=deleted&page[size]=10',
    );
    expect(res.status).toBe(200);
    const doc = ModuleSummaryPageDocument.parse(res.body);
    expect(doc.meta.page.total).toBe(2);
    expect(
      doc.data.map((s) => [s.id, s.attributes.languages, s.meta.deleted]),
    ).toEqual([
      ['internals', ['en'], { commit: merge, committedAt: expect.any(String) }],
      [
        'safety-note',
        ['en'],
        { commit: merge, committedAt: expect.any(String) },
      ],
    ]);
    const note = doc.data.find((s) => s.id === 'safety-note');
    expect(note?.attributes.title).toBe(
      git('show', `${merge}^:modules/en/safety-note.adoc`).match(
        /^= (.+)$/m,
      )?.[1],
    );
    // Deleted on `main` itself: no change from the released branch.
    expect(note?.meta.changed).toBe(false);
  });

  it('opens the history of a deleted module, its newest version the deletion', async () => {
    t.actAs(author);
    const res = await t.get('/modules/en/safety-note/history');
    expect(res.status).toBe(200);
    const [newest] = ModuleVersionPageDocument.parse(res.body).data;
    expect(newest?.attributes).toMatchObject({ commit: merge });
    expect(newest?.meta).toMatchObject({ change: 'removed' });
  });

  it('lists the modules there and those deleted in one list with `any`, and none by default', async () => {
    t.actAs(author);
    const all = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?filter[status]=any&page[size]=100')).body,
    );
    const current = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?page[size]=100')).body,
    );
    expect(current.data.some((s) => s.meta.deleted)).toBe(false);
    expect(current.data.map((s) => s.id)).not.toContain('safety-note');
    expect(all.meta.page.total).toBe(current.meta.page.total + 2);
    const titles = all.data.map((s) => s.attributes.title);
    expect(titles).toEqual(
      [...titles].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    );
  });

  it('never lists or counts a deleted module outside the reader’s scope', async () => {
    t.actAs(publicReader);
    const res = await t.get(
      '/module-summaries?filter[status]=deleted&filter[q]=intern',
    );
    expect(res.status).toBe(200);
    const doc = ModuleSummaryPageDocument.parse(res.body);
    expect(doc.data).toEqual([]);
    expect(doc.meta.page.total).toBe(0);
    const all = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?filter[status]=deleted')).body,
    );
    expect(all.data.map((s) => s.id)).toEqual(['safety-note']);
    expect(all.meta.page.total).toBe(1);
    expect(JSON.stringify(all)).not.toContain('internals');
    // Nor its history.
    expect((await t.get('/modules/en/internals/history')).status).toBe(404);
  });

  it('refuses an unknown status', async () => {
    t.actAs(author);
    const res = await t.get('/module-summaries?filter[status]=gone');
    expect(res.status).toBe(400);
    expect(errors(res.body)[0]?.source).toMatchObject({
      parameter: 'filter[status]',
    });
  });
});

describe('deleted modules to a reader without draft access (#418)', () => {
  const SECRET = 'Never released, and gone.';
  let dropped: string;

  beforeAll(async () => {
    // A module added and deleted again on `main`: its last version was never released (the
    // commit between the merges is no longer `main`'s head, and no tag holds it).
    const note = git('show', `${merge}^:modules/en/safety-note.adoc`)
      .replace(/^= .+$/m, '= Drafted note')
      .replace('Let it cool down.', SECRET);
    await mergedChange('Add a drafted note', [
      { path: 'modules/en/drafted-note.adoc', content: `${note}\n` },
    ]);
    dropped = await mergedDeletion('Drop the drafted note', [
      'modules/en/drafted-note.adoc',
    ]);
  });

  it('lists to a consumer only the deleted modules released content holds, from the released file', async () => {
    t.actAs(consumer);
    const res = await t.get(
      '/module-summaries?filter[status]=deleted&page[size]=10',
    );
    expect(res.status).toBe(200);
    const doc = ModuleSummaryPageDocument.parse(res.body);
    expect(doc.data.map((s) => s.id)).toEqual(['internals', 'safety-note']);
    expect(doc.meta.page.total).toBe(2);
    const note = doc.data.find((s) => s.id === 'safety-note');
    expect(note?.attributes.title).toBe('Safety note');
    expect(note?.meta.text).toBe('Hot surface Let it cool down.');
    expect(JSON.stringify(res.body)).not.toContain('drafted-note');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // Nor found by its unreleased title.
    const found = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?filter[status]=any&filter[q]=drafted'))
        .body,
    );
    expect(found.meta.page.total).toBe(0);
    // It depends on the releases too: never cached as the commit's alone.
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('lists every deleted module to a reader of drafts, from its last version', async () => {
    t.actAs(reviewer);
    const res = await t.get(
      '/module-summaries?filter[status]=deleted&page[size]=10',
    );
    expect(res.status).toBe(200);
    const doc = ModuleSummaryPageDocument.parse(res.body);
    expect(doc.data.map((s) => [s.id, s.meta.deleted?.commit])).toEqual([
      ['drafted-note', dropped],
      ['internals', merge],
      ['safety-note', merge],
    ]);
    expect(doc.data[0]?.meta.text).toBe(`Hot surface ${SECRET}`);
  });
});
