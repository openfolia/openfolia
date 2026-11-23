import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import {
  ChangeSetDocument,
  ChangeSetPageDocument,
} from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import {
  CommitDocument,
  RevertDocument,
} from '../src/change-sets/api/commit.resources.js';
import { LockPageDocument } from '../src/change-sets/api/lock.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const reviewer: Actor = { ...author, id: 'sample-reviewer' };
const plain: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-plain',
};
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const safety = { type: 'module', lang: 'en', moduleId: 'safety-note' } as const;
const fresh = { type: 'module', lang: 'en', moduleId: 'fresh-start' } as const;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from working_copies`);
  await t.database.db.execute(sql`delete from locks`);
});

const errors = (body: unknown) => ErrorDocument.parse(body).errors;

async function changeSet(title = 'Tidy up'): Promise<{
  id: string;
  branch: string;
}> {
  t.actAs(author);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title } },
    }),
  );
  expect(res.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(res.body).data;
  return { id, branch: attributes.branch };
}

const rename = (id: string, attributes: unknown, bodyId: string = id) =>
  t
    .patch(`/change-sets/${id}`)
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', id: bodyId, attributes } }),
    );

async function lock(cs: string, subject: unknown) {
  const res = await t
    .post(`/change-sets/${cs}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(res.status).toBe(201);
}

const modulePath = (cs: string, id: string) =>
  `/change-sets/${cs}/modules/en/${id}/working-copy`;

/** Saves a paragraph into the module's working copy. */
async function edit(cs: string, id: string, text: string) {
  const path = modulePath(cs, id);
  const read = await t.get(path);
  expect(read.status).toBe(200);
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const content: Module = {
    ...(at.content as Module),
    blocks: [
      { type: 'paragraph', id: 'typed', content: [{ type: 'text', text }] },
    ],
  };
  const res = await t.put(path).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(res.status).toBe(200);
}

/** Saves a new module `id` and commits it. */
async function create(cs: string, id: string, at: string) {
  const content: Module = {
    schemaVersion: 1,
    id,
    meta: { title: 'Fresh start', type: 'concept', lang: 'en', facets: {} },
    blocks: [
      {
        type: 'paragraph',
        id: 'p1',
        content: [{ type: 'text', text: 'New.' }],
      },
    ],
  };
  const res = await t.put(modulePath(cs, id)).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: 0, baseCommit: at },
    }),
  );
  expect(res.status).toBe(200);
}

async function commit(cs: string) {
  const res = await t.post(`/change-sets/${cs}/commits`);
  expect(res.status).toBe(201);
  return CommitDocument.parse(res.body).data.id;
}

const revert = (cs: string, subjects: unknown[]) =>
  t
    .post(`/change-sets/${cs}/reverts`)
    .send(
      JSON.stringify({ data: { type: 'Revert', attributes: { subjects } } }),
    );

async function changes(cs: string) {
  const res = await t.get(`/change-sets/${cs}/changes`);
  expect(res.status).toBe(200);
  return ChangeSetChangePageDocument.parse(res.body).data.map((c) => c.id);
}

async function events(action: string) {
  const was = author;
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[action]=${action}&page[size]=200`,
  );
  t.actAs(was);
  return AuditEventPageDocument.parse(res.body).data;
}

describe('PATCH /change-sets/:changeSetId', () => {
  it('renames a change set: the new title in the list and the audit log', async () => {
    const cs = await changeSet('First title');
    const res = await rename(cs.id, {
      title: 'Second title',
      description: 'What it is for.',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(ChangeSetDocument.parse(res.body).data.attributes).toMatchObject({
      title: 'Second title',
      description: 'What it is for.',
      state: 'draft',
    });
    const list = await t.get('/change-sets?page[size]=100');
    expect(
      ChangeSetPageDocument.parse(list.body).data.find((c) => c.id === cs.id)
        ?.attributes.title,
    ).toBe('Second title');
    const cleared = await rename(cs.id, { description: null });
    expect(
      ChangeSetDocument.parse(cleared.body).data.attributes.description,
    ).toBeNull();
    const audited = (await events('change-set.edit')).filter(
      (e) => e.attributes.subject.id === cs.id,
    );
    expect(audited.map((e) => e.attributes.data)).toEqual(
      expect.arrayContaining([
        {
          from: { title: 'First title' },
          to: { title: 'Second title' },
          descriptionChanged: true,
        },
        { from: {}, to: {}, descriptionChanged: true },
      ]),
    );
  });

  it('answers each refusal with its code', async () => {
    const cs = await changeSet();
    const other = await rename(cs.id, { title: 'x', state: 'merged' });
    expect([other.status, errors(other.body)[0]?.code]).toEqual([
      400,
      'invalid-body',
    ]);
    const blank = await rename(cs.id, { title: '  ' });
    expect(blank.status).toBe(400);
    const mismatch = await rename(
      cs.id,
      { title: 'x' },
      '00000000-0000-7000-8000-000000000000',
    );
    expect([mismatch.status, errors(mismatch.body)[0]?.code]).toEqual([
      409,
      'id-mismatch',
    ]);
    t.actAs(reviewer);
    const forbidden = await rename(cs.id, { title: 'Theirs' });
    expect([forbidden.status, errors(forbidden.body)[0]?.code]).toEqual([
      403,
      'forbidden',
    ]);
    t.actAs(plain);
    const hidden = await rename(cs.id, { title: 'Theirs' });
    const missing = await rename('00000000-0000-7000-8000-000000000000', {
      title: 'Theirs',
    });
    expect([hidden.status, errors(hidden.body)[0]?.code]).toEqual([
      404,
      'not-found',
    ]);
    expect(errors(hidden.body)[0]?.detail).toBe(
      errors(missing.body)[0]?.detail.replace(
        '00000000-0000-7000-8000-000000000000',
        cs.id,
      ),
    );
    t.actAs(author);
    const abandoned = await t.post(`/change-sets/${cs.id}/abandon`);
    expect(abandoned.status).toBe(200);
    const closed = await rename(cs.id, { title: 'Too late' });
    expect([closed.status, errors(closed.body)[0]?.code]).toEqual([
      409,
      'invalid-state',
    ]);
  });
});

describe('POST /change-sets/:changeSetId/reverts', () => {
  it('takes one of two changed modules out of the review diff, and deletes a module it created', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await lock(cs.id, safety);
    await lock(cs.id, fresh);
    await edit(cs.id, 'charging', 'Changed.');
    await edit(cs.id, 'safety-note', 'Changed too.');
    const base = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${cs.id}`)).body,
    ).data.attributes.baseCommit;
    await create(cs.id, 'fresh-start', base);
    await commit(cs.id);
    expect(await changes(cs.id)).toEqual([
      'module/en/charging',
      'module/en/fresh-start',
      'module/en/safety-note',
    ]);

    const res = await revert(cs.id, [charging, fresh]);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    const outcome = RevertDocument.parse(res.body).meta;
    expect(outcome).toMatchObject({
      restored: [charging],
      deleted: [fresh],
      discarded: [],
    });
    expect(outcome.commit).toEqual(expect.any(String));
    expect(await changes(cs.id)).toEqual(['module/en/safety-note']);
    const gone = await t.get(
      `/modules/en/fresh-start?ref=${encodeURIComponent(cs.branch)}`,
    );
    expect(gone.status).toBe(404);
    const locks = await t.get(`/locks?filter[changeSet]=${cs.id}`);
    expect(
      LockPageDocument.parse(locks.body).data.map((l) => l.attributes.subject),
    ).toEqual([safety]);
    const audited = (await events('change-set.revert')).filter(
      (e) => e.attributes.subject.id === cs.id,
    );
    expect(audited.map((e) => e.attributes.data)).toEqual([
      {
        commit: outcome.commit,
        subjects: ['module/en/charging', 'module/en/fresh-start'],
        restored: 1,
        deleted: 1,
      },
    ]);
  });

  it('drops a working copy alone without a commit', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(cs.id, 'charging', 'Typed, never committed.');
    const res = await revert(cs.id, [charging]);
    expect(res.status).toBe(200);
    expect(RevertDocument.parse(res.body).meta).toMatchObject({
      commit: null,
      restored: [],
      deleted: [],
      discarded: [charging],
    });
    const read = await t.get(modulePath(cs.id, 'charging'));
    expect(ModuleWorkingCopyDocument.parse(read.body).data.meta).toMatchObject({
      saved: false,
    });
  });

  it('answers each refusal with its code', async () => {
    const cs = await changeSet();
    const unlocked = await revert(cs.id, [charging]);
    expect([unlocked.status, errors(unlocked.body)[0]?.code]).toEqual([
      409,
      'lock-required',
    ]);
    await lock(cs.id, charging);
    const unchanged = await revert(cs.id, [charging]);
    expect([unchanged.status, errors(unchanged.body)[0]?.code]).toEqual([
      422,
      'not-changed',
    ]);
    const twice = await revert(cs.id, [charging, charging]);
    expect([twice.status, errors(twice.body)[0]?.code]).toEqual([
      422,
      'duplicate-subject',
    ]);
    const empty = await revert(cs.id, []);
    expect([empty.status, errors(empty.body)[0]?.code]).toEqual([
      400,
      'invalid-body',
    ]);
    t.actAs(reviewer);
    const forbidden = await revert(cs.id, [charging]);
    expect(forbidden.status).toBe(403);
    t.actAs(plain);
    const hidden = await revert(cs.id, [charging]);
    expect([hidden.status, errors(hidden.body)[0]?.code]).toEqual([
      404,
      'not-found',
    ]);
    t.actAs(author);
    await edit(cs.id, 'charging', 'Changed.');
    await commit(cs.id);
    const submitted = await t.post(`/change-sets/${cs.id}/submit`);
    expect(submitted.status).toBe(200);
    const inReview = await revert(cs.id, [charging]);
    expect([inReview.status, errors(inReview.body)[0]?.code]).toEqual([
      409,
      'invalid-state',
    ]);
  });
});
