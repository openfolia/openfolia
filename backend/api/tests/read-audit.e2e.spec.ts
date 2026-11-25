import request from 'supertest';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { mintServiceToken } from '../src/access/core/service-token.js';
import { roles } from '../src/access/repos/access.tables.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Reads of service accounts (#877): each request of a service account's
 * token that changes nothing is one `api.read` event (kind `read`) naming
 * the account and the token; a person's reads and the shared token's are
 * not recorded, nor are requests that change something (their actions
 * record what they change) or that never authenticated.
 */
let t: TestApp;
let token: string;
let tokenId: string;

const admin = {
  kind: 'user' as const,
  id: 'sample-admin',
  roles: [
    {
      id: 'admin',
      name: 'Admin',
      permissions: ['admin.roles' as const],
      scope: {},
    },
  ],
};

beforeAll(async () => {
  t = await createTestApp();
  await t.database.db.insert(roles).values({
    id: 'reader',
    name: 'Reader',
    permissions: ['content.read'],
  });
  await t.database.db
    .insert(serviceAccounts)
    .values({ id: 'agent', name: 'Agent' });
  await t.database.db
    .insert(serviceAccountRoles)
    .values({ serviceAccountId: 'agent', roleId: 'reader' });
  const minted = mintServiceToken();
  await t.database.db.insert(serviceTokens).values({
    id: minted.id,
    serviceAccountId: 'agent',
    name: 'Reads',
    secretHash: minted.secretHash,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  token = minted.token;
  tokenId = minted.id;
});
afterAll(() => t?.close());

const asAgent = (path: string) =>
  request(t.app.getHttpServer())
    .get(path)
    .set('Authorization', `Bearer ${token}`);

/** The read events, newest first (as the admin lists them). */
async function reads() {
  t.actAs(admin);
  try {
    const res = await t.get('/audit-events?filter[kind]=read&page[size]=100');
    expect(res.status).toBe(200);
    return AuditEventPageDocument.parse(res.body).data;
  } finally {
    t.actAs(undefined);
  }
}

describe('read events (#877)', () => {
  it('records a service account’s read with its token, path, route, ref, commit, status and client', async () => {
    const res = await asAgent('/modules/en/charging?ref=main').set(
      'X-OpenFolia-Client',
      'mcp/read_module',
    );
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await reads()).toHaveLength(1));
    const [event] = await reads();
    expect(event!.attributes).toMatchObject({
      kind: 'read',
      actor: { kind: 'service', id: 'agent' },
      action: 'api.read',
      subject: { type: 'route', id: '/modules/en/charging' },
      comment: null,
      data: {
        tokenId,
        route: '/modules/:lang/:id',
        status: 200,
        ref: 'main',
        commit: res.headers['x-ccms-commit'],
        client: 'mcp/read_module',
      },
    });
    // Never the token, never another header.
    expect(JSON.stringify(event)).not.toContain(token);
  });

  it('records a refused read with its status, and filters by account and kind', async () => {
    const before = (await reads()).length;
    expect((await asAgent('/modules/en/no-such-module')).status).toBe(404);
    await vi.waitFor(async () =>
      expect(await reads()).toHaveLength(before + 1),
    );
    const [latest] = await reads();
    expect(latest!.attributes.data).toMatchObject({ status: 404 });
    t.actAs(admin);
    try {
      const mine = await t.get(
        '/audit-events?filter[actor]=service/agent&filter[kind]=read',
      );
      expect(AuditEventPageDocument.parse(mine.body).data).toHaveLength(
        before + 1,
      );
      const writes = await t.get(
        '/audit-events?filter[actor]=service/agent&filter[kind]=write',
      );
      expect(AuditEventPageDocument.parse(writes.body).data).toEqual([]);
      expect((await t.get('/audit-events?filter[kind]=other')).status).toBe(
        400,
      );
    } finally {
      t.actAs(undefined);
    }
  });

  // A ref cut at 200 through a surrogate pair would be malformed JSON and fail its transaction.
  it('records a read whose ref is cut through an emoji, and the next read too', async () => {
    const before = (await reads()).length;
    const ref = `${'a'.repeat(199)}${encodeURIComponent('😀')}`;
    await asAgent(`/me?ref=${ref}`);
    await asAgent('/me');
    await vi.waitFor(async () =>
      expect(await reads()).toHaveLength(before + 2),
    );
    const cut = (await reads()).find((e) => e.attributes.data['ref']);
    expect(cut!.attributes.data['ref']).toBe(`${'a'.repeat(199)}\uFFFD`);
  });

  it('records nothing for the shared token, a person, a wrong token or a change', async () => {
    const before = (await reads()).length;
    expect((await t.get('/modules/en/charging')).status).toBe(200);
    t.actAs(admin);
    expect((await t.get('/me')).status).toBe(200);
    t.actAs(undefined);
    const wrong = `${token.slice(0, -4)}0000`;
    expect(
      (
        await request(t.app.getHttpServer())
          .get('/me')
          .set('Authorization', `Bearer ${wrong}`)
      ).status,
    ).toBe(401);
    // A change by the account: refused (no permission), and not a read.
    expect(
      (
        await request(t.app.getHttpServer())
          .post('/change-sets')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/vnd.api+json')
          .send('{}')
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // One more read of the account's, so the wait below has something to see.
    expect((await asAgent('/me')).status).toBe(200);
    await vi.waitFor(async () =>
      expect(await reads()).toHaveLength(before + 1),
    );
    const [latest] = await reads();
    expect(latest!.attributes.subject).toEqual({ type: 'route', id: '/me' });
  });

  it('exports the kind as the last CSV column, and filters the export by it', async () => {
    t.actAs(admin);
    try {
      const res = await t.get(
        '/audit-events/export?format=csv&filter[kind]=read',
      );
      expect(res.status).toBe(200);
      const lines = res.text.split('\r\n').filter((l) => l !== '');
      expect(lines[0]).toBe(
        'id,at,actor kind,actor id,action,subject type,subject id,comment,data,kind',
      );
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.slice(1).every((l) => l.endsWith(',read'))).toBe(true);
    } finally {
      t.actAs(undefined);
    }
  });
});
