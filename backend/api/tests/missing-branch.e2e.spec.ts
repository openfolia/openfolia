import { execFileSync } from 'node:child_process';
import { Logger } from '@nestjs/common';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ChangeSetDocument,
  ChangeSetPageDocument,
} from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetReconciler } from '../src/change-sets/api/change-set-reconciler.js';
import {
  changeSetBranch,
  newChangeSetId,
} from '../src/change-sets/core/change-set.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/** #317: a change set whose branch is gone from the content repository. */
const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};
const stranger: Actor = { ...author, id: 'sample-stranger' };
const reader = actorWith(['content.read', 'content.read.draft']);
const admin: Actor = {
  ...actorWith([
    'content.read',
    'content.read.draft',
    'content.edit',
    'admin.roles',
  ]),
  id: 'sample-admin',
};

let t: TestApp;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-C', process.env['CCMS_CONTENT_DIR'] as string, ...args],
    { encoding: 'utf8' },
  ).trim();
const hasBranch = (branch: string) =>
  git('for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) !== '';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => {
  t?.actAs(undefined);
  vi.restoreAllMocks();
});

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function started(title: string) {
  t.actAs(author);
  const res = await t
    .post('/change-sets')
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
    );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data;
}

describe('a change set whose branch was deleted under it', () => {
  it('says so in its meta, answers its reads with a code of their own, and is left for a person', async () => {
    const lost = await started('Lost branch');
    const kept = await started('Kept branch');
    const branch = lost.attributes.branch;
    expect(hasBranch(branch)).toBe(true);

    // While it is there, nothing is missing.
    t.actAs(author);
    const before = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${lost.id}`)).body,
    ).data;
    expect(before.meta).toEqual({
      branchMissing: false,
      behind: 0,
      base: { state: 'current' },
    });

    git('update-ref', '-d', `refs/heads/${branch}`);
    expect(hasBranch(branch)).toBe(false);

    // The change set says so, alone and in the list.
    for (const actor of [author, reader]) {
      t.actAs(actor);
      const one = await t.get(`/change-sets/${lost.id}`);
      expect(one.status).toBe(200);
      expect(ChangeSetDocument.parse(one.body).data.meta).toEqual({
        branchMissing: true,
      });
      const page = ChangeSetPageDocument.parse(
        (await t.get('/change-sets?page[size]=100')).body,
      );
      const flags = new Map(page.data.map((c) => [c.id, c.meta]));
      expect(flags.get(lost.id)).toEqual({ branchMissing: true });
      expect(flags.get(kept.id)).toEqual({ branchMissing: false });
    }

    // Reads at its branch: a code of their own, for whoever may see it.
    const ref = encodeURIComponent(branch);
    for (const actor of [author, reader]) {
      t.actAs(actor);
      for (const path of [`/modules?ref=${ref}`, `/manuals?ref=${ref}`]) {
        const res = await t.get(path);
        expect([path, res.status]).toEqual([path, 404]);
        expect(only(res.body)).toMatchObject({
          status: '404',
          code: 'change-set-branch-missing',
          meta: { branch },
        });
      }
    }
    // Anyone who may not see the change set, and an unknown one: not found.
    for (const [actor, name] of [
      [stranger, branch],
      [author, changeSetBranch(newChangeSetId())],
      [author, 'no-such-branch'],
    ] as const) {
      t.actAs(actor);
      const res = await t.get(`/modules?ref=${encodeURIComponent(name)}`);
      expect([name, res.status]).toEqual([name, 404]);
      expect(only(res.body)?.code).toBe('not-found');
    }
    // Its own routes that open the branch by name say the same.
    t.actAs(author);
    const lock = await t.post(`/change-sets/${lost.id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: {
            subject: { type: 'module', lang: 'en', moduleId: 'charging' },
          },
        },
      }),
    );
    expect([lock.status, only(lock.body)?.code]).toEqual([
      404,
      'change-set-branch-missing',
    ]);
    // Other change sets and the released content read as before.
    t.actAs(author);
    expect(
      (
        await t.get(
          `/modules?ref=${encodeURIComponent(kept.attributes.branch)}`,
        )
      ).status,
    ).toBe(200);
    expect((await t.get('/modules')).status).toBe(200);

    // The reconciler does not fail on it, logs it once, and recreates nothing.
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    const reconciler = t.app.get(ChangeSetReconciler);
    await reconciler.runOnce();
    await reconciler.runOnce();
    const naming = (spy: typeof warn) =>
      spy.mock.calls.filter((call) => String(call[0]).includes(lost.id));
    expect(naming(warn)).toHaveLength(1);
    expect(String(naming(warn)[0]?.[0])).toContain('branch is gone');
    expect(naming(error)).toEqual([]);
    expect(String(warn.mock.calls.flat())).not.toContain(kept.id);
    expect(hasBranch(branch)).toBe(false);

    // Another author may not abandon it; an admin may, now that it is gone.
    t.actAs(stranger);
    expect((await t.post(`/change-sets/${lost.id}/abandon`)).status).toBe(404);
    t.actAs(admin);
    expect((await t.post(`/change-sets/${kept.id}/abandon`)).status).toBe(403);
    const abandoned = await t.post(`/change-sets/${lost.id}/abandon`);
    expect(abandoned.status).toBe(200);
    expect(ChangeSetDocument.parse(abandoned.body).data.attributes.state).toBe(
      'abandoned',
    );
    expect(hasBranch(branch)).toBe(false);
  });
});
