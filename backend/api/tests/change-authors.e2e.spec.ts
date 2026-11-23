import { execFileSync } from 'node:child_process';
import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import {
  CarryForwardDocument,
  ReviewDocument,
} from '../src/change-sets/api/workflow.resources.js';
import { MaintenanceLineDocument } from '../src/releases/api/maintenance-line.resources.js';
import { MAX_WRITER_COMMITS } from '../src/change-sets/core/change-set-branches.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Everyone who wrote a change set counts as its author (#597), through the HTTP API on an app of
 * its own: a fix written on a maintenance line and carried forward to `main` by someone else
 * names its writer in the carry's commit, so the writer neither reviews nor returns the carried
 * change set under four eyes, and their approval is `self` when the installation lets an author
 * approve.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions]),
  id,
});

/** Writes the fix on the line, and reviews too. */
const writer = user('fix-writer', ['content.edit', 'content.review']);
/** Carries it forward: the carried change set's recorded author. */
const carrier = user('fix-carrier', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);
const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
/** Reviews, but reads no drafts: another author's change set is not there for them. */
const blind: Actor = {
  ...actorWith(['content.read', 'content.review', 'content.approve']),
  id: 'blind-reviewer',
};
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

beforeAll(async () => {
  t = await createTestApp();
  // Approvals hold while their approver, looked up again, still holds what they gave.
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [writer, reviewer].flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: [writer, reviewer].map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

function as(actor: Actor, path: string, body?: unknown) {
  t.actAs(actor);
  return t.post(path).send(body === undefined ? '' : JSON.stringify(body));
}

async function rule(selfApproval: string) {
  t.actAs(admin);
  const res = await t.patch('/settings').send(
    JSON.stringify({
      data: {
        type: 'InstallationSettings',
        id: 'installation',
        attributes: { selfApproval },
      },
    }),
  );
  expect(res.status).toBe(200);
}

/** A maintenance line from a fresh release of `revision`. */
async function line(revision: string): Promise<string> {
  const released = await as(publisher, '/releases', {
    data: { type: 'Release', attributes: { product: 'north', revision } },
  });
  expect(released.status).toBe(201);
  const started = await as(publisher, '/maintenance-lines', {
    data: {
      type: 'MaintenanceLine',
      relationships: {
        baseRelease: {
          data: {
            type: 'Release',
            id: ReleaseDocument.parse(released.body).data.id,
          },
        },
      },
    },
  });
  expect(started.status).toBe(201);
  return MaintenanceLineDocument.parse(started.body).data.id;
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

/** `writer`'s fix of charging on `onLine`, reviewed and merged there; then carried forward by `carrier` and submitted. */
async function carriedFix(onLine: string, text: string): Promise<string> {
  const created = await as(writer, '/change-sets', {
    data: {
      type: 'ChangeSet',
      attributes: { title: text, maintenanceLine: onLine },
    },
  });
  expect(created.status).toBe(201);
  const { id } = ChangeSetDocument.parse(created.body).data;
  expect(
    (
      await as(writer, `/change-sets/${id}/locks`, {
        data: { type: 'Lock', attributes: { subject: charging } },
      })
    ).status,
  ).toBe(201);
  const read = ModuleWorkingCopyDocument.parse((await t.get(copyPath(id))).body)
    .data.attributes;
  const content = read.content as Module;
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
                id: 'fixed',
                content: [{ type: 'text', text }],
              },
            ],
          },
        },
      },
      meta: { version: read.version, baseCommit: read.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await as(writer, `/change-sets/${id}/commits`)).status).toBe(201);
  expect((await as(writer, `/change-sets/${id}/submit`)).status).toBe(200);
  expect((await as(reviewer, `/change-sets/${id}/approve`)).status).toBe(200);
  expect((await as(publisher, `/change-sets/${id}/merge`)).status).toBe(200);

  const carried = await as(carrier, `/change-sets/${id}/carry-forward`);
  expect(carried.status).toBe(200);
  const doc = CarryForwardDocument.parse(carried.body);
  expect(doc.data.attributes.author).toEqual({ kind: 'user', id: carrier.id });
  expect(doc.meta.carryForward.applied).toEqual([charging]);
  // The carry's commit names who wrote what it carried.
  expect(
    git('log', '-1', '--format=%B', `refs/heads/${doc.data.attributes.branch}`),
  ).toContain(`Carried-author: user/${writer.id}`);
  const submitted = await as(carrier, `/change-sets/${doc.data.id}/submit`);
  expect(submitted.status).toBe(200);
  return doc.data.id;
}

describe('the writer of a carried-forward fix (#597)', () => {
  afterEach(() => rule('never'));

  it('neither approves nor returns it under four eyes; the review says it is theirs', async () => {
    const id = await carriedFix(await line('1.0'), 'Fixed on the line.');
    const approve = await as(writer, `/change-sets/${id}/approve`);
    expect(approve.status).toBe(403);
    expect(codeOf(approve.body)).toBe('forbidden');
    const ret = await as(writer, `/change-sets/${id}/return`, {
      meta: { comment: 'Mine.' },
    });
    expect(ret.status).toBe(403);

    t.actAs(writer);
    const mine = ReviewDocument.parse(
      (await t.get(`/change-sets/${id}/review`)).body,
    );
    expect(mine.meta.review.yours).toBe(true);
    t.actAs(reviewer);
    const theirs = ReviewDocument.parse(
      (await t.get(`/change-sets/${id}/review`)).body,
    );
    expect(theirs.meta.review.yours).toBe(false);

    // Someone who wrote none of it approves it.
    const approved = await as(reviewer, `/change-sets/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(ReviewDocument.parse(approved.body).meta.review).toMatchObject({
      selfApproved: false,
      approvals: [{ approver: { id: reviewer.id }, self: false }],
    });
  });

  it('approves it as its author when the rule lets an author approve: self', async () => {
    await rule('review');
    const id = await carriedFix(await line('2.0'), 'Fixed on the other line.');
    const approved = await as(writer, `/change-sets/${id}/approve`);
    expect(approved.status).toBe(200);
    const doc = ReviewDocument.parse(approved.body);
    expect(doc.data.attributes.state).toBe('approved');
    expect(doc.meta.review).toMatchObject({
      selfApproved: true,
      yours: true,
      approvals: [{ approver: { id: writer.id }, self: true }],
    });
  });
});

describe('a change set whose line is too long to read whole (#597)', () => {
  it('is 409 too-many-commits to one who sees it, and 404 to one who may not: nothing tells them it exists', async () => {
    const created = await as(writer, '/change-sets', {
      data: { type: 'ChangeSet', attributes: { title: 'A very long line' } },
    });
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    // More commits than the authors are read across, pushed from outside in one go.
    const stamp = '1700000000 +0000';
    const stream = Array.from(
      { length: MAX_WRITER_COMMITS + 1 },
      (_, i) =>
        `commit refs/heads/${attributes.branch}\ncommitter Someone <someone@example.com> ${stamp}\ndata 2\nc\n${i === 0 ? `from ${attributes.baseCommit}\n` : ''}\n`,
    ).join('');
    execFileSync('git', ['-C', dir(), 'fast-import', '--quiet'], {
      input: stream,
    });
    expect((await as(writer, `/change-sets/${id}/submit`)).status).toBe(200);

    for (const name of ['approve', 'sign-off', 'return']) {
      const refused = await as(blind, `/change-sets/${id}/${name}`, {
        meta: { comment: 'Why.' },
      });
      expect(refused.status).toBe(404);
      expect(codeOf(refused.body)).toBe('not-found');
    }
    const seen = await as(reviewer, `/change-sets/${id}/approve`);
    expect(seen.status).toBe(409);
    expect(codeOf(seen.body)).toBe('too-many-commits');
    expect(ErrorDocument.parse(seen.body).errors[0]?.meta).toEqual({
      max: MAX_WRITER_COMMITS,
    });
    expect((await as(writer, `/change-sets/${id}/abandon`)).status).toBe(200);
  });
});
