import { execFileSync } from 'node:child_process';
import {
  type Manifest,
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetReconciler } from '../src/change-sets/api/change-set-reconciler.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  CommitDocument,
  NoCommitDocument,
} from '../src/change-sets/api/commit.resources.js';
import {
  ManualWorkingCopyDocument,
  ModuleWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const safety = { type: 'module', lang: 'en', moduleId: 'safety-note' } as const;
const operating = { type: 'manual', manualId: 'operating' } as const;

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

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const errors = (body: unknown) => ErrorDocument.parse(body).errors;

async function changeSet(): Promise<{ id: string; branch: string }> {
  t.actAs(author);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Save points' } },
    }),
  );
  expect(res.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(res.body).data;
  return { id, branch: attributes.branch };
}

async function lock(cs: string, subject: unknown) {
  const res = await t
    .post(`/change-sets/${cs}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(res.status).toBe(201);
}

const modulePath = (cs: string, id = 'charging') =>
  `/change-sets/${cs}/modules/en/${id}/working-copy`;
const manualPath = (cs: string) =>
  `/change-sets/${cs}/manuals/operating/working-copy`;

/** The working copy as read (the committed file when none is saved). */
async function read(path: string) {
  const res = await t.get(path);
  expect(res.status).toBe(200);
  return ModuleWorkingCopyDocument.parse(res.body).data.attributes;
}

/** Saves `content` on top of what `read` gave. */
async function save(
  path: string,
  content: unknown,
  at: { version: number; baseCommit: string },
) {
  return t.put(path).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
}

async function edit(path: string, text: string) {
  const at = await read(path);
  const res = await save(path, typed(at.content as Module, text), at);
  expect(res.status).toBe(200);
}

const typed = (module: Module, text: string): Module => ({
  ...module,
  blocks: [
    { type: 'paragraph', id: 'typed', content: [{ type: 'text', text }] },
  ],
});

/** A save point: no body (every working copy), or the attributes given. */
const commit = (cs: string, attributes?: Record<string, unknown>) =>
  attributes === undefined
    ? t.post(`/change-sets/${cs}/commits`)
    : t
        .post(`/change-sets/${cs}/commits`)
        .send(JSON.stringify({ data: { type: 'Commit', attributes } }));

async function events(action: string) {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[action]=${action}&page[size]=200`,
  );
  t.actAs(author);
  return AuditEventPageDocument.parse(res.body).data;
}

describe('POST /change-sets/:changeSetId/commits', () => {
  it('commits one working copy canonically, drops it and audits the commit', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(modulePath(cs.id), 'Committed at a save point.');

    const res = await commit(cs.id);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe(JSON_API);
    const made = CommitDocument.parse(res.body).data;
    expect(made).toMatchObject({
      type: 'Commit',
      attributes: {
        branch: cs.branch,
        parent: t.commits.main,
        message: 'Update module en/charging',
        written: [charging],
        deleted: [],
      },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: cs.id } } },
      meta: { unchanged: [] },
    });
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(made.id);
    expect(git('log', '-1', '--format=%an%n%(trailers:only)', made.id)).toBe(
      `sample-author\nChange-set: ${cs.id}\nActor: user/sample-author`,
    );
    // The file reads back to itself.
    const file = `${git('show', `${made.id}:modules/en/charging.adoc`)}\n`;
    expect(printModule(parseModule(file, { id: 'charging' }))).toBe(file);
    const onBranch = await t.get(
      `/modules/en/charging?ref=${encodeURIComponent(cs.branch)}`,
    );
    expect(onBranch.headers['x-ccms-commit']).toBe(made.id);
    expect(ModuleDocument.parse(onBranch.body).data.attributes.blocks).toEqual(
      typed({} as Module, 'Committed at a save point.').blocks,
    );

    // The working copy is gone: the committed file, at the new commit.
    expect(await read(modulePath(cs.id))).toMatchObject({
      version: 0,
      baseCommit: made.id,
    });
    const [audited] = (await events('change-set.commit')).filter(
      (e) => e.attributes.subject.id === cs.id,
    );
    expect(audited?.attributes).toMatchObject({
      actor: { kind: 'user', id: 'sample-author' },
      data: { commit: made.id, parent: t.commits.main, written: 1, deleted: 0 },
    });
    expect(
      (await events('module.write')).some(
        (e) =>
          e.attributes.subject.id === 'en/charging' &&
          e.attributes.data?.['commit'] === made.id,
      ),
    ).toBe(true);
    const outbox = await t.database.db.execute(
      sql`select topic, payload from outbox where key = ${made.id}`,
    );
    expect(outbox.rows).toEqual([
      expect.objectContaining({ topic: 'change-set.commit' }),
    ]);
  });

  it('commits several working copies and a deletion, or only those listed', async () => {
    const cs = await changeSet();
    for (const s of [charging, safety, operating]) await lock(cs.id, s);
    await edit(modulePath(cs.id), 'One.');
    await edit(modulePath(cs.id, 'safety-note'), 'Two.');

    const first = await commit(cs.id, {
      subjects: [safety],
      message: 'Safety first',
    });
    expect(first.status).toBe(201);
    const one = CommitDocument.parse(first.body).data;
    expect(one.attributes).toMatchObject({
      written: [safety],
      message: 'Safety first',
    });
    expect((await read(modulePath(cs.id))).version).toBe(1);

    const second = await commit(cs.id, { deletes: [operating] });
    expect(second.status).toBe(201);
    const two = CommitDocument.parse(second.body).data;
    expect(two.attributes).toMatchObject({
      parent: one.id,
      written: [charging],
      deleted: [operating],
    });
    // Only the deleted manual goes; the other stays.
    expect(git('ls-tree', '--name-only', two.id, 'manuals/')).toBe(
      'manuals/service.yaml',
    );
    expect(
      (await t.get(`/manuals/operating?ref=${encodeURIComponent(cs.branch)}`))
        .status,
    ).toBe(404);
    expect(
      (await events('manual.delete')).some(
        (e) => e.attributes.data?.['commit'] === two.id,
      ),
    ).toBe(true);
  });

  it('makes no commit when nothing changed', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    const at = await read(modulePath(cs.id));
    expect((await save(modulePath(cs.id), at.content, at)).status).toBe(200);
    const res = await commit(cs.id, {});
    expect(res.status).toBe(200);
    expect(NoCommitDocument.parse(res.body).meta).toEqual({
      commit: null,
      head: t.commits.main,
      unchanged: [charging],
    });
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(t.commits.main);
    expect((await read(modulePath(cs.id))).version).toBe(0);
    expect((await commit(cs.id)).status).toBe(200);
  });

  it('refuses invalid content with one error per problem', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await lock(cs.id, operating);
    const at = await read(modulePath(cs.id));
    const content = at.content as Module;
    const bad = {
      ...content,
      meta: { ...content.meta, type: 'nope' },
      blocks: [
        {
          type: 'variant',
          id: 'v',
          when: { op: 'in', attr: 'nope', values: ['x'] },
          blocks: content.blocks,
        },
      ],
    };
    expect((await save(modulePath(cs.id), bad, at)).status).toBe(200);
    const manual = ManualWorkingCopyDocument.parse(
      (await t.get(manualPath(cs.id))).body,
    ).data.attributes;
    expect(
      (
        await save(
          manualPath(cs.id),
          { ...(manual.content as Manifest), entries: [] },
          manual,
        )
      ).status,
    ).toBe(200);

    const res = await commit(cs.id);
    expect(res.status).toBe(422);
    const found = errors(res.body);
    expect(found.every((e) => e.code === 'invalid-working-copy')).toBe(true);
    expect(found.map((e) => e.source?.pointer)).toEqual(
      expect.arrayContaining([
        '/module/en/charging',
        '/module/en/charging/blocks/v',
        '/manual/operating',
      ]),
    );
    expect(found[0]?.meta).toMatchObject({ subject: expect.any(Object) });
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(t.commits.main);
  });

  it('needs the lock, and a draft', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(modulePath(cs.id), 'Mine.');
    await t.database.db.execute(sql`delete from locks`);
    const res = await commit(cs.id);
    expect(res.status).toBe(409);
    expect(errors(res.body)[0]).toMatchObject({
      code: 'lock-required',
      meta: { subject: charging },
    });

    await lock(cs.id, charging);
    expect((await t.post(`/change-sets/${cs.id}/abandon`)).status).toBe(200);
    const abandoned = await commit(cs.id);
    expect(abandoned.status).toBe(409);
    expect(errors(abandoned.body)[0]?.code).toBe('invalid-state');
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(t.commits.main);
  });

  it('refuses a working copy whose file changed on the branch since its base', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(modulePath(cs.id), 'Mine.');
    // A commit on the branch from outside, changing the file.
    const { commit: moved } = await new GitWriter(dir()).commit({
      branch: cs.branch,
      parent: t.commits.main,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule(
            typed((await read(modulePath(cs.id))).content as Module, 'Theirs.'),
          ),
        },
      ],
      message: 'Elsewhere',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const res = await commit(cs.id);
    expect(res.status).toBe(409);
    expect(errors(res.body)[0]).toMatchObject({
      code: 'stale-working-copy',
      meta: { subjects: [charging], head: moved },
    });
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(moved);

    // Saving on the stored base keeps it: the commit is still refused.
    const at = await read(modulePath(cs.id));
    expect((await save(modulePath(cs.id), at.content, at)).status).toBe(200);
    expect((await commit(cs.id)).status).toBe(409);
    // A first save in another change-set tab naming the old base is refused at once.
    await t.delete(modulePath(cs.id));
    const fresh = await save(modulePath(cs.id), at.content, {
      version: 0,
      baseCommit: t.commits.main,
    });
    expect(fresh.status).toBe(409);
    expect(errors(fresh.body)[0]?.code).toBe('stale-working-copy');
    const again = await save(modulePath(cs.id), at.content, {
      version: 0,
      baseCommit: moved,
    });
    expect(again.status).toBe(200);
    const head = ModuleWorkingCopyDocument.parse(again.body).data.attributes;
    // Merged by the editor and saved on the head: committed.
    expect(
      (
        await save(modulePath(cs.id), at.content, {
          version: head.version,
          baseCommit: moved,
        })
      ).status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
  });

  it('loses no save made at the same time as a commit', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(modulePath(cs.id), 'First.');
    const at = await read(modulePath(cs.id));
    const [saved, committed] = await Promise.all([
      save(modulePath(cs.id), typed(at.content as Module, 'Second.'), at),
      commit(cs.id),
    ]);
    expect(committed.status).toBe(201);
    const head = git('rev-parse', `refs/heads/${cs.branch}`);
    const file = git('show', `${head}:modules/en/charging.adoc`);
    const now = await read(modulePath(cs.id));
    if (saved.status === 200 && !file.includes('Second.')) {
      // Saved after the commit: kept as a working copy.
      expect(now.version).toBeGreaterThan(0);
      expect(JSON.stringify(now.content)).toContain('Second.');
    } else {
      // Saved before (and committed), or refused as stale: nothing dropped unseen.
      expect(file.includes('Second.') || saved.status === 409).toBe(true);
    }
  });

  it('recovers a commit whose recording failed, from the outbox reconciler', async () => {
    const cs = await changeSet();
    await lock(cs.id, charging);
    await edit(modulePath(cs.id), 'Landed.');
    // The database fails after the Git commit: an outbox insert raises.
    await t.database.db.execute(
      sql.raw(`create function fail_outbox() returns trigger language plpgsql as $$
        begin raise exception 'injected failure'; end $$`),
    );
    await t.database.db.execute(
      sql.raw(`create trigger fail_outbox before insert on outbox
        for each row execute function fail_outbox()`),
    );
    try {
      const failed = await commit(cs.id);
      expect(failed.status).toBe(500);
    } finally {
      await t.database.db.execute(
        sql.raw('drop trigger fail_outbox on outbox'),
      );
      await t.database.db.execute(sql.raw('drop function fail_outbox()'));
    }
    const landed = git('rev-parse', `refs/heads/${cs.branch}`);
    expect(landed).not.toBe(t.commits.main);
    expect(
      (await events('change-set.commit')).filter(
        (e) => e.attributes.subject.id === cs.id,
      ),
    ).toEqual([]);
    expect((await read(modulePath(cs.id))).version).toBe(1);

    // On restart (a reconciler pass), it is recorded and the copy dropped.
    await t.app.get(ChangeSetReconciler).runOnce();
    const [recorded] = (await events('change-set.commit')).filter(
      (e) => e.attributes.subject.id === cs.id,
    );
    expect(recorded?.attributes.data).toMatchObject({
      commit: landed,
      recovered: true,
      written: 1,
    });
    expect(await read(modulePath(cs.id))).toMatchObject({
      version: 0,
      baseCommit: landed,
    });
  });

  it('checks the body', async () => {
    const cs = await changeSet();
    for (const attributes of [
      { subjects: [{ type: 'module', lang: 'en' }] },
      { message: '' },
      { extra: true },
    ]) {
      const res = await commit(cs.id, attributes);
      expect(res.status, JSON.stringify(attributes)).toBe(400);
    }
    const twice = await commit(cs.id, { subjects: [charging, charging] });
    expect(twice.status).toBe(422);
    expect(errors(twice.body)[0]?.code).toBe('duplicate-subject');
    const message = await commit(cs.id, {
      deletes: [charging],
      message: 'Edit\n\nApproved-by: Mallory',
    });
    expect(message.status).toBe(409); // no lock on it
    await lock(cs.id, charging);
    const forged = await commit(cs.id, {
      deletes: [charging],
      message: 'Edit\n\nApproved-by: Mallory',
    });
    expect(forged.status).toBe(422);
    expect(errors(forged.body)[0]?.code).toBe('invalid-message');
  });
});
