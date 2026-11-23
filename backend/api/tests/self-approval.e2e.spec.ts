import { execFileSync } from 'node:child_process';
import type { Module } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import {
  MergeDocument,
  ReviewDocument,
} from '../src/change-sets/api/workflow.resources.js';
import { InstallationSettingsDocument } from '../src/settings/api/settings.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Self-approval (#588) through the HTTP API, on an app of its own: the installation setting
 * (`GET`/`PATCH /settings`), and an author approving and signing off their own change set under
 * each of its values.
 */

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

/** A team of one: writes, reviews and signs off. */
const solo = user('solo-writer', [
  'content.edit',
  'content.review',
  'content.approve',
]);
const approver = user('sample-approver', ['content.approve'], {
  moduleTypes: ['procedure'],
});
const publisher = user('sample-publisher', ['release.publish']);
const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
  await seedUsers(solo, approver);
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

async function seedUsers(...actors: Actor[]) {
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: actors.flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: actors.map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
}

function setRule(rule: string, actor: Actor = admin) {
  t.actAs(actor);
  return t.patch('/settings').send(
    JSON.stringify({
      data: {
        type: 'InstallationSettings',
        id: 'installation',
        attributes: { selfApproval: rule },
      },
    }),
  );
}

async function rule(value: string) {
  const res = await setRule(value);
  expect(res.status).toBe(200);
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

/** A change set of `solo`'s, changing `charging`, submitted for review. */
async function submitted(text: string): Promise<string> {
  t.actAs(solo);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: text } },
    }),
  );
  expect(created.status).toBe(201);
  const { id } = ChangeSetDocument.parse(created.body).data;
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    JSON.stringify({
      data: { type: 'Lock', attributes: { subject: charging } },
    }),
  );
  expect(locked.status).toBe(201);
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
                id: 'typed',
                content: [{ type: 'text', text }],
              },
            ],
          },
        },
      },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
  expect((await transition(id, 'submit')).status).toBe(200);
  return id;
}

function transition(id: string, name: string, actor: Actor = solo) {
  t.actAs(actor);
  return t.post(`/change-sets/${id}/${name}`).send('');
}

async function auditOf(subject: string) {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=${subject}&page[size]=200`,
  );
  expect(res.status).toBe(200);
  return AuditEventPageDocument.parse(res.body).data.map((e) => e.attributes);
}

/** Restricts procedures (the type of `charging`) on `main`: they need a sign-off. */
async function restrictProcedures() {
  const config = git('show', 'main:openfolia.yaml').replace(
    '{ id: procedure, label: Procedure }',
    '{ id: procedure, label: Procedure, restricted: true }',
  );
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [{ path: 'openfolia.yaml', content: `${config}\n` }],
    message: 'Restrict procedures',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}

describe('the installation settings', () => {
  it('answer four eyes before any change', async () => {
    t.actAs(admin);
    const res = await t.get('/settings');
    expect(res.status).toBe(200);
    expect(InstallationSettingsDocument.parse(res.body).data).toEqual({
      type: 'InstallationSettings',
      id: 'installation',
      attributes: { selfApproval: 'never', updatedAt: null },
    });
  });

  it('are read and changed only with admin.roles', async () => {
    t.actAs(solo);
    expect((await t.get('/settings')).status).toBe(403);
    const refused = await setRule('review', solo);
    expect(refused.status).toBe(403);
    t.actAs(admin);
    const after = await t.get('/settings');
    expect(
      InstallationSettingsDocument.parse(after.body).data.attributes
        .selfApproval,
    ).toBe('never');
  });

  it('refuse an unknown value', async () => {
    const res = await setRule('always');
    expect(res.status).toBe(400);
    t.actAs(admin);
    const after = await t.get('/settings');
    expect(
      InstallationSettingsDocument.parse(after.body).data.attributes
        .selfApproval,
    ).toBe('never');
  });

  it('audit a change as settings.self-approval, from and to, and nothing for no change', async () => {
    await rule('review');
    await rule('review');
    await rule('never');
    const events = await auditOf('settings/installation');
    expect(events.map((e) => [e.action, e.data]).reverse()).toEqual([
      ['settings.self-approval', { from: 'never', to: 'review' }],
      ['settings.self-approval', { from: 'review', to: 'never' }],
    ]);
  });
});

describe('self-approval without a restricted type', () => {
  afterEach(() => rule('never'));

  it('with never, refuses the author 403 as before', async () => {
    const id = await submitted('Never mine.');
    const res = await transition(id, 'approve');
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  });

  it('with review, lets the author approve their own change set, marked self everywhere', async () => {
    await rule('review');
    const id = await submitted('Mine, approved.');
    const res = await transition(id, 'approve');
    expect(res.status).toBe(200);
    const doc = ReviewDocument.parse(res.body);
    expect(doc.data.attributes.state).toBe('approved');
    expect(doc.meta.review).toMatchObject({
      pending: [],
      selfApproved: true,
      selfApproval: 'review',
      approvals: [
        {
          requirement: 'review',
          approver: { kind: 'user', id: solo.id },
          self: true,
        },
      ],
    });
    const approve = (await auditOf(`change-set/${id}`)).find(
      (e) => e.action === 'change-set.approve',
    );
    expect(approve?.data).toMatchObject({ self: true, to: 'approved' });
    // The review read says the same.
    t.actAs(solo);
    const read = await t.get(`/change-sets/${id}/review`);
    expect(read.status).toBe(200);
    expect(ReviewDocument.parse(read.body).meta.review.selfApproved).toBe(true);
  });

  it('keeps a self-approval when the setting goes back to never, and merges it', async () => {
    await rule('review');
    const id = await submitted('Mine, kept.');
    expect((await transition(id, 'approve')).status).toBe(200);
    await rule('never');
    const merged = await transition(id, 'merge', publisher);
    expect(merged.status).toBe(200);
    expect(MergeDocument.parse(merged.body).data.attributes.state).toBe(
      'merged',
    );
  });

  it('never lets the author return their own change set', async () => {
    await rule('review-and-sign-off');
    const id = await submitted('Mine, not returned.');
    t.actAs(solo);
    const res = await t
      .post(`/change-sets/${id}/return`)
      .send(JSON.stringify({ meta: { comment: 'Changes.' } }));
    expect(res.status).toBe(403);
  });
});

describe('self-approval with a restricted type', () => {
  beforeAll(() => restrictProcedures());
  afterEach(() => rule('never'));

  it('with review, stays in review until another person signs off; the author’s own sign-off is 403', async () => {
    await rule('review');
    const id = await submitted('Mine, restricted.');
    const reviewed = await transition(id, 'approve');
    expect(reviewed.status).toBe(200);
    expect(ReviewDocument.parse(reviewed.body)).toMatchObject({
      data: { attributes: { state: 'in-review' } },
      meta: { review: { pending: ['sign-off/procedure'] } },
    });
    const own = await transition(id, 'sign-off');
    expect(own.status).toBe(403);
    const signed = await transition(id, 'sign-off', approver);
    expect(signed.status).toBe(200);
    expect(ReviewDocument.parse(signed.body)).toMatchObject({
      data: { attributes: { state: 'approved' } },
      meta: {
        review: {
          selfApproved: true,
          approvals: [{ self: true }, { self: false }],
        },
      },
    });
  });

  it('with review-and-sign-off, the author takes their own change set to approved alone', async () => {
    await rule('review-and-sign-off');
    const id = await submitted('Mine, alone.');
    expect((await transition(id, 'approve')).status).toBe(200);
    const signed = await transition(id, 'sign-off');
    expect(signed.status).toBe(200);
    expect(ReviewDocument.parse(signed.body)).toMatchObject({
      data: { attributes: { state: 'approved' } },
      meta: { review: { pending: [], selfApproved: true } },
    });
    const signOff = (await auditOf(`change-set/${id}`)).find(
      (e) => e.action === 'change-set.sign-off',
    );
    expect(signOff?.data).toMatchObject({ self: true });
  });

  it('with never, refuses both to the author', async () => {
    const id = await submitted('Mine, four eyes.');
    expect((await transition(id, 'approve')).status).toBe(403);
    expect((await transition(id, 'sign-off')).status).toBe(403);
  });
});
