import request from 'supertest';
import { mintServiceToken } from '../src/access/core/service-token.js';
import {
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

/** Failed authentications (#38), with a low limit. Its own file: the settings are read once per file. */
describe('failed attempts', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ CCMS_AUTH_FAILURES_MAX: '3' });
  });
  afterAll(() => t?.close());

  it('do not count a valid token refused for another reason', async () => {
    // Runs first: a deactivated account's valid token is 403, and not counted.
    const server = t.app.getHttpServer();
    const minted = mintServiceToken();
    await t.database.db
      .insert(serviceAccounts)
      .values({ id: 'off', name: 'Off', deactivatedAt: new Date() });
    await t.database.db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'off',
      name: 'x',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .get('/me')
        .set('Authorization', `Bearer ${minted.token}`);
      expect(res.status).toBe(403);
    }
  });

  it('are limited per client address, then refused with Retry-After', async () => {
    const server = t.app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .get('/me')
        .set('Authorization', `Bearer ${mintServiceToken().token}`);
      expect(res.status).toBe(401);
    }
    const limited = await t.get('/me');
    expect(limited.status).toBe(429);
    expect(codeOf(limited.body)).toBe('too-many-failed-attempts');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // A valid service token still acts: no lock-out behind a shared address.
    const minted = mintServiceToken();
    await t.database.db
      .insert(serviceAccounts)
      .values({ id: 'agent', name: 'Agent' });
    await t.database.db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'agent',
      name: 'MCP',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const valid = await request(server)
      .get('/me')
      .set('Authorization', `Bearer ${minted.token}`);
    expect(valid.status).toBe(200);
    // A wrong one is refused with 429, not looked at further.
    const wrong = await request(server)
      .get('/me')
      .set('Authorization', `Bearer ${mintServiceToken().token}`);
    expect(wrong.status).toBe(429);
    // Public routes stay open.
    expect((await t.anonymous().get('/health')).status).toBe(200);
  });
});
