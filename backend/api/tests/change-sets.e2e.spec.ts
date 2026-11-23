import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import {
  ChangeSetDocument,
  ChangeSetPageDocument,
} from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetReconciler } from '../src/change-sets/api/change-set-reconciler.js';
import {
  ORPHAN_GRACE_MS,
  ReconcileChangeSetBranchesAction,
} from '../src/change-sets/core/actions/reconcile-change-set-branches.action.js';
import { newChangeSetId } from '../src/change-sets/core/change-set.js';
import { ChangeSetStore } from '../src/change-sets/core/change-set-store.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const otherAuthor: Actor = { ...author, id: 'sample-other' };
const reader = actorWith(['content.read', 'content.read.draft']);
const admin = actorWith(['admin.roles']);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const one = (body: unknown) => ChangeSetDocument.parse(body).data;
const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};
const create = (attributes: Record<string, unknown>) =>
  t
    .post('/change-sets')
    .send(JSON.stringify({ data: { type: 'ChangeSet', attributes } }));

describe('POST /change-sets', () => {
  it('starts a change set on its own branch, readable with ?ref=', async () => {
    t.actAs(author);
    const res = await create({
      title: 'Explain charging',
      description: 'For the new charger.',
    });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe(JSON_API);
    const changeSet = one(res.body);
    expect(res.headers['location']).toBe(`/change-sets/${changeSet.id}`);
    expect(changeSet).toEqual({
      type: 'ChangeSet',
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      attributes: {
        title: 'Explain charging',
        description: 'For the new charger.',
        state: 'draft',
        author: { kind: 'user', id: 'sample-author' },
        baseRef: 'main',
        baseCommit: t.commits.main,
        branch: `change-sets/${changeSet.id}`,
        reviewHead: null,
        mergeCommit: null,
        createdAt: expect.any(String),
        updatedAt: changeSet.attributes.createdAt,
      },
    });

    // The branch exists in Git, and reads work on it.
    t.actAs(reader);
    const refs = await t.get('/refs');
    expect(JSON.stringify(refs.body)).toContain(changeSet.attributes.branch);
    const modules = await t.get(
      `/modules?ref=${encodeURIComponent(changeSet.attributes.branch)}`,
    );
    expect(modules.status).toBe(200);
    expect(modules.headers['x-ccms-commit']).toBe(t.commits.main);

    // Audited.
    t.actAs(admin);
    const events = AuditEventPageDocument.parse(
      (await t.get(`/audit-events?filter[subject]=change-set/${changeSet.id}`))
        .body,
    ).data;
    expect(
      events.map((e) => [e.attributes.action, e.attributes.actor]),
    ).toEqual([['change-set.create', { kind: 'user', id: 'sample-author' }]]);
  });

  it('starts from another branch when asked, never a tag or a change set’s', async () => {
    t.actAs(author);
    const draft = one((await create({ title: 'x', baseRef: 'draft' })).body);
    expect(draft.attributes).toMatchObject({
      baseRef: 'draft',
      baseCommit: t.commits.draft,
    });
    for (const baseRef of [
      'v1',
      'nope',
      t.commits.main,
      draft.attributes.branch,
    ]) {
      const res = await create({ title: 'x', baseRef });
      expect([baseRef, res.status]).toEqual([baseRef, 422]);
      expect(only(res.body)?.code).toBe('invalid-base');
    }
  });

  it('hides a draft base from an editor without content.read.draft', async () => {
    t.actAs(actorWith(['content.edit']));
    const draft = await create({ title: 'x', baseRef: 'draft' });
    const missing = await create({ title: 'x', baseRef: 'nope' });
    expect(draft.status).toBe(422);
    expect(only(draft.body)?.code).toBe('invalid-base');
    // Exactly what a branch that does not exist gets, but for its name.
    expect(draft.status).toBe(missing.status);
    expect(draft.headers['content-type']).toBe(missing.headers['content-type']);
    expect(draft.body).toEqual(
      JSON.parse(JSON.stringify(missing.body).replaceAll('nope', 'draft')),
    );
    expect(only(draft.body)?.detail).toContain('"draft"');

    // A released base needs only content.edit.
    const released = await create({ title: 'x', baseRef: 'main' });
    expect(released.status).toBe(201);
    expect(one(released.body).attributes.baseCommit).toBe(t.commits.main);
  });

  it('refuses a malformed document, naming the member at fault', async () => {
    t.actAs(author);
    const cases: [unknown, string][] = [
      [
        { data: { type: 'ChangeSet', attributes: { title: '' } } },
        '/data/attributes/title',
      ],
      [
        { data: { type: 'ChangeSet', attributes: { title: 'a\nb' } } },
        '/data/attributes/title',
      ],
      [{ data: { type: 'Module', attributes: { title: 'x' } } }, '/data/type'],
      // The server names the change set and its branch, never the client.
      [
        { data: { type: 'ChangeSet', id: 'mine', attributes: { title: 'x' } } },
        '/data',
      ],
      [
        {
          data: {
            type: 'ChangeSet',
            attributes: { title: 'x', branch: 'main' },
          },
        },
        '/data/attributes',
      ],
      [{}, '/data'],
    ];
    for (const [body, pointer] of cases) {
      const res = await t.post('/change-sets').send(JSON.stringify(body));
      expect([pointer, res.status]).toEqual([pointer, 400]);
      expect(only(res.body)).toMatchObject({
        code: 'invalid-body',
        source: { pointer },
      });
    }
    const json = await t
      .post('/change-sets')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          data: { type: 'ChangeSet', attributes: { title: 'x' } },
        }),
      );
    expect(json.status).toBe(415);
  });

  it('needs content.edit', async () => {
    t.actAs(reader);
    const res = await create({ title: 'x' });
    expect(res.status).toBe(403);
    expect(only(res.body)?.code).toBe('forbidden');
  });
});

describe('GET /change-sets and /change-sets/:id', () => {
  let mine: string;
  let theirs: string;
  beforeAll(async () => {
    t.actAs(author);
    mine = one((await create({ title: 'Mine' })).body).id;
    t.actAs(otherAuthor);
    theirs = one((await create({ title: 'Theirs' })).body).id;
    t.actAs(undefined);
  });

  it('lists newest first, paged and filtered, as JSON:API matching its schema', async () => {
    t.actAs(reader);
    const res = await t.get('/change-sets?page[size]=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    const page = ChangeSetPageDocument.parse(res.body);
    expect(page.data.map((c) => c.id)).toEqual([theirs]);
    expect(page.meta.page.total).toBeGreaterThanOrEqual(2);
    expect(page.links.next).toContain('page%5Bnumber%5D=2');

    const byAuthor = ChangeSetPageDocument.parse(
      (await t.get('/change-sets?filter[author]=sample-other')).body,
    );
    expect(byAuthor.data.map((c) => c.id)).toEqual([theirs]);
    const abandoned = ChangeSetPageDocument.parse(
      (await t.get('/change-sets?filter[state]=abandoned')).body,
    );
    expect(abandoned.data.map((c) => c.id)).not.toContain(mine);
    // The counts per state leave the state filter out (#481): the drafts are counted either way.
    const counts = page.meta.counts;
    expect(abandoned.meta.counts).toEqual(counts);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(
      page.meta.page.total,
    );
    expect(byAuthor.meta.counts.draft).toBe(1);
  });

  it('refuses unknown filters and parameters', async () => {
    t.actAs(reader);
    const state = await t.get('/change-sets?filter[state]=nope');
    expect(state.status).toBe(400);
    expect(only(state.body)?.source?.parameter).toBe('filter[state]');
    const unknown = await t.get('/change-sets?filter[title]=x');
    expect(only(unknown.body)?.code).toBe('unsupported-parameter');
  });

  it('reads one, and does not find an ID that names none', async () => {
    t.actAs(reader);
    const res = await t.get(`/change-sets/${mine}`);
    expect(res.status).toBe(200);
    expect(one(res.body)).toMatchObject({
      id: mine,
      attributes: { title: 'Mine' },
    });
    for (const id of [newChangeSetId(), 'nope', mine.toUpperCase()]) {
      const missing = await t.get(`/change-sets/${id}`);
      expect([id, missing.status]).toEqual([id, 404]);
      expect(only(missing.body)?.code).toBe('not-found');
    }
  });

  it('without content.read.draft lists only the caller’s own, another’s not found (#126)', async () => {
    t.actAs(actorWith(['content.read', 'content.edit']));
    const listed = ChangeSetPageDocument.parse(
      (await t.get('/change-sets')).body,
    );
    expect(listed.data).toEqual([]);
    expect(listed.meta.page.total).toBe(0);
    expect(Object.values(listed.meta.counts).every((n) => n === 0)).toBe(true);
    const hidden = await t.get(`/change-sets/${mine}`);
    expect(hidden.status).toBe(404);
    expect(only(hidden.body)?.detail).toBe(`No change set "${mine}".`);
  });
});

describe('POST /change-sets/:id/abandon', () => {
  it('abandons its author’s open change set, audited; the branch stays', async () => {
    t.actAs(author);
    const changeSet = one((await create({ title: 'Abandon me' })).body);
    const path = `/change-sets/${changeSet.id}/abandon`;

    t.actAs(otherAuthor);
    const notYours = await t.post(path);
    expect(notYours.status).toBe(403);
    expect(only(notYours.body)?.code).toBe('forbidden');

    t.actAs(author);
    const res = await t
      .post(path)
      .send(JSON.stringify({ meta: { comment: 'Superseded.' } }));
    expect(res.status).toBe(200);
    expect(one(res.body).attributes.state).toBe('abandoned');

    const again = await t.post(path);
    expect(again.status).toBe(409);
    expect(only(again.body)).toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });

    t.actAs(reader);
    const modules = await t.get(
      `/modules?ref=${encodeURIComponent(changeSet.attributes.branch)}`,
    );
    expect(modules.status).toBe(200);

    t.actAs(admin);
    const events = AuditEventPageDocument.parse(
      (await t.get(`/audit-events?filter[subject]=change-set/${changeSet.id}`))
        .body,
    ).data;
    expect(
      events.map((e) => [e.attributes.action, e.attributes.comment]),
    ).toEqual([
      ['change-set.abandon', 'Superseded.'],
      ['change-set.create', null],
    ]);
  });

  it('does not find an unknown change set, and refuses a malformed body', async () => {
    t.actAs(author);
    for (const id of [newChangeSetId(), 'nope']) {
      const res = await t.post(`/change-sets/${id}/abandon`);
      expect([id, res.status]).toEqual([id, 404]);
    }
    const bad = await t
      .post(`/change-sets/${newChangeSetId()}/abandon`)
      .send(JSON.stringify({ meta: { reason: 'x' } }));
    expect(bad.status).toBe(400);
    expect(only(bad.body)?.source?.pointer).toBe('/meta');
  });
});

describe('the reconciler', () => {
  it('leaves recorded change sets and young branches alone', async () => {
    t.actAs(author);
    const changeSet = one((await create({ title: 'Keep me' })).body);
    await t.app.get(ChangeSetReconciler).runOnce();
    t.actAs(reader);
    const refs = await t.get('/refs');
    expect(JSON.stringify(refs.body)).toContain(changeSet.attributes.branch);
  });

  it('recovers from a failure between the branch and the database', async () => {
    const store = t.app.get(ChangeSetStore);
    const insert = store.insert.bind(store);
    store.insert = () => Promise.reject(new Error('the database went away'));
    const branches = async () =>
      (
        (await t.get('/refs?page[size]=200')).body as { data: { id: string }[] }
      ).data
        .map((r) => r.id)
        .filter((id) => id.includes('change-sets/'));
    let orphans: string[];
    try {
      t.actAs(author);
      const res = await create({ title: 'Lost' });
      expect(res.status).toBe(500);
      t.actAs(reader);
      const before = await branches();
      t.actAs(admin);
      const recorded = (
        await t.get(
          '/audit-events?filter[action]=change-set.create&page[size]=200',
        )
      ).body as { data: { attributes: { subject: { id: string } } }[] };
      const known = new Set(recorded.data.map((e) => e.attributes.subject.id));
      orphans = before.filter((b) => ![...known].some((id) => b.includes(id)));
      expect(orphans).toHaveLength(1);
    } finally {
      store.insert = insert;
    }
    // Once old enough, the reconciler removes it, and nothing else.
    const report = await t.app
      .get(ReconcileChangeSetBranchesAction)
      .handle({ now: Date.now() + ORPHAN_GRACE_MS + 1000 });
    expect(report.removed).toHaveLength(1);
    expect(orphans[0]).toContain(report.removed[0]);
    t.actAs(reader);
    const after = await branches();
    expect(after.some((b) => orphans.includes(b))).toBe(false);
    expect(after.length).toBeGreaterThan(0);
  });
});
