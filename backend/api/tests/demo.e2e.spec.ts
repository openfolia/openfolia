import { PERMISSIONS } from '../src/access/core/permissions.js';
import { Logger } from '@nestjs/common';
import {
  ActorDocument,
  UserPageDocument,
} from '../src/access/api/access.resources.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { exampleSeed } from '../src/access/repos/example-seed.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { fill, PUBLIC_ROUTES, routesOf, send } from './routes.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/** Demo mode (`CCMS_AUTH_MODE=demo`) over the example seed. */
let t: TestApp;
let warnings: string[];
beforeAll(async () => {
  warnings = [];
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  try {
    t = await createTestApp({ CCMS_AUTH_MODE: 'demo' });
  } finally {
    warn.mockRestore();
  }
  await seedAccess(t.database, Seed.parse(exampleSeed));
});
afterAll(() => t?.close());

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const as = (user: string, path: string) => t.get(path).set('X-Ccms-User', user);

describe('demo mode', () => {
  it('warns loudly at start-up', () => {
    expect(warnings.join('\n')).toMatch(/DEMO MODE[\s\S]*X-Ccms-User/);
  });

  it('acts as the user X-Ccms-User names', async () => {
    const res = await as('sample-reviewer', '/me');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toMatch(/X-Ccms-User/i);
    const { data } = ActorDocument.parse(res.body);
    expect(data.id).toBe('sample-reviewer');
    expect(data.attributes.kind).toBe('user');
    expect(data.attributes.name).toBe('Sample Reviewer');
    expect(data.attributes.roles.map((r) => r.id)).toEqual([
      'author',
      'reviewer',
    ]);
    const held = data.meta.permissions.map((p) => p.permission);
    expect(held).toEqual(
      expect.arrayContaining([
        'content.read',
        'content.edit',
        'content.review',
      ]),
    );
    expect(held).not.toContain('admin.roles');
  });

  it('still acts as the token service without the header', async () => {
    const res = await t.get('/me');
    expect(ActorDocument.parse(res.body).data.id).toBe('service:api-token');
  });

  it('never authenticates by the header alone', async () => {
    for (const authorization of [undefined, 'Bearer wrong', TOKEN]) {
      const req = t.anonymous().get('/me').set('X-Ccms-User', 'sample-admin');
      if (authorization) req.set('Authorization', authorization);
      const res = await req;
      expect(res.status).toBe(401);
      expect(error(res.body)?.code).toBe('unauthorized');
    }
  });

  it('refuses a user that does not exist, or a malformed one', async () => {
    for (const user of ['nobody', '', 'Sample-Admin', "x' or '1'='1"]) {
      const res = await as(user, '/me');
      expect([user, res.status]).toEqual([user, 403]);
      // The token was valid: no challenge to re-authenticate.
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(error(res.body)).toMatchObject({
        code: 'unknown-user',
        source: { header: 'X-Ccms-User' },
      });
    }
    // Sent twice, Node joins the values with ", ": no single user.
    const twice = await as('sample-admin, sample-reader', '/me');
    expect(twice.status).toBe(403);
  });

  it('resolves the actor on every route that is not public', async () => {
    const guarded = routesOf(t.app).filter((r) => !PUBLIC_ROUTES.includes(r));
    expect(guarded).toContain('GET /me');
    for (const route of guarded) {
      const path = fill(route.split(' ')[1] ?? '');
      const res = await send(t.anonymous(), route, path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-Ccms-User', 'nobody')
        .set('Accept', '*/*');
      expect([route, res.status]).toEqual([route, 403]);
      expect(error(res.body)?.code).toBe('unknown-user');
    }
  });

  it('lets a resolved admin read the audit log, and no one else', async () => {
    const admin = await as('sample-admin', '/audit-events');
    expect(admin.status).toBe(200);
    expect(AuditEventPageDocument.parse(admin.body).meta.page.currentPage).toBe(
      1,
    );
    for (const user of ['sample-author', 'sample-reader']) {
      const res = await as(user, '/audit-events');
      expect([user, res.status]).toEqual([user, 403]);
      expect(error(res.body)?.code).toBe('forbidden');
    }
  });

  it('lists users, paged, for admin.roles only', async () => {
    const res = await as('sample-admin', '/users?page[size]=2');
    expect(res.status).toBe(200);
    const doc = UserPageDocument.parse(res.body);
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 4,
      perPage: 2,
      total: 8,
    });
    expect(doc.data[0]).toEqual({
      type: 'User',
      id: 'sample-admin',
      attributes: { name: 'Sample Admin', email: null, deactivatedAt: null },
      relationships: { roles: { data: [{ type: 'Role', id: 'admin' }] } },
      meta: {
        permissions: [...PERMISSIONS],
        groupRoleIds: [],
        // How they sign in (#610): seeded, no password, no provider, no invite.
        signIn: { password: false, provider: false, inviteExpiresAt: null },
      },
    });
    expect(decodeURIComponent(doc.links.next ?? '')).toBe(
      '/users?page[size]=2&page[number]=2',
    );

    const author = await as('sample-author', '/users');
    expect(author.status).toBe(403);
    expect(error(author.body)?.code).toBe('forbidden');
  });

  it('lists the users to switch to for any actor, the token service too', async () => {
    for (const res of [
      await t.get('/demo/users?page[size]=2'),
      await as('sample-reader', '/demo/users?page[size]=2'),
    ]) {
      expect(res.status).toBe(200);
      const doc = UserPageDocument.parse(res.body);
      expect(doc.meta.page.total).toBe(8);
      expect(doc.data.map((u) => u.id)).toEqual([
        'sample-admin',
        'sample-approver',
      ]);
      expect(decodeURIComponent(doc.links.next ?? '')).toBe(
        '/demo/users?page[size]=2&page[number]=2',
      );
    }
  });
});
