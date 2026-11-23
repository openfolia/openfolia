import { execFileSync } from 'node:child_process';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import {
  ModuleDocument,
  ModulePageDocument,
} from '../src/modules/api/module.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const author = user('sample-author', ['content.read', 'content.edit']);
const otherAuthor = user('other-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
  'content.review',
]);
/** A consumer of released content: `content.read` alone. */
const consumer = user('sample-consumer', ['content.read']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const charging = (): Module =>
  parseModule(git('show', 'main:modules/en/charging.adoc'), { id: 'charging' });

/**
 * A change set by `author` with one commit on its branch, made outside
 * the API: `charging` with its intro edited and a block added, and a new
 * module.
 */
async function changeSet(): Promise<{ id: string; head: string }> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Clearer charging' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  const before = charging();
  const edited: Module = {
    ...before,
    blocks: [
      {
        type: 'paragraph',
        id: 'intro',
        content: [{ type: 'text', text: 'Plug it in.' }],
      },
      ...before.blocks.slice(1),
      {
        type: 'paragraph',
        id: 'after-care',
        content: [{ type: 'text', text: 'Unplug it.' }],
      },
    ],
  };
  const fresh: Module = {
    ...before,
    id: 'storage',
    meta: { ...before.meta, title: 'Storage' },
    blocks: [
      {
        type: 'paragraph',
        id: 'cool',
        content: [{ type: 'text', text: 'Keep it cool.' }],
      },
    ],
  };
  const { commit } = await new GitWriter(dir()).commit({
    branch: attributes.branch,
    parent: git('rev-parse', `refs/heads/${attributes.branch}`),
    changes: [
      { path: 'modules/en/charging.adoc', content: printModule(edited) },
      { path: 'modules/en/storage.adoc', content: printModule(fresh) },
    ],
    message: 'Clearer charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return { id, head: commit };
}

describe('GET /change-sets/:changeSetId/changes', () => {
  it('lists the changed modules with their blocks by ID, paged', async () => {
    const { id, head } = await changeSet();
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${id}/changes`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    const doc = ChangeSetChangePageDocument.parse(res.body);
    expect(doc.meta).toMatchObject({
      base: git('rev-parse', 'refs/heads/main'),
      head,
      page: { total: 2 },
    });
    expect(doc.data).toEqual([
      {
        type: 'ChangeSetChange',
        id: 'module/en/charging',
        attributes: {
          subject: { type: 'module', lang: 'en', moduleId: 'charging' },
        },
        relationships: { changeSet: { data: { type: 'ChangeSet', id } } },
        meta: {
          change: 'changed',
          fields: [],
          // The unchanged blocks keep their IDs and are not listed.
          blocks: [
            { blockId: 'intro', change: 'changed' },
            { blockId: 'after-care', change: 'added' },
          ],
          unreadable: false,
        },
      },
      expect.objectContaining({
        id: 'module/en/storage',
        meta: { change: 'added', fields: [], blocks: [], unreadable: false },
      }),
    ]);

    const page = await t.get(`/change-sets/${id}/changes?page[size]=1`);
    const paged = ChangeSetChangePageDocument.parse(page.body);
    expect(paged.data.map((c) => c.id)).toEqual(['module/en/charging']);
    expect(paged.meta.page).toMatchObject({ total: 2, lastPage: 2 });
    expect(paged.links.next).toContain('page%5Bnumber%5D=2');
  });

  it('shows an author their own change set, and nobody else’s', async () => {
    const { id } = await changeSet();
    t.actAs(author);
    const own = await t.get(`/change-sets/${id}/changes`);
    expect(own.status).toBe(200);
    expect(ChangeSetChangePageDocument.parse(own.body).meta.page.total).toBe(2);
    t.actAs(otherAuthor);
    const other = await t.get(`/change-sets/${id}/changes`);
    expect(other.status).toBe(404);
    expect(ErrorDocument.parse(other.body).errors[0]?.code).toBe('not-found');
  });

  it('refuses a parameter it does not take', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${id}/changes?filter[lang]=en`);
    expect(res.status).toBe(400);
  });
});

describe('module meta.status', () => {
  it('shows a released module that has an open change set as both', async () => {
    const { id } = await changeSet();
    const main = git('rev-parse', 'refs/heads/main');
    t.actAs(reviewer);
    let res = await t.get('/modules/en/charging');
    expect(res.status).toBe(200);
    let status = ModuleDocument.parse(res.body).data.meta.status;
    // v1 holds an older text: released, but not as on main.
    expect(status.release).toEqual({
      tag: 'v1',
      commit: t.commits.v1,
      same: false,
    });
    expect(status.main).toEqual({ commit: main, same: true });
    expect(status.changeSets).toContainEqual({ id, state: 'draft' });

    git('tag', '-a', 'v2', '-m', 'release 2', main);
    try {
      res = await t.get('/modules/en/charging');
      status = ModuleDocument.parse(res.body).data.meta.status;
      expect(status.release).toMatchObject({ tag: 'v2', same: true });
      expect(status.changeSets).toContainEqual({ id, state: 'draft' });

      // The list says the same for each module on its page.
      const list = ModulePageDocument.parse(
        (await t.get('/modules?filter[lang]=en')).body,
      );
      const listed = list.data.find((m) => m.id === 'en/charging');
      expect(listed && 'status' in listed.meta && listed.meta.status).toEqual(
        status,
      );
    } finally {
      git('tag', '-d', 'v2');
    }
  });

  it('revalidates a status, never caching it as immutable', async () => {
    t.actAs(reviewer);
    const first = await t.get(`/modules/en/charging?ref=${t.commits.main}`);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    const etag = first.headers['etag'] ?? '';
    expect(
      (
        await t
          .get(`/modules/en/charging?ref=${t.commits.main}`)
          .set('If-None-Match', etag)
      ).status,
    ).toBe(304);
    // A new change set changes the status at the same commit: no 304.
    await changeSet();
    t.actAs(reviewer);
    const after = await t
      .get(`/modules/en/charging?ref=${t.commits.main}`)
      .set('If-None-Match', etag);
    expect(after.status).toBe(200);
    expect(after.headers['etag']).not.toBe(etag);
  });

  it('tells a consumer of released content nothing of change sets', async () => {
    await changeSet();
    t.actAs(consumer);
    const res = await t.get('/modules/en/charging');
    const { status } = ModuleDocument.parse(res.body).data.meta;
    expect(status.main).toMatchObject({ same: true });
    expect(status).not.toHaveProperty('changeSets');
  });

  it('names a change set to its author and not to another author', async () => {
    const { id } = await changeSet();
    t.actAs(author);
    const own = ModuleDocument.parse((await t.get('/modules/en/charging')).body)
      .data.meta.status;
    expect(own.changeSets).toContainEqual({ id, state: 'draft' });
    t.actAs(otherAuthor);
    const other = ModuleDocument.parse(
      (await t.get('/modules/en/charging')).body,
    ).data.meta.status;
    expect(other.changeSets?.map((c) => c.id)).not.toContain(id);
  });
});
