import { execFileSync } from 'node:child_process';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import {
  RefreshConflictPageDocument,
  RefreshDocument,
} from '../src/change-sets/api/workflow.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions]),
  id,
});
const author = user('sample-author', ['content.edit']);
const other = user('sample-other-author', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const CHARGING = 'modules/en/charging.adoc';

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const PARAGRAPHS = ['First.', 'Second.', 'Third.'];

/** `charging` with its blocks as these paragraphs (ids `p1`, `p2`, …). */
function withParagraphs(module: Module, texts: readonly string[]): Module {
  return {
    ...module,
    blocks: texts.map((text, i) => ({
      type: 'paragraph',
      id: `p${i + 1}`,
      content: [{ type: 'text', text }],
    })),
  } as Module;
}

beforeAll(async () => {
  t = await createTestApp();
  // Three paragraphs on main, far enough apart for Git to merge an edit
  // to the first with one to the third.
  const module = parseModule(git('show', `main:${CHARGING}`), {
    id: 'charging',
  });
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: CHARGING,
        content: printModule(withParagraphs(module, PARAGRAPHS)),
      },
    ],
    message: 'Paragraphs',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: reviewer.roles.map((r) => ({ ...r, id: `reviewer-${r.id}` })),
      users: [
        {
          id: reviewer.id,
          name: reviewer.id,
          roles: reviewer.roles.map((r) => `reviewer-${r.id}`),
        },
      ],
    }),
  );
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  // Each test's change sets hold `charging`; the next one locks it anew.
  await t.database.db.execute(sql`delete from locks`);
});

async function as<T>(actor: Actor, call: () => Promise<T>): Promise<T> {
  t.actAs(actor);
  return call();
}

async function create(actor: Actor, title: string) {
  const res = await as(actor, () =>
    t
      .post('/change-sets')
      .send(
        JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
      ),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data;
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

/** Locks `charging` and saves its working copy with `texts` as its paragraphs. */
async function edit(actor: Actor, id: string, texts: readonly string[]) {
  t.actAs(actor);
  // Taken anew (201), or held already (200).
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    JSON.stringify({
      data: { type: 'Lock', attributes: { subject: charging } },
    }),
  );
  expect([200, 201]).toContain(locked.status);
  const read = await t.get(copyPath(id));
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const saved = await t.put(copyPath(id)).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: withParagraphs(at.content as Module, texts),
        },
      },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
}

async function commit(actor: Actor, id: string) {
  const res = await as(actor, () => t.post(`/change-sets/${id}/commits`));
  expect(res.status).toBe(201);
}

const transition = (actor: Actor, id: string, name: string) =>
  as(actor, () => t.post(`/change-sets/${id}/${name}`).send(''));

const refresh = (actor: Actor, id: string, meta?: object) =>
  as(actor, () =>
    t
      .post(`/change-sets/${id}/refresh`)
      .send(meta === undefined ? '' : JSON.stringify({ meta })),
  );

const fileOn = (branch: string) => git('show', `${branch}:${CHARGING}`);

async function behind(actor: Actor, id: string) {
  const res = await as(actor, () => t.get(`/change-sets/${id}`));
  expect(res.status).toBe(200);
  return ChangeSetDocument.parse(res.body).data.meta?.behind;
}

async function refreshEvents(id: string) {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=change-set/${id}&filter[action]=change-set.refresh`,
  );
  return AuditEventPageDocument.parse(res.body).data.map((e) => e.attributes);
}

describe('updating a change set from main', () => {
  it('takes in a merged change set’s edit next to its own', async () => {
    // Both start before the first is merged.
    const first = await create(author, 'First paragraph');
    const next = await create(other, 'Third paragraph');
    expect(await behind(other, next.id)).toBe(0);

    await edit(author, first.id, ['First, clearer.', 'Second.', 'Third.']);
    await commit(author, first.id);
    expect((await transition(author, first.id, 'submit')).status).toBe(200);
    expect((await transition(reviewer, first.id, 'approve')).status).toBe(200);
    expect((await transition(publisher, first.id, 'merge')).status).toBe(200);

    // The neighbouring paragraph, edited from where it started.
    await edit(other, next.id, ['First.', 'Second.', 'Third, clearer.']);
    await commit(other, next.id);
    expect(await behind(other, next.id)).toBeGreaterThan(0);
    const head = git('rev-parse', `refs/heads/${next.attributes.branch}`);

    const res = await refresh(other, next.id, { comment: 'Catch up.' });
    expect(res.status).toBe(200);
    const done = RefreshDocument.parse(res.body);
    const main = git('rev-parse', 'refs/heads/main');
    expect(done.meta.refresh).toMatchObject({
      updated: true,
      fastForward: false,
      savePoint: null,
    });
    expect(done.data.attributes.baseCommit).toBe(main);
    const merged = done.meta.refresh.head;
    expect(git('rev-parse', `refs/heads/${next.attributes.branch}`)).toBe(
      merged,
    );
    expect(git('log', '-1', '--format=%P', merged)).toBe(`${head} ${main}`);
    expect(git('log', '-1', '--format=%(trailers:only)', merged)).toBe(
      [
        `Updated-change-set: ${next.id}`,
        'Updated-by: user/sample-other-author',
      ].join('\n'),
    );
    const file = fileOn(next.attributes.branch);
    expect(file).toContain('First, clearer.');
    expect(file).toContain('Third, clearer.');
    expect(await behind(other, next.id)).toBe(0);
    // What it changes is counted from main now: only its own paragraph.
    const changes = await as(other, () =>
      t.get(`/change-sets/${next.id}/changes`),
    );
    expect(changes.status).toBe(200);
    const [change] = ChangeSetChangePageDocument.parse(changes.body).data;
    expect(JSON.stringify(change)).toContain('p3');
    expect(JSON.stringify(change)).not.toContain('p1');
    expect(await refreshEvents(next.id)).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: other.id },
        comment: 'Catch up.',
        data: expect.objectContaining({
          baseRef: 'main',
          from: next.attributes.baseCommit,
          to: main,
          parent: head,
          commit: merged,
          fastForward: false,
        }),
      }),
    ]);
    // Again: nothing to take in.
    const again = await refresh(other, next.id);
    expect(RefreshDocument.parse(again.body).meta.refresh).toMatchObject({
      updated: false,
      head: merged,
    });
  });

  it('lists a conflict without writing, and keeps the author’s resolution', async () => {
    const late = await create(other, 'Late');
    const winner = await create(author, 'Winner');
    await edit(author, winner.id, [
      'First, by the winner.',
      'Second.',
      'Third.',
    ]);
    await commit(author, winner.id);
    await transition(author, winner.id, 'submit');
    await transition(reviewer, winner.id, 'approve');
    expect((await transition(publisher, winner.id, 'merge')).status).toBe(200);

    await edit(other, late.id, ['First, late.', 'Second.', 'Third.']);
    await commit(other, late.id);
    const head = git('rev-parse', `refs/heads/${late.attributes.branch}`);
    const refused = await refresh(other, late.id);
    expect(refused.status).toBe(409);
    expect(errors(refused.body)[0]).toMatchObject({
      code: 'refresh-conflict',
      meta: {
        conflicts: [{ path: CHARGING, subject: charging, kinds: ['contents'] }],
        total: 1,
      },
    });
    expect(git('rev-parse', `refs/heads/${late.attributes.branch}`)).toBe(head);
    expect(await refreshEvents(late.id)).toEqual([]);

    // Resolved in the editor (saved), then updated again keeping it.
    await edit(other, late.id, [
      'First, by the winner, late.',
      'Second.',
      'Third.',
    ]);
    const res = await refresh(other, late.id, { keep: [charging] });
    expect(res.status).toBe(200);
    const done = RefreshDocument.parse(res.body);
    expect(done.meta.refresh.savePoint).not.toBeNull();
    const file = fileOn(late.attributes.branch);
    expect(file).toContain('First, by the winner, late.');
    expect(file).not.toContain('<<<<<<<');
    expect(
      git('log', '-1', '--format=%P', done.meta.refresh.head).split(' '),
    ).toEqual([
      done.meta.refresh.savePoint,
      git('rev-parse', 'refs/heads/main'),
    ]);
    const [event] = await refreshEvents(late.id);
    expect(event?.data).toMatchObject({
      kept: ['module/en/charging'],
      resolvedByEditing: ['module/en/charging'],
      keptByChoice: [],
      savePoint: done.meta.refresh.savePoint,
    });
  });

  it('keeps only a file saved since the conflict, or one kept by choice', async () => {
    const late = await create(other, 'Late again');
    const winner = await create(author, 'Winner again');
    await edit(author, winner.id, ['First, won.', 'Second.', 'Third.']);
    await commit(author, winner.id);
    await transition(author, winner.id, 'submit');
    await transition(reviewer, winner.id, 'approve');
    expect((await transition(publisher, winner.id, 'merge')).status).toBe(200);

    await edit(other, late.id, ['First, lost.', 'Second.', 'Third.']);
    await commit(other, late.id);
    const head = git('rev-parse', `refs/heads/${late.attributes.branch}`);
    expect((await refresh(other, late.id)).status).toBe(409);
    const listed = await as(other, () =>
      t.get(`/change-sets/${late.id}/refresh-conflicts`),
    );
    expect(listed.status).toBe(200);
    const page = RefreshConflictPageDocument.parse(listed.body);
    expect(page.data).toEqual([
      expect.objectContaining({
        id: 'module/en/charging',
        attributes: expect.objectContaining({
          subject: charging,
          path: CHARGING,
          base: git('rev-parse', 'refs/heads/main'),
          savedAt: null,
        }),
      }),
    ]);
    expect(page.meta.page).toMatchObject({ total: 1 });
    // Someone else may not read them.
    expect(
      (
        await as(author, () =>
          t.get(`/change-sets/${late.id}/refresh-conflicts`),
        )
      ).status,
    ).toBe(403);

    // Not saved since: keeping it is refused, and nothing is written.
    const refused = await refresh(other, late.id, { keep: [charging] });
    expect(refused.status).toBe(409);
    expect(errors(refused.body)[0]).toMatchObject({
      code: 'refresh-unresolved',
      meta: { unresolved: [{ path: CHARGING, subject: charging }], total: 1 },
    });
    expect(git('rev-parse', `refs/heads/${late.attributes.branch}`)).toBe(head);

    // Saved, then discarded: the resolution is gone with it.
    await edit(other, late.id, ['First, won and lost.', 'Second.', 'Third.']);
    const saved = await as(other, () =>
      t.get(`/change-sets/${late.id}/refresh-conflicts`),
    );
    expect(
      RefreshConflictPageDocument.parse(saved.body).data[0]?.attributes.savedAt,
    ).not.toBeNull();
    expect((await as(other, () => t.delete(copyPath(late.id)))).status).toBe(
      204,
    );
    const discarded = await refresh(other, late.id, { keep: [charging] });
    expect(errors(discarded.body)[0]?.code).toBe('refresh-unresolved');

    // Kept by choice: the change set's version, main's change dropped.
    const res = await refresh(other, late.id, { keepMine: [charging] });
    expect(res.status).toBe(200);
    const file = fileOn(late.attributes.branch);
    expect(file).toContain('First, lost.');
    expect(file).not.toContain('First, won.');
    const [event] = await refreshEvents(late.id);
    expect(event?.data).toMatchObject({
      kept: ['module/en/charging'],
      keptByChoice: ['module/en/charging'],
      resolvedByEditing: [],
    });
    // Updated: nothing reported is left.
    const after = await as(other, () =>
      t.get(`/change-sets/${late.id}/refresh-conflicts`),
    );
    expect(RefreshConflictPageDocument.parse(after.body).data).toEqual([]);
  });

  it('is its author’s alone, and a draft’s', async () => {
    const mine = await create(author, 'Mine');
    const res = await refresh(other, mine.id);
    // A draft reader may know the change set: 403, never 404.
    expect(res.status).toBe(403);
    await edit(author, mine.id, ['Mine.', 'Second.', 'Third.']);
    await commit(author, mine.id);
    await transition(author, mine.id, 'submit');
    const submitted = await refresh(author, mine.id);
    expect(submitted.status).toBe(409);
    expect(errors(submitted.body)[0]?.code).toBe('invalid-state');
  });

  it('refuses a body it does not know', async () => {
    const mine = await create(author, 'Body');
    const res = await refresh(author, mine.id, { unknown: true });
    expect(res.status).toBe(400);
  });
});
