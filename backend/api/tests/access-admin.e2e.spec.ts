import { Logger } from '@nestjs/common';
import {
  DeactivatedUserDocument,
  RoleDocument,
  RolePageDocument,
  UserDocument,
  UserPageDocument,
  UserRolesDocument,
} from '../src/access/api/access.resources.js';
import { exampleSeed } from '../src/access/repos/example-seed.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Administering access (#39), in demo mode over the example seed, so every
 * request resolves its user as the app does: a change applies at once.
 */
let t: TestApp;
beforeAll(async () => {
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  try {
    t = await createTestApp({ CCMS_AUTH_MODE: 'demo' });
  } finally {
    warn.mockRestore();
  }
  await seedAccess(t.database, Seed.parse(exampleSeed));
});
afterAll(() => t?.close());

const ADMIN = 'sample-admin';
const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const as = (user: string) => ({
  get: (path: string) => t.get(path).set('X-Ccms-User', user),
  post: (path: string, body?: unknown) =>
    t
      .post(path)
      .set('X-Ccms-User', user)
      .send(body === undefined ? undefined : JSON.stringify(body)),
  patch: (path: string, body: unknown) =>
    t.patch(path).set('X-Ccms-User', user).send(JSON.stringify(body)),
  delete: (path: string, body?: unknown) =>
    t
      .delete(path)
      .set('X-Ccms-User', user)
      .send(body === undefined ? undefined : JSON.stringify(body)),
});
const admin = as(ADMIN);

describe('roles', () => {
  it('lists them, paged, with their holders', async () => {
    const res = await admin.get('/roles?page[size]=3');
    expect(res.status).toBe(200);
    const doc = RolePageDocument.parse(res.body);
    expect(doc.data).toHaveLength(3);
    expect(doc.meta.page.total).toBe(exampleSeed.roles.length);
    const all = RolePageDocument.parse(
      (await admin.get('/roles?page[size]=200')).body,
    );
    expect(all.data.find((r) => r.id === 'admin')?.meta.holders).toBe(1);
  });

  it('is for admins only', async () => {
    const res = await as('sample-author').get('/roles');
    expect(res.status).toBe(403);
    expect(error(res.body)?.code).toBe('forbidden');
  });

  it('refuses a "__proto__" facet rather than dropping it', async () => {
    // JSON.parse makes it an own key, as a request body would.
    const scope: unknown = JSON.parse(
      '{"facets":{"__proto__":["x"],"region":["eu"]}}',
    );
    const res = await admin.post('/roles', {
      data: {
        type: 'Role',
        id: 'proto-role',
        attributes: { name: 'Proto', permissions: ['content.read'], scope },
      },
    });
    expect(res.status).toBe(400);
    expect(error(res.body)?.code).toBe('invalid-body');
    expect((await admin.get('/roles/proto-role')).status).toBe(404);
  });

  it('creates, changes and deletes a role, each audited', async () => {
    const created = await admin.post('/roles', {
      data: {
        type: 'Role',
        id: 'e2e-role',
        attributes: {
          name: 'E2E role',
          description: 'For a test',
          permissions: ['content.edit', 'content.read'],
          scope: { languages: ['de'] },
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe('/roles/e2e-role');
    const role = RoleDocument.parse(created.body).data;
    // Put in the order the permissions are listed in.
    expect(role.attributes.permissions).toEqual([
      'content.read',
      'content.edit',
    ]);

    const again = await admin.post('/roles', {
      data: {
        type: 'Role',
        id: 'e2e-role',
        attributes: { name: 'X', permissions: ['content.read'] },
      },
    });
    expect(again.status).toBe(409);
    expect(error(again.body)?.code).toBe('role-exists');

    const changed = await admin.patch('/roles/e2e-role', {
      data: {
        type: 'Role',
        id: 'e2e-role',
        attributes: { name: 'E2E', scope: {} },
      },
    });
    expect(changed.status).toBe(200);
    expect(RoleDocument.parse(changed.body).data.attributes).toMatchObject({
      name: 'E2E',
      description: 'For a test',
      scope: {},
    });

    const mismatch = await admin.patch('/roles/e2e-role', {
      data: { type: 'Role', id: 'other', attributes: { name: 'E2E' } },
    });
    expect(mismatch.status).toBe(409);
    expect(error(mismatch.body)?.code).toBe('id-mismatch');

    expect((await admin.delete('/roles/e2e-role')).status).toBe(204);
    expect((await admin.get('/roles/e2e-role')).status).toBe(404);

    const events = AuditEventPageDocument.parse(
      (await admin.get('/audit-events?filter[subject]=role/e2e-role')).body,
    );
    expect(events.data.map((e) => e.attributes.action)).toEqual([
      'role.delete',
      'role.update',
      'role.create',
    ]);
  });

  it('refuses a malformed role', async () => {
    const res = await admin.post('/roles', {
      data: {
        type: 'Role',
        id: 'Bad ID',
        attributes: { name: '', permissions: ['nope'] },
      },
    });
    expect(res.status).toBe(400);
  });

  it('refuses to delete a role still held', async () => {
    const res = await admin.delete('/roles/author');
    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({ code: 'role-in-use' });
  });
});

describe('users', () => {
  it('lists them with filters, and hides email from the demo list', async () => {
    const byRole = UserPageDocument.parse(
      (await admin.get('/users?filter[role]=reviewer')).body,
    );
    expect(byRole.data.map((u) => u.id)).toEqual([
      'sample-approver',
      'sample-reviewer',
    ]);
    const bad = await admin.get('/users?filter[status]=gone');
    expect(bad.status).toBe(400);
  });

  it('adds a user with roles, changes it, and refuses a taken email', async () => {
    const created = await admin.post('/users', {
      data: {
        type: 'User',
        id: 'e2e-user',
        attributes: { name: 'E2E User', email: 'e2e@example.org' },
        relationships: {
          roles: { data: [{ type: 'Role', id: 'author' }] },
        },
      },
    });
    expect(created.status).toBe(201);
    const user = UserDocument.parse(created.body).data;
    expect(user.attributes).toEqual({
      name: 'E2E User',
      email: 'e2e@example.org',
      deactivatedAt: null,
    });
    expect(user.relationships.roles.data).toEqual([
      { type: 'Role', id: 'author' },
    ]);
    // The new user acts at once.
    expect((await as('e2e-user').get('/me')).status).toBe(200);

    const taken = await admin.post('/users', {
      data: {
        type: 'User',
        id: 'e2e-other',
        attributes: { name: 'Other', email: 'E2E@example.org' },
      },
    });
    expect(taken.status).toBe(409);
    expect(error(taken.body)?.code).toBe('email-taken');

    const unknownRole = await admin.post('/users', {
      data: {
        type: 'User',
        id: 'e2e-other',
        attributes: { name: 'Other', email: 'other@example.org' },
        relationships: { roles: { data: [{ type: 'Role', id: 'nope' }] } },
      },
    });
    expect(unknownRole.status).toBe(422);
    expect(error(unknownRole.body)).toMatchObject({
      code: 'unknown-role',
      meta: { roles: ['nope'] },
    });

    const patched = await admin.patch('/users/e2e-user', {
      data: {
        type: 'User',
        id: 'e2e-user',
        attributes: { name: 'E2E Person' },
        relationships: { roles: { data: [{ type: 'Role', id: 'reader' }] } },
      },
    });
    expect(patched.status).toBe(200);
    expect(UserDocument.parse(patched.body).data).toMatchObject({
      attributes: { name: 'E2E Person' },
      relationships: { roles: { data: [{ type: 'Role', id: 'reader' }] } },
    });

    const added = await admin.post('/users/e2e-user/relationships/roles', {
      data: [{ type: 'Role', id: 'author' }],
    });
    expect(added.status).toBe(200);
    expect(UserRolesDocument.parse(added.body).data.map((r) => r.id)).toEqual([
      'author',
      'reader',
    ]);
    const removed = await admin.delete('/users/e2e-user/relationships/roles', {
      data: [{ type: 'Role', id: 'reader' }],
    });
    expect(UserRolesDocument.parse(removed.body).data.map((r) => r.id)).toEqual(
      ['author'],
    );

    const events = AuditEventPageDocument.parse(
      (await admin.get('/audit-events?filter[subject]=user/e2e-user')).body,
    );
    expect(events.data.map((e) => e.attributes.action)).toEqual([
      'user.update',
      'user.create',
    ]);
    // Never the name or the email address.
    expect(JSON.stringify(events.data)).not.toContain('example.org');
  });

  it('deactivates a user, who then cannot act, and reactivates it', async () => {
    const res = await admin.post('/users/sample-reader/deactivate');
    expect(res.status).toBe(200);
    const doc = DeactivatedUserDocument.parse(res.body);
    expect(doc.data.attributes.deactivatedAt).not.toBeNull();
    expect(doc.meta.locksReleased).toBe(0);

    const refused = await as('sample-reader').get('/me');
    expect(refused.status).toBe(403);
    expect(error(refused.body)?.code).toBe('user-deactivated');
    const demo = UserPageDocument.parse(
      (await t.get('/demo/users?page[size]=200')).body,
    );
    expect(demo.data.map((u) => u.id)).not.toContain('sample-reader');
    expect(demo.data.every((u) => u.attributes.email === undefined)).toBe(true);

    expect((await admin.post('/users/sample-reader/deactivate')).status).toBe(
      409,
    );
    const back = await admin.post('/users/sample-reader/reactivate');
    expect(back.status).toBe(200);
    expect(UserDocument.parse(back.body).data.attributes.deactivatedAt).toBe(
      null,
    );
    expect((await as('sample-reader').get('/me')).status).toBe(200);
  });

  it('never removes the last admin', async () => {
    const self = await admin.post(`/users/${ADMIN}/deactivate`);
    expect(self.status).toBe(409);
    expect(error(self.body)?.code).toBe('last-admin');
    const unassign = await admin.delete(`/users/${ADMIN}/relationships/roles`, {
      data: [{ type: 'Role', id: 'admin' }],
    });
    expect(error(unassign.body)?.code).toBe('last-admin');
    const role = await admin.patch('/roles/admin', {
      data: {
        type: 'Role',
        id: 'admin',
        attributes: { permissions: ['content.read'] },
      },
    });
    expect(error(role.body)?.code).toBe('last-admin');
    // Still an admin.
    expect((await admin.get('/roles')).status).toBe(200);
  });

  it('takes a role away at once', async () => {
    await admin.post('/users/sample-publisher/relationships/roles', {
      data: [{ type: 'Role', id: 'admin' }],
    });
    expect((await as('sample-publisher').get('/roles')).status).toBe(200);
    await admin.delete('/users/sample-publisher/relationships/roles', {
      data: [{ type: 'Role', id: 'admin' }],
    });
    expect((await as('sample-publisher').get('/roles')).status).toBe(403);
  });
});
