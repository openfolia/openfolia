import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ChangeSetDocument,
  ChangeSetPageDocument,
} from '../src/change-sets/api/change-set.resources.js';
import { CommitDocument } from '../src/change-sets/api/commit.resources.js';
import {
  LockDocument,
  LockPageDocument,
} from '../src/change-sets/api/lock.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { newChangeSetId } from '../src/change-sets/core/change-set.js';
import { newLockId } from '../src/change-sets/core/lock.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Authors always see their own work (#126): an editor without
 * `content.read.draft` works on their own change set from start to save
 * point and reads it back, also once its branch has moved past the
 * released commit it started from, and still sees nothing of another
 * author's change set, nor what their own scope leaves out.
 */

/** Edits and reads released content of the public audience; no drafts. */
const editor: Actor = {
  ...actorWith(['content.read', 'content.edit'], { maxAudience: 'public' }),
  id: 'sample-plain-editor',
};
/** Another author, who reads drafts. */
const drafter: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-drafter',
};
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const safety = { type: 'module', lang: 'en', moduleId: 'safety-note' } as const;
/** Internal audience: outside the editor's scope. */
const internals = {
  type: 'module',
  lang: 'en',
  moduleId: 'internals',
} as const;

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
const ref = (branch: string) => `ref=${encodeURIComponent(branch)}`;
const modulePath = (cs: string, id: string) =>
  `/change-sets/${cs}/modules/en/${id}/working-copy`;

async function start(title: string): Promise<{ id: string; branch: string }> {
  const res = await t
    .post('/change-sets')
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
    );
  expect(res.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(res.body).data;
  return { id, branch: attributes.branch };
}

const takeLock = (cs: string, subject: unknown) =>
  t
    .post(`/change-sets/${cs}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));

/** Reads the module's working copy and saves `text` on top of it. */
async function edit(cs: string, id: string, text: string) {
  const read = await t.get(modulePath(cs, id));
  expect(read.status).toBe(200);
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const content: Module = {
    ...(at.content as Module),
    blocks: [
      { type: 'paragraph', id: 'typed', content: [{ type: 'text', text }] },
    ],
  };
  const res = await t.put(modulePath(cs, id)).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(res.status).toBe(200);
}

/** A save point: every working copy, or only `subjects`. */
const commit = async (cs: string, subjects?: unknown[]) => {
  const res =
    subjects === undefined
      ? await t.post(`/change-sets/${cs}/commits`)
      : await t.post(`/change-sets/${cs}/commits`).send(
          JSON.stringify({
            data: { type: 'Commit', attributes: { subjects } },
          }),
        );
  expect(res.status).toBe(201);
  return CommitDocument.parse(res.body).data.id;
};

const blocksOn = async (branch: string, id: string) => {
  const res = await t.get(`/modules/en/${id}?${ref(branch)}`);
  expect([id, res.status]).toEqual([id, 200]);
  return ModuleDocument.parse(res.body).data.attributes.blocks;
};

describe('an editor without content.read.draft', () => {
  it('starts, locks, saves, commits and reads back their own change set, also once its branch has moved', async () => {
    t.actAs(editor);
    const cs = await start('My own work');
    const released = (await t.get('/refs')).body as {
      data: { id: string; attributes: { commit: string } }[];
    };
    const main = released.data.find((r) => r.id === 'main')?.attributes.commit;

    expect((await takeLock(cs.id, charging)).status).toBe(201);
    await edit(cs.id, 'charging', 'My first save point.');
    const first = await commit(cs.id);
    expect(first).not.toBe(main);

    // The branch is now a draft: it opens for its author by name, and
    // reads as their content.read scope allows.
    const onBranch = await t.get(`/modules/en/charging?${ref(cs.branch)}`);
    expect(onBranch.status).toBe(200);
    expect(onBranch.headers['x-ccms-commit']).toBe(first);
    expect(await blocksOn(cs.branch, 'charging')).toEqual([
      {
        type: 'paragraph',
        id: 'typed',
        content: [{ type: 'text', text: 'My first save point.' }],
      },
    ]);

    // Past the released commit: lock, save and commit go on.
    expect((await takeLock(cs.id, safety)).status).toBe(201);
    await edit(cs.id, 'safety-note', 'Based on the first save point.');
    await edit(cs.id, 'charging', 'Edited after the first save point.');
    const second = await commit(cs.id, [charging]);
    // The safety note's working copy is based on the first save point, a
    // draft commit this editor cannot open by its ID: their own branch's
    // history tells it is unchanged since, so it commits.
    const third = await commit(cs.id);
    expect(third).not.toBe(second);
    expect((await blocksOn(cs.branch, 'safety-note')).map((b) => b.id)).toEqual(
      ['typed'],
    );

    // Their change set and their locks, read back.
    const read = await t.get(`/change-sets/${cs.id}`);
    expect(read.status).toBe(200);
    expect(ChangeSetDocument.parse(read.body).data.id).toBe(cs.id);
    const listed = ChangeSetPageDocument.parse(
      (await t.get('/change-sets')).body,
    );
    expect(listed.data.map((c) => c.id)).toEqual([cs.id]);
    const locks = LockPageDocument.parse((await t.get('/locks')).body);
    expect(locks.data.map((l) => l.attributes.subject)).toEqual(
      expect.arrayContaining([charging, safety]),
    );
    expect(locks.meta.page.total).toBe(2);
    const one = await t.get(`/locks/${locks.data[0]?.id}`);
    expect(one.status).toBe(200);
    LockDocument.parse(one.body);

    // A commit of their branch by its ID does not open: only the name.
    expect((await t.get(`/modules?ref=${second}`)).status).toBe(404);
  });

  it('still does not see what their scope leaves out on their own branch', async () => {
    t.actAs(editor);
    const cs = await start('Scoped');
    expect((await takeLock(cs.id, charging)).status).toBe(201);
    await edit(cs.id, 'charging', 'Moved on.');
    await commit(cs.id);

    const listed = (await t.get(`/modules?${ref(cs.branch)}&page[size]=100`))
      .body as { data: { id: string }[] };
    expect(listed.data.map((m) => m.id)).not.toContain('en/internals');
    const hidden = await t.get(`/modules/en/internals?${ref(cs.branch)}`);
    const missing = await t.get(`/modules/en/nothing-here?${ref(cs.branch)}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    // A hidden subject answers as a missing one for locks and working
    // copies too.
    const lockHidden = await takeLock(cs.id, internals);
    const lockMissing = await takeLock(cs.id, {
      ...internals,
      moduleId: 'nothing-here',
    });
    expect(lockHidden.status).toBe(403);
    expect(errors(lockHidden.body)[0]?.detail).toBe(
      errors(lockMissing.body)[0]?.detail,
    );
    expect((await t.get(modulePath(cs.id, 'internals'))).status).toBe(404);
  });

  it('sees nothing of another author’s change set: each answer as for one that does not exist', async () => {
    t.actAs(drafter);
    const theirs = await start('Not yours');
    expect((await takeLock(theirs.id, charging)).status).toBe(201);
    await edit(theirs.id, 'charging', 'Somebody else’s draft.');
    await commit(theirs.id);
    const theirLock = LockPageDocument.parse(
      (await t.get(`/locks?filter[changeSet]=${theirs.id}`)).body,
    ).data[0]?.id;
    expect(theirLock).toBeDefined();

    t.actAs(editor);
    const none = newChangeSetId();
    const pairs: [string, () => Promise<{ status: number; body: unknown }>][] =
      [
        ['GET /change-sets/:id', () => t.get(`/change-sets/${theirs.id}`)],
        ['POST /change-sets/:id/locks', () => takeLock(theirs.id, safety)],
        ['GET working copy', () => t.get(modulePath(theirs.id, 'charging'))],
        [
          'POST /change-sets/:id/commits',
          () => t.post(`/change-sets/${theirs.id}/commits`),
        ],
        [
          'POST /change-sets/:id/abandon',
          () => t.post(`/change-sets/${theirs.id}/abandon`),
        ],
      ];
    for (const [name, call] of pairs) {
      const res = await call();
      expect([name, res.status]).toEqual([name, 404]);
      expect([name, errors(res.body)[0]?.detail]).toEqual([
        name,
        `No change set "${theirs.id}".`,
      ]);
    }
    const missing = await t.get(`/change-sets/${none}`);
    expect(missing.status).toBe(404);
    expect(errors(missing.body)[0]?.detail).toBe(`No change set "${none}".`);

    // Their branch does not open, exactly like a ref that does not exist.
    const branch = await t.get(`/modules?${ref(theirs.branch)}`);
    const nowhere = await t.get(`/modules?${ref('change-sets/' + none)}`);
    expect(branch.status).toBe(404);
    expect(errors(branch.body)[0]?.detail).toBe(
      `No branch, tag or commit "${theirs.branch}".`,
    );
    expect(nowhere.status).toBe(404);

    // Not listed, not countable, their lock not there.
    const listed = ChangeSetPageDocument.parse(
      (await t.get(`/change-sets?filter[author]=${drafter.id}`)).body,
    );
    expect(listed.data).toEqual([]);
    expect(listed.meta.page.total).toBe(0);
    const locks = LockPageDocument.parse(
      (await t.get(`/locks?filter[changeSet]=${theirs.id}`)).body,
    );
    expect(locks.data).toEqual([]);
    const lock = await t.get(`/locks/${theirLock}`);
    const noLock = await t.get(`/locks/${newLockId()}`);
    expect(lock.status).toBe(404);
    expect(noLock.status).toBe(404);
    // Releasing it is not found either (#125).
    expect((await t.delete(`/locks/${theirLock}`)).status).toBe(404);

    // The draft reader keeps reading every change set.
    t.actAs(drafter);
    const all = ChangeSetPageDocument.parse(
      (await t.get('/change-sets?page[size]=100')).body,
    );
    expect(all.data.map((c) => c.attributes.author.id)).toEqual(
      expect.arrayContaining([drafter.id, editor.id]),
    );
  });

  it('does not keep reading a change set started from a draft once draft rights are gone', async () => {
    // Started while they read drafts: the base holds others' unreleased work.
    t.actAs({ ...drafter, id: editor.id });
    const res = await t.post('/change-sets').send(
      JSON.stringify({
        data: {
          type: 'ChangeSet',
          attributes: { title: 'From a draft', baseRef: 'draft' },
        },
      }),
    );
    expect(res.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(res.body).data;

    t.actAs(editor);
    // Still their own change set, but its branch does not open for them,
    // exactly like a ref that does not exist.
    expect((await t.get(`/change-sets/${id}`)).status).toBe(200);
    const branch = await t.get(`/modules?${ref(attributes.branch)}`);
    expect(branch.status).toBe(404);
    expect(errors(branch.body)[0]?.detail).toBe(
      `No branch, tag or commit "${attributes.branch}".`,
    );
    expect((await t.get(modulePath(id, 'charging'))).status).toBe(404);
    // Nor does any change through it: answered, never left waiting.
    expect((await takeLock(id, charging)).status).toBe(404);
    const commitRes = await t.post(`/change-sets/${id}/commits`);
    expect(commitRes.status).toBe(404);
    expect(errors(commitRes.body)[0]?.detail).toBe(
      `No branch, tag or commit "${attributes.branch}".`,
    );
  });
});
