import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { ActorDocument } from '../src/access/api/access.resources.js';
import {
  DeactivatedServiceAccountDocument,
  IssuedServiceTokenDocument,
  ServiceAccountDocument,
  ServiceAccountPageDocument,
  ServiceTokenDocument,
  ServiceTokenPageDocument,
} from '../src/access/api/service-accounts.resources.js';
import { mintServiceToken } from '../src/access/core/service-token.js';
import { exampleSeed } from '../src/access/repos/example-seed.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { serviceTokens } from '../src/access/repos/service-accounts.tables.js';
import { roles } from '../src/access/repos/access.tables.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

// A release writes Git; several apps.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const quietly = async <T>(start: () => Promise<T>): Promise<T> => {
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  try {
    return await start();
  } finally {
    warn.mockRestore();
  }
};

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

/**
 * Service accounts and tokens (#38), in demo mode over the example seed:
 * an admin (a person) administers them; their tokens then act as
 * themselves, with their own roles.
 */
describe('service accounts', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await quietly(() => createTestApp({ CCMS_AUTH_MODE: 'demo' }));
    await seedAccess(t.database, Seed.parse(exampleSeed));
    // Least privilege for a CI job cutting releases.
    await t.database.db.insert(roles).values({
      id: 'ci-release',
      name: 'CI release',
      permissions: ['content.read', 'release.publish'],
    });
  });
  afterAll(() => t?.close());

  const admin = {
    get: (path: string) => t.get(path).set('X-Ccms-User', 'sample-admin'),
    post: (path: string, body?: unknown) =>
      t
        .post(path)
        .set('X-Ccms-User', 'sample-admin')
        .send(body === undefined ? undefined : JSON.stringify(body)),
    patch: (path: string, body: unknown) =>
      t
        .patch(path)
        .set('X-Ccms-User', 'sample-admin')
        .send(JSON.stringify(body)),
    delete: (path: string, body?: unknown) =>
      t
        .delete(path)
        .set('X-Ccms-User', 'sample-admin')
        .send(body === undefined ? undefined : JSON.stringify(body)),
  };
  const bearer = (token: string) => {
    const server = t.app.getHttpServer();
    return {
      get: (path: string) =>
        request(server).get(path).set('Authorization', `Bearer ${token}`),
      post: (path: string, body?: unknown) =>
        request(server)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', JSON_API)
          .send(body === undefined ? undefined : JSON.stringify(body)),
    };
  };
  const create = (id: string, roleIds: string[]) =>
    admin.post('/service-accounts', {
      data: {
        type: 'ServiceAccount',
        id,
        attributes: { name: `Account ${id}`, description: null },
        relationships: {
          roles: { data: roleIds.map((r) => ({ type: 'Role', id: r })) },
        },
      },
    });
  const issue = async (id: string, attributes: Record<string, unknown> = {}) =>
    admin.post(`/service-accounts/${id}/tokens`, {
      data: { type: 'ServiceToken', attributes: { name: 'CI', ...attributes } },
    });
  const tokenOf = async (id: string) => {
    const res = await issue(id);
    expect(res.status).toBe(201);
    return IssuedServiceTokenDocument.parse(res.body);
  };

  it('creates one, issues a token shown once, and the token acts as it', async () => {
    const created = await create('ci', ['ci-release']);
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe('/service-accounts/ci');
    expect(ServiceAccountDocument.parse(created.body).data).toMatchObject({
      id: 'ci',
      attributes: { name: 'Account ci', deactivatedAt: null },
      relationships: { roles: { data: [{ type: 'Role', id: 'ci-release' }] } },
    });
    expect(codeOf((await create('ci', [])).body)).toBe(
      'service-account-exists',
    );

    const res = await issue('ci');
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const issued = IssuedServiceTokenDocument.parse(res.body);
    const secret = issued.meta.token;
    expect(secret).toMatch(/^ccms_sat_[0-9a-f]{16}_[0-9a-f]{64}$/);

    // Never again: not in the list, not in the stored row.
    const list = await admin.get('/service-accounts/ci/tokens');
    expect(list.status).toBe(200);
    const page = ServiceTokenPageDocument.parse(list.body);
    expect(page.data.map((d) => d.id)).toEqual([issued.data.id]);
    expect(JSON.stringify(list.body)).not.toContain(secret.slice(26));
    const rows = await t.database.db.select().from(serviceTokens);
    expect(JSON.stringify(rows)).not.toContain(secret.slice(26));

    const me = await bearer(secret).get('/me');
    expect(me.status).toBe(200);
    expect(ActorDocument.parse(me.body).data).toMatchObject({
      id: 'ci',
      attributes: { kind: 'service', name: 'Account ci' },
    });
    // Its own roles only: no drafts.
    expect((await bearer(secret).get('/modules?ref=draft')).status).toBe(404);
    expect((await bearer(secret).get('/users')).status).toBe(403);

    // Last use, to the minute.
    const used = ServiceTokenPageDocument.parse(
      (await admin.get('/service-accounts/ci/tokens')).body,
    );
    expect(used.data[0]?.attributes.lastUsedAt).not.toBeNull();
  });

  it('cuts a release with a token holding release.publish', async () => {
    const { meta } = await tokenOf('ci');
    const res = await bearer(meta.token).post('/releases', {
      data: {
        type: 'Release',
        attributes: { product: 'north', revision: '1.0' },
      },
    });
    expect(res.status).toBe(201);
    expect(ReleaseDocument.parse(res.body).data.attributes.publishedBy).toEqual(
      { kind: 'service', id: 'ci' },
    );
    const audit = AuditEventPageDocument.parse(
      (await admin.get('/audit-events?filter[action]=release.publish')).body,
    );
    expect(audit.data[0]?.attributes.actor).toEqual({
      kind: 'service',
      id: 'ci',
    });
  });

  it('refuses a release to a token without release.publish', async () => {
    expect((await create('reader-bot', ['reader'])).status).toBe(201);
    const { meta } = await tokenOf('reader-bot');
    const res = await bearer(meta.token).post('/releases', {
      data: {
        type: 'Release',
        attributes: { product: 'north', revision: '9.9' },
      },
    });
    expect(res.status).toBe(403);
    expect(codeOf(res.body)).toBe('forbidden');
  });

  it('never gives a service account admin.roles, nor lets a token change access', async () => {
    const refused = await create('admin-bot', ['admin']);
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('admin-role-for-service-account');
    // Nor through the role: admin.roles cannot be added to one a service account holds.
    const widened = await admin.patch('/roles/ci-release', {
      data: {
        type: 'Role',
        id: 'ci-release',
        attributes: {
          permissions: ['content.read', 'release.publish', 'admin.roles'],
        },
      },
    });
    expect(widened.status).toBe(409);
    expect(codeOf(widened.body)).toBe('role-held-by-service-account');

    const { meta } = await tokenOf('ci');
    const bot = bearer(meta.token);
    const res = await bot.post('/service-accounts', {
      data: {
        type: 'ServiceAccount',
        id: 'escalated',
        attributes: { name: 'X' },
      },
    });
    expect(res.status).toBe(403);
    expect(
      (
        await bot.post('/service-accounts/ci/tokens', {
          data: { type: 'ServiceToken', attributes: { name: 'more' } },
        })
      ).status,
    ).toBe(403);
    // It never counts as the last admin either.
    const last = await admin.delete('/users/sample-admin/relationships/roles', {
      data: [{ type: 'Role', id: 'admin' }],
    });
    expect(last.status).toBe(409);
    expect(codeOf(last.body)).toBe('last-admin');
  });

  it('never lets a service account approve or sign off', async () => {
    await t.database.db.insert(roles).values({
      id: 'bot-review',
      name: 'Bot review',
      permissions: [
        'content.read',
        'content.read.draft',
        'content.review',
        'content.approve',
      ],
    });
    expect((await create('review-bot', ['bot-review'])).status).toBe(201);
    const { meta } = await tokenOf('review-bot');
    for (const step of ['approve', 'sign-off']) {
      const res = await bearer(meta.token).post(
        `/change-sets/00000000-0000-7000-8000-000000000000/${step}`,
      );
      expect([step, res.status]).toEqual([step, 403]);
      expect(ErrorDocument.parse(res.body).errors[0]?.detail).toContain(
        'never a service account',
      );
    }
  });

  it('refuses the demo header with a service token', async () => {
    const { meta } = await tokenOf('ci');
    const res = await bearer(meta.token)
      .get('/me')
      .set('X-Ccms-User', 'sample-admin');
    expect(res.status).toBe(400);
    expect(codeOf(res.body)).toBe('user-header-not-accepted');
  });

  it('refuses a revoked token at once', async () => {
    const { data, meta } = await tokenOf('ci');
    const client = bearer(meta.token);
    expect((await client.get('/me')).status).toBe(200);
    const revoked = await admin.post(
      `/service-accounts/ci/tokens/${data.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(
      ServiceTokenDocument.parse(revoked.body).data.attributes.revokedAt,
    ).not.toBeNull();
    const res = await client.get('/me');
    expect(res.status).toBe(401);
    expect(codeOf(res.body)).toBe('token-revoked');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(
      codeOf(
        (await admin.post(`/service-accounts/ci/tokens/${data.id}/revoke`))
          .body,
      ),
    ).toBe('already-revoked');
    expect(
      (await admin.post(`/service-accounts/ci/tokens/0000000000000000/revoke`))
        .status,
    ).toBe(404);
  });

  it('refuses an expired token, and a wrong one without saying more', async () => {
    const { data, meta } = await tokenOf('ci');
    await t.database.db
      .update(serviceTokens)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(sql`${serviceTokens.id} = ${data.id}`);
    const expired = await bearer(meta.token).get('/me');
    expect(expired.status).toBe(401);
    expect(codeOf(expired.body)).toBe('token-expired');

    const wrong = await bearer(`ccms_sat_${data.id}_${'0'.repeat(64)}`).get(
      '/me',
    );
    expect(wrong.status).toBe(401);
    expect(codeOf(wrong.body)).toBe('unauthorized');
    expect(
      codeOf((await bearer(mintServiceToken().token).get('/me')).body),
    ).toBe('unauthorized');
  });

  it('refuses a bad expiry', async () => {
    for (const expiresAt of [
      '2000-01-01T00:00:00Z',
      new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
    ]) {
      const res = await issue('ci', { expiresAt });
      expect(res.status).toBe(422);
      expect(codeOf(res.body)).toBe('invalid-expiry');
    }
    const custom = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    custom.setMilliseconds(0);
    const res = await issue('ci', { expiresAt: custom.toISOString() });
    expect(
      IssuedServiceTokenDocument.parse(res.body).data.attributes.expiresAt,
    ).toBe(custom.toISOString());
  });

  it('deactivates and reactivates, effective at once', async () => {
    const { meta } = await tokenOf('ci');
    const client = bearer(meta.token);
    const off = await admin.post('/service-accounts/ci/deactivate');
    expect(off.status).toBe(200);
    expect(
      DeactivatedServiceAccountDocument.parse(off.body).meta.locksReleased,
    ).toBe(0);
    const res = await client.get('/me');
    expect(res.status).toBe(403);
    expect(codeOf(res.body)).toBe('service-account-deactivated');
    expect(codeOf((await issue('ci')).body)).toBe(
      'service-account-deactivated',
    );
    expect((await admin.post('/service-accounts/ci/reactivate')).status).toBe(
      200,
    );
    expect((await client.get('/me')).status).toBe(200);
  });

  it('lists, filters, changes roles, and holds a role it holds', async () => {
    const list = await admin.get(
      '/service-accounts?filter[role]=ci-release&page[size]=1',
    );
    expect(list.status).toBe(200);
    const page = ServiceAccountPageDocument.parse(list.body);
    expect(page.data.map((a) => a.id)).toEqual(['ci']);
    expect(page.meta.page.total).toBe(1);
    expect((await admin.get('/service-accounts?filter[nope]=x')).status).toBe(
      400,
    );

    // Only a service account holds ci-release: it is still in use.
    const held = await admin.delete('/roles/ci-release');
    expect(held.status).toBe(409);
    expect(codeOf(held.body)).toBe('role-in-use');

    const changed = await admin.patch('/service-accounts/ci', {
      data: {
        type: 'ServiceAccount',
        id: 'ci',
        attributes: { description: 'Nightly' },
        relationships: {
          roles: { data: [{ type: 'Role', id: 'reader' }] },
        },
      },
    });
    expect(changed.status).toBe(200);
    expect(ServiceAccountDocument.parse(changed.body).data).toMatchObject({
      attributes: { description: 'Nightly' },
      relationships: { roles: { data: [{ type: 'Role', id: 'reader' }] } },
    });
    const added = await admin.post('/service-accounts/ci/relationships/roles', {
      data: [{ type: 'Role', id: 'ci-release' }],
    });
    expect(added.body.data).toEqual([
      { type: 'Role', id: 'ci-release' },
      { type: 'Role', id: 'reader' },
    ]);
    expect(
      codeOf(
        (
          await admin.patch('/service-accounts/ci', {
            data: { type: 'ServiceAccount', id: 'other' },
          })
        ).body,
      ),
    ).toBe('id-mismatch');
    expect((await admin.get('/service-accounts/none')).status).toBe(404);
  });

  it('keeps every token out of the audit log', async () => {
    const { meta } = await tokenOf('ci');
    const res = await admin.get('/audit-events?page[size]=200');
    const audit = AuditEventPageDocument.parse(res.body);
    const actions = new Set(audit.data.map((e) => e.attributes.action));
    for (const action of [
      'service-account.create',
      'service-account.update',
      'service-account.deactivate',
      'service-account.reactivate',
      'service-token.issue',
      'service-token.revoke',
    ]) {
      expect(actions).toContain(action);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('ccms_sat_');
    expect(text).not.toContain(meta.token.slice(26));
    const hashes = await t.database.db
      .select({ hash: serviceTokens.secretHash })
      .from(serviceTokens);
    for (const { hash } of hashes) expect(text).not.toContain(hash);
  });
});
