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
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { RebaseDocument } from '../src/change-sets/api/workflow.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions]),
  id,
});
const author = user('sample-author', ['content.edit']);
const reader = user('sample-reader', []);
const editor = user('sample-reviewer', ['content.edit']);
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const CHARGING = 'modules/en/charging.adoc';

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

async function as<T>(actor: Actor, call: () => Promise<T>): Promise<T> {
  t.actAs(actor);
  return call();
}

async function create(title: string, description?: string) {
  const res = await as(author, () =>
    t.post('/change-sets').send(
      JSON.stringify({
        data: {
          type: 'ChangeSet',
          attributes: { title, ...(description && { description }) },
        },
      }),
    ),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data;
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

/** Locks `charging` and saves its working copy with its first block's text as `words`. */
async function edit(id: string, words: string) {
  t.actAs(author);
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    JSON.stringify({
      data: { type: 'Lock', attributes: { subject: charging } },
    }),
  );
  expect([200, 201]).toContain(locked.status);
  const read = await t.get(copyPath(id));
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const content = at.content as Module;
  const saved = await t.put(copyPath(id)).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            ...content,
            blocks: [
              {
                type: 'paragraph',
                id: 'moved',
                content: [{ type: 'text', text: words }],
              },
              ...content.blocks,
            ],
          },
        },
      },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
}

async function commit(id: string) {
  const res = await as(author, () => t.post(`/change-sets/${id}/commits`));
  expect(res.status).toBe(201);
}

/**
 * Rewrites `main` as a force-push or a restore would: a new root commit
 * holding main's files, so no commit of its history before is in it; with
 * `charging`, that module then changed on top.
 */
let rewrites = 0;
async function rewriteMain(chargingAs?: string) {
  const tree = git('rev-parse', 'refs/heads/main^{tree}');
  const root = execFileSync(
    'git',
    [
      '-C',
      dir(),
      'commit-tree',
      tree,
      // Its own message each time: the same tree, message, author and second make the same
      // commit, so nothing would be rewritten (#933).
      '-m',
      `Restored from a backup (${++rewrites})`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Someone',
        GIT_AUTHOR_EMAIL: 'someone@example.com',
        GIT_COMMITTER_NAME: 'Someone',
        GIT_COMMITTER_EMAIL: 'someone@example.com',
      },
    },
  ).trim();
  git('update-ref', 'refs/heads/main', root);
  if (chargingAs === undefined) return;
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: root,
    changes: [{ path: CHARGING, content: chargingAs }],
    message: 'Charging changed on the new main',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}

async function read(id: string) {
  const res = await as(author, () => t.get(`/change-sets/${id}`));
  expect(res.status).toBe(200);
  return ChangeSetDocument.parse(res.body).data;
}

const rebase = (actor: Actor, id: string) =>
  as(actor, () => t.post(`/change-sets/${id}/rebase`).send(''));

async function auditOf(id: string, action: string) {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=change-set/${id}&filter[action]=${action}`,
  );
  return AuditEventPageDocument.parse(res.body).data.map((e) => e.attributes);
}

describe('a change set whose base was rewritten', () => {
  it('says so on its read, refuses an update, and moves onto the current main', async () => {
    const old = await create('Charging wording', 'Clearer charging steps.');
    await edit(old.id, 'Plug in the charger first.');
    await commit(old.id);
    expect((await read(old.id)).meta).toMatchObject({
      base: { state: 'current' },
      behind: 0,
    });
    // Not rewritten: there is nothing to move.
    const early = await rebase(author, old.id);
    expect(early.status).toBe(409);
    expect(errors(early.body)[0]?.code).toBe('base-not-rewritten');

    await rewriteMain();
    expect((await read(old.id)).meta).toMatchObject({
      branchMissing: false,
      base: { state: 'rewritten' },
      behind: null,
    });
    const refreshed = await as(author, () =>
      t.post(`/change-sets/${old.id}/refresh`).send(''),
    );
    expect(refreshed.status).toBe(409);
    expect(errors(refreshed.body)[0]?.code).toBe('base-rewritten');

    // Reading is not enough; nor is editing someone else's: only its author closes it.
    expect((await rebase(reader, old.id)).status).toBe(403);
    expect((await rebase(editor, old.id)).status).toBe(403);

    const res = await rebase(author, old.id);
    expect(res.status).toBe(200);
    const moved = RebaseDocument.parse(res.body);
    const main = git('rev-parse', 'refs/heads/main');
    expect(moved.data.id).not.toBe(old.id);
    expect(moved.data.attributes).toMatchObject({
      title: 'Charging wording',
      description: 'Clearer charging steps.',
      state: 'draft',
      baseRef: 'main',
      baseCommit: main,
      author: { kind: 'user', id: author.id },
    });
    expect(moved.meta.rebase).toMatchObject({
      from: old.id,
      applied: [charging],
      conflicts: [],
      total: 0,
    });
    // Exactly the old one's own change.
    const branch = moved.data.attributes.branch;
    expect(git('show', `${branch}:${CHARGING}`)).toBe(
      git('show', `${old.attributes.branch}:${CHARGING}`),
    );
    expect(git('rev-parse', `refs/heads/${branch}^`)).toBe(main);
    expect(moved.meta.rebase.commit).toBe(
      git('rev-parse', `refs/heads/${branch}`),
    );

    // Again (another tab, a retry that went through): where its changes are now.
    const retried = await rebase(author, old.id);
    expect(retried.status).toBe(409);
    expect(errors(retried.body)[0]).toMatchObject({
      code: 'already-superseded',
      meta: { changeSetId: moved.data.id },
    });

    const before = await read(old.id);
    expect(before.attributes.state).toBe('abandoned');
    expect(before.meta).toMatchObject({ supersededBy: moved.data.id });
    // Its branch stays readable.
    expect(git('rev-parse', `refs/heads/${old.attributes.branch}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect((await read(moved.data.id)).meta).toMatchObject({
      base: { state: 'current' },
      behind: 0,
      supersedes: old.id,
    });

    // Both audited, each naming the other.
    expect(await auditOf(old.id, 'change-set.rebase')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          changeSetId: moved.data.id,
          onto: main,
          applied: 1,
          conflicts: 0,
        }),
      }),
    ]);
    expect(await auditOf(old.id, 'change-set.abandon')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ supersededBy: moved.data.id }),
      }),
    ]);
    expect(await auditOf(moved.data.id, 'change-set.create')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ supersedes: old.id }),
      }),
    ]);
  });

  it('commits what was typed first, and lists a module the new main changed too with its blocks', async () => {
    const old = await create('Charging, again');
    await edit(old.id, 'Unplug it afterwards.');
    // Typed, not yet a save point: committed first.
    const onMain = parseModule(git('show', `main:${CHARGING}`), {
      id: 'charging',
    });
    await rewriteMain(
      printModule({
        ...onMain,
        blocks: [
          {
            type: 'paragraph',
            id: 'restored',
            content: [{ type: 'text', text: 'Changed on the new main.' }],
          },
          ...onMain.blocks,
        ],
      } as Module),
    );

    const res = await rebase(author, old.id);
    expect(res.status).toBe(200);
    const moved = RebaseDocument.parse(res.body);
    expect(moved.meta.rebase).toMatchObject({
      commit: null,
      applied: [],
      total: 1,
    });
    expect(moved.meta.rebase.conflicts).toEqual([
      {
        path: CHARGING,
        subject: charging,
        kinds: ['contents'],
        blockIds: ['moved'],
      },
    ]);
    // Left as the new main has it, locked for the author to fix.
    const branch = moved.data.attributes.branch;
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(
      git('rev-parse', 'refs/heads/main'),
    );
    t.actAs(author);
    const locks = await t.get(`/locks?filter[changeSet]=${moved.data.id}`);
    expect(locks.status).toBe(200);
    expect(locks.body.data).toHaveLength(1);
    // The old one's save point holds what was typed.
    expect(git('show', `${old.attributes.branch}:${CHARGING}`)).toContain(
      'Unplug it afterwards.',
    );
    expect((await read(old.id)).attributes.state).toBe('abandoned');
  });
});
