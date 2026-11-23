import { execFileSync } from 'node:child_process';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import {
  ModuleComparisonDocument,
  ModuleVersionPageDocument,
} from '../src/modules/api/module-history.resources.js';
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
/** A consumer of released content: `content.read` alone. */
const consumer = user('sample-consumer', ['content.read']);
/** Reads only public content. */
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

/** `storage`, made from `charging`, with paragraphs of these IDs and texts. */
function storage(...blocks: [string, string][]): Module {
  const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  return {
    ...charging,
    id: 'storage',
    meta: { ...charging.meta, title: 'Storage' },
    blocks: blocks.map(([id, text]) => ({
      type: 'paragraph',
      id,
      content: [{ type: 'text', text }],
    })),
  };
}

/**
 * A change set by `author` whose branch writes `files` (made outside the
 * API, as in the changes test), reviewed and merged into `main` through
 * the API. Its ID and the merge commit.
 */
async function merged(
  title: string,
  files: { path: string; content: string }[],
): Promise<{ id: string; merge: string }> {
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
    changes: files,
    message: title,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  const step = async (actor: Actor, name: string) => {
    t.actAs(actor);
    const res = await t.post(`/change-sets/${id}/${name}`).send('');
    expect(res.status).toBe(200);
  };
  await step(author, 'submit');
  await step(reviewer, 'approve');
  await step(publisher, 'merge');
  return { id, merge: git('rev-parse', 'refs/heads/main') };
}

const storageFile = (module: Module) => ({
  path: 'modules/en/storage.adoc',
  content: printModule(module),
});

let cs: { id: string; merge: string }[];
let unrelated: { id: string; merge: string };

beforeAll(async () => {
  t = await createTestApp();
  // Known users: the reviewer and the publisher.
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
  const first = await merged('Add storage', [
    storageFile(storage(['intro', 'Keep it dry.'])),
  ]);
  // Only another file: no version of storage.
  unrelated = await merged('Clearer charging', [
    {
      path: 'modules/en/charging.adoc',
      content: git('show', 'main:modules/en/charging.adoc').replace(
        'charges automatically',
        'charges by itself',
      ),
    },
  ]);
  const second = await merged('Cooler storage', [
    storageFile(storage(['intro', 'Keep it cool.'])),
  ]);
  git('tag', '-a', 'release-2', '-m', 'Release 2', second.merge);
  const third = await merged('Storage tips', [
    storageFile(storage(['intro', 'Keep it cool.'], ['tips', 'Stack it.'])),
  ]);
  cs = [first, second, third];
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('GET /modules/:lang/:id/history', () => {
  it('lists the merged changes newest first with who, change set, approvers, revisions and releases', async () => {
    t.actAs(consumer);
    const res = await t.get('/modules/en/storage/history');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    const doc = ModuleVersionPageDocument.parse(res.body);
    expect(doc.meta).toMatchObject({ page: { total: 3 }, truncated: false });
    const [first, second, third] = cs as { id: string; merge: string }[] as [
      { id: string; merge: string },
      { id: string; merge: string },
      { id: string; merge: string },
    ];
    expect(doc.data.map((v) => [v.attributes.commit, v.meta.revision])).toEqual(
      [
        [third.merge, 3],
        [second.merge, 2],
        [first.merge, 1],
      ],
    );
    expect(doc.data[1]).toEqual({
      type: 'ModuleVersion',
      id: `en/storage/${second.merge}`,
      attributes: {
        commit: second.merge,
        committedAt: expect.any(String),
        message: `Cooler storage\n\nMerge change set ${second.id}.`,
        merge: true,
        actor: { kind: 'user', id: 'sample-publisher' },
        approvedBy: [{ kind: 'user', id: 'sample-reviewer' }],
      },
      relationships: {
        actor: { data: { type: 'User', id: 'sample-publisher' } },
        changeSet: { data: { type: 'ChangeSet', id: second.id } },
        approvers: { data: [{ type: 'User', id: 'sample-reviewer' }] },
      },
      meta: {
        revision: 2,
        change: 'changed',
        releases: [{ tag: 'release-2', commit: second.merge }],
        unreadable: false,
      },
    });
    expect(doc.data[2]?.meta).toMatchObject({ change: 'added', releases: [] });
    // The merge that changed only charging is not a version of storage.
    expect(doc.data.map((v) => v.attributes.commit)).not.toContain(
      unrelated.merge,
    );
    // Its history lists that merge, and the sample's own two commits.
    const charging = ModuleVersionPageDocument.parse(
      (await t.get('/modules/en/charging/history')).body,
    );
    expect(charging.data.map((v) => v.attributes.commit)).toEqual([
      unrelated.merge,
      t.commits.main,
      t.commits.v1,
    ]);
    expect(charging.data[2]?.relationships.changeSet.data).toBeNull();
  });

  it('pages the versions', async () => {
    t.actAs(consumer);
    const res = await t.get(
      '/modules/en/storage/history?page[number]=2&page[size]=2',
    );
    expect(res.status).toBe(200);
    const doc = ModuleVersionPageDocument.parse(res.body);
    expect(doc.data.map((v) => v.meta.revision)).toEqual([1]);
    expect(doc.links.prev).toContain('page%5Bnumber%5D=1');
  });

  it('reads the history of an older commit only with content.read.draft', async () => {
    // The first merge: an older commit of main, released by no tag.
    const at = (cs[0] as { merge: string }).merge;
    t.actAs(consumer);
    const refused = await t.get(`/modules/en/storage/history?ref=${at}`);
    expect(refused.status).toBe(404);
    t.actAs(reviewer);
    const res = await t.get(`/modules/en/storage/history?ref=${at}`);
    expect(res.status).toBe(200);
    expect(
      ModuleVersionPageDocument.parse(res.body).data.map(
        (v) => v.meta.revision,
      ),
    ).toEqual([1]);
  });

  it('is 404 for a module that does not exist or lies outside the reader’s scope', async () => {
    t.actAs(consumer);
    const missing = await t.get('/modules/en/nothing/history');
    expect(missing.status).toBe(404);
    expect(errors(missing.body)[0]?.code).toBe('not-found');
    // `internals` is internal: outside a public reader's scope.
    t.actAs(publicReader);
    const hidden = await t.get('/modules/en/internals/history');
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({
      ...missing.body,
      errors: [
        {
          ...errors(missing.body)[0],
          detail: 'No module "internals" in "en".',
        },
      ],
    });
  });
});

describe('GET /modules/:lang/:id/compare', () => {
  it('gives both versions and the same blocks as the change sets’ diffs combined', async () => {
    const [first, second, third] = cs as { id: string; merge: string }[];
    t.actAs(reviewer);
    const res = await t.get(
      `/modules/en/storage/compare?base=${first?.merge}&head=${third?.merge}`,
    );
    expect(res.status).toBe(200);
    const doc = ModuleComparisonDocument.parse(res.body);
    expect(doc.data.meta).toMatchObject({
      base: first?.merge,
      head: third?.merge,
      change: 'changed',
      fields: [],
      unreadable: false,
    });
    expect(doc.data.attributes.base?.blocks).toEqual(
      storage(['intro', 'Keep it dry.']).blocks,
    );
    expect(doc.data.attributes.head?.title).toBe('Storage');
    const combined = new Map<string, string>();
    for (const changeSet of [second, third]) {
      const changes = ChangeSetChangePageDocument.parse(
        (await t.get(`/change-sets/${changeSet?.id}/changes`)).body,
      );
      for (const block of changes.data[0]?.meta.blocks ?? []) {
        combined.set(block.blockId, block.change);
      }
    }
    expect(doc.data.meta.blocks).toEqual(
      [...combined].map(([blockId, change]) => ({ blockId, change })),
    );
  });

  it('needs content.read.draft for an older commit of main, exactly as reading it does', async () => {
    const [first] = cs as { id: string; merge: string }[];
    const path = `/modules/en/storage/compare?base=${first?.merge}&head=main`;
    t.actAs(consumer);
    const refused = await t.get(path);
    expect(refused.status).toBe(404);
    const read = await t.get(`/modules/en/storage?ref=${first?.merge}`);
    expect(read.status).toBe(404);
    t.actAs(reviewer);
    const res = await t.get(path);
    expect(res.status).toBe(200);
    expect(ModuleComparisonDocument.parse(res.body).data.meta.change).toBe(
      'changed',
    );
    // Released on both sides: content.read is enough.
    t.actAs(consumer);
    const released = await t.get(
      '/modules/en/storage/compare?base=release-2&head=main',
    );
    expect(released.status).toBe(200);
    expect(
      ModuleComparisonDocument.parse(released.body).data.meta.blocks,
    ).toEqual([{ blockId: 'tips', change: 'added' }]);
  });

  it('is added where the base has no module, and 404 where neither has it', async () => {
    t.actAs(consumer);
    const added = await t.get('/modules/en/storage/compare?base=v1&head=main');
    expect(added.status).toBe(200);
    const doc = ModuleComparisonDocument.parse(added.body);
    expect(doc.data.meta.change).toBe('added');
    expect(doc.data.attributes.base).toBeNull();
    const neither = await t.get(
      '/modules/en/nothing/compare?base=v1&head=main',
    );
    expect(neither.status).toBe(404);
  });

  it('needs both sides, once each, and no other parameter', async () => {
    t.actAs(consumer);
    const missing = await t.get('/modules/en/storage/compare?base=v1');
    expect(missing.status).toBe(400);
    expect(errors(missing.body)[0]).toMatchObject({
      code: 'invalid-parameter',
      source: { parameter: 'head' },
    });
    const twice = await t.get(
      '/modules/en/storage/compare?base=v1&base=v1&head=main',
    );
    expect(twice.status).toBe(400);
    const ref = await t.get(
      '/modules/en/storage/compare?base=v1&head=main&ref=main',
    );
    expect(ref.status).toBe(400);
  });
});
