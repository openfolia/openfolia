import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  ManualComparisonDocument,
  ManualVersionPageDocument,
} from '../src/manuals/api/manual-history.resources.js';
import {
  ManualDocument,
  ManualPageDocument,
} from '../src/manuals/api/manual.resources.js';
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
/** Reads only public content, drafts too. */
const publicReader = user('public-reader', READS, { maxAudience: 'public' });

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

/** A manifest of `guide` naming these modules. */
const guide = (title: string, ...modules: string[]) => `schemaVersion: 1
title: ${title}
audience: public
variants:
  - model: small
entries:
${modules.map((m) => `  - module: ${m}`).join('\n')}
`;

/**
 * A change set by `author` whose branch writes (or deletes) `files`, made
 * outside the API, reviewed and merged into `main` through the API.
 */
async function merged(
  title: string,
  files: ({ path: string; content: string } | { path: string; delete: true })[],
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

const PATH = 'manuals/guide.yaml';
let cs: { id: string; merge: string }[];

beforeAll(async () => {
  t = await createTestApp();
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
  const first = await merged('Add the guide', [
    { path: PATH, content: guide('Guide', 'charging') },
  ]);
  git('tag', '-a', 'release-g', '-m', 'Guide', first.merge);
  const second = await merged('Guide, longer', [
    { path: PATH, content: guide('Guide', 'charging', 'safety') },
  ]);
  // Deleted: the internal service manual, and later the guide.
  const service = await merged('Drop the service manual', [
    { path: 'manuals/service.yaml', delete: true },
  ]);
  const dropped = await merged('Drop the guide', [
    { path: PATH, delete: true },
  ]);
  cs = [first, second, service, dropped];
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('GET /manuals/:id/history', () => {
  it('lists the versions with who, change set, approvers, revisions and releases; the newest the removal', async () => {
    const [first, second, , dropped] = cs as [
      { id: string; merge: string },
      { id: string; merge: string },
      { id: string; merge: string },
      { id: string; merge: string },
    ];
    t.actAs(reviewer);
    const res = await t.get('/manuals/guide/history');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    const doc = ManualVersionPageDocument.parse(res.body);
    expect(doc.meta).toMatchObject({ page: { total: 3 }, truncated: false });
    expect(
      doc.data.map((v) => [
        v.attributes.commit,
        v.meta.revision,
        v.meta.change,
      ]),
    ).toEqual([
      [dropped.merge, 3, 'removed'],
      [second.merge, 2, 'changed'],
      [first.merge, 1, 'added'],
    ]);
    expect(doc.data[1]).toEqual({
      type: 'ManualVersion',
      id: `guide/${second.merge}`,
      attributes: {
        commit: second.merge,
        committedAt: expect.any(String),
        message: `Guide, longer\n\nMerge change set ${second.id}.`,
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
        releases: [],
        unreadable: false,
        // A reader of drafts reads each version at its own commit.
        readAt: second.merge,
      },
    });
    expect(doc.data[2]?.meta.releases).toEqual([
      { tag: 'release-g', commit: first.merge },
    ]);
  });

  it('pages the versions', async () => {
    t.actAs(reviewer);
    const res = await t.get(
      '/manuals/guide/history?page[number]=2&page[size]=2',
    );
    expect(res.status).toBe(200);
    const doc = ManualVersionPageDocument.parse(res.body);
    expect(doc.data.map((v) => v.meta.revision)).toEqual([1]);
    expect(doc.links.prev).toContain('page%5Bnumber%5D=1');
  });

  it('is 404 for a manual that does not exist, or whose last manifest lies outside the reader’s scope', async () => {
    t.actAs(consumer);
    const missing = await t.get('/manuals/nothing/history');
    expect(missing.status).toBe(404);
    expect(errors(missing.body)[0]?.code).toBe('not-found');
    // The service manual is internal: a public reader never learns of it.
    t.actAs(publicReader);
    const hidden = await t.get('/manuals/service/history');
    expect(hidden.status).toBe(404);
    expect(errors(hidden.body)[0]?.detail).toBe('No manual "service".');
    t.actAs(reviewer);
    expect((await t.get('/manuals/service/history')).status).toBe(200);
  });
});

describe('a reader of released content only (#410)', () => {
  it('is listed only the versions released content holds, to be read at a released commit', async () => {
    const [first] = cs as { id: string; merge: string }[];
    t.actAs(consumer);
    const res = await t.get('/manuals/guide/history');
    expect(res.status).toBe(200);
    const doc = ManualVersionPageDocument.parse(res.body);
    // The second version was never released; the removal holds nothing.
    expect(doc.meta.page.total).toBe(1);
    expect(
      doc.data.map((v) => [
        v.attributes.commit,
        v.meta.revision,
        v.meta.readAt,
      ]),
    ).toEqual([[first?.merge, 1, first?.merge]]);
    const compared = await t.get(
      `/manuals/guide/compare?base=${doc.data[0]?.meta.readAt}&head=main`,
    );
    expect(compared.status).toBe(200);
    expect(ManualComparisonDocument.parse(compared.body).data.meta.change).toBe(
      'removed',
    );
  });

  it('is listed only the deleted manuals whose last manifest released content holds', async () => {
    t.actAs(consumer);
    const res = await t.get('/manuals?filter[status]=deleted');
    expect(res.status).toBe(200);
    const doc = ManualPageDocument.parse(res.body);
    // The guide's last manifest (its second version) was never released;
    // the service manual's is the one the release holds.
    expect(doc.data.map((m) => m.id)).toEqual(['service']);
    expect(doc.meta.page.total).toBe(1);
    // It depends on the releases too: never cached as the commit's alone.
    expect(res.headers['cache-control']).toBe('private, no-cache');
    t.actAs(reviewer);
    const all = ManualPageDocument.parse(
      (await t.get('/manuals?filter[status]=deleted')).body,
    );
    expect(all.data.map((m) => m.id)).toEqual(['guide', 'service']);
  });
});

describe('GET /manuals/:id/compare', () => {
  it('gives both versions and the members that differ', async () => {
    const [first, second] = cs as { id: string; merge: string }[];
    t.actAs(reviewer);
    const res = await t.get(
      `/manuals/guide/compare?base=${first?.merge}&head=${second?.merge}`,
    );
    expect(res.status).toBe(200);
    const doc = ManualComparisonDocument.parse(res.body);
    expect(doc.data.meta).toMatchObject({
      base: first?.merge,
      head: second?.merge,
      change: 'changed',
      fields: ['entries'],
      unreadable: false,
    });
    expect(doc.data.attributes.base?.entries).toEqual([{ module: 'charging' }]);
    expect(doc.data.attributes.head?.entries).toHaveLength(2);
  });

  it('needs content.read.draft for an older commit, and both sides once each', async () => {
    // The second merge: an older commit of main, released by no tag.
    const [, second] = cs as { id: string; merge: string }[];
    t.actAs(consumer);
    const refused = await t.get(
      `/manuals/guide/compare?base=${second?.merge}&head=main`,
    );
    expect(refused.status).toBe(404);
    const released = await t.get(
      '/manuals/guide/compare?base=release-g&head=main',
    );
    expect(released.status).toBe(200);
    expect(ManualComparisonDocument.parse(released.body).data.meta.change).toBe(
      'removed',
    );
    const missing = await t.get('/manuals/guide/compare?base=v1');
    expect(missing.status).toBe(400);
    expect(errors(missing.body)[0]).toMatchObject({
      code: 'invalid-parameter',
      source: { parameter: 'head' },
    });
    const neither = await t.get('/manuals/nothing/compare?base=v1&head=main');
    expect(neither.status).toBe(404);
  });
});

describe('GET /manuals?filter[status]', () => {
  it('lists the deleted manuals from their last manifests, within the reader’s scope', async () => {
    const dropped = cs[3] as { merge: string };
    t.actAs(reviewer);
    const res = await t.get('/manuals?filter[status]=deleted');
    expect(res.status).toBe(200);
    const doc = ManualPageDocument.parse(res.body);
    expect(doc.data.map((m) => m.id)).toEqual(['guide', 'service']);
    expect(doc.data[0]).toMatchObject({
      attributes: { title: 'Guide' },
      meta: { deleted: { commit: dropped.merge } },
    });
    t.actAs(publicReader);
    const scoped = ManualPageDocument.parse(
      (await t.get('/manuals?filter[status]=deleted')).body,
    );
    expect(scoped.data.map((m) => m.id)).toEqual(['guide']);
    expect(scoped.meta.page.total).toBe(1);
    const any = ManualPageDocument.parse(
      (await t.get('/manuals?filter[status]=any')).body,
    );
    expect(any.data.map((m) => m.id)).toEqual(['guide', 'operating']);
    // The default: only the manuals there.
    const current = ManualPageDocument.parse((await t.get('/manuals')).body);
    expect(current.data.map((m) => m.id)).toEqual(['operating']);
    const bad = await t.get('/manuals?filter[status]=gone');
    expect(bad.status).toBe(400);
  });

  it('restores a deleted manual’s version into a working copy, as an edit', async () => {
    const [, second] = cs as { id: string; merge: string }[];
    t.actAs(author);
    const old = ManualDocument.parse(
      (await t.get(`/manuals/guide?ref=${second?.merge}`)).body,
    ).data.attributes;
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Bring it back' } },
      }),
    );
    const set = ChangeSetDocument.parse(created.body).data;
    const lock = await t.post(`/change-sets/${set.id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'manual', manualId: 'guide' } },
        },
      }),
    );
    expect(lock.status).toBe(201);
    const { textAttributes, ...rest } = old;
    const saved = await t
      .put(`/change-sets/${set.id}/manuals/guide/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: { ...rest, id: 'guide', attributes: textAttributes },
            },
          },
          meta: { version: 0, baseCommit: set.attributes.baseCommit },
        }),
      );
    expect(saved.status).toBe(200);
    const discarded = await t
      .delete(`/change-sets/${set.id}/manuals/guide/working-copy`)
      .send('');
    expect(discarded.status).toBe(204);
  });
});
