import request from 'supertest';
import { mintServiceToken } from '../src/access/core/service-token.js';
import { roles } from '../src/access/repos/access.tables.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * A deployment without the shared token (#38): only service accounts'
 * tokens authenticate. Its own file: the settings are read once per file.
 */
describe('without the shared token', () => {
  let t: TestApp;
  let secret: string;
  beforeAll(async () => {
    t = await createTestApp({ CCMS_API_TOKEN: '' });
    await t.database.db.insert(roles).values({
      id: 'released-reader',
      name: 'Released reader',
      permissions: ['content.read'],
    });
    await t.database.db
      .insert(serviceAccounts)
      .values({ id: 'agent', name: 'Agent' });
    await t.database.db
      .insert(serviceAccountRoles)
      .values({ serviceAccountId: 'agent', roleId: 'released-reader' });
    const minted = mintServiceToken();
    secret = minted.token;
    await t.database.db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'agent',
      name: 'MCP',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });
  afterAll(() => t?.close());

  it('refuses the shared token and takes service tokens', async () => {
    const shared = await t.get('/me');
    expect(shared.status).toBe(401);
    const server = t.app.getHttpServer();
    const me = await request(server)
      .get('/manuals')
      .set('Authorization', `Bearer ${secret}`);
    expect(me.status).toBe(200);
    // Released content only.
    const draft = await request(server)
      .get('/manuals?ref=draft')
      .set('Authorization', `Bearer ${secret}`);
    expect(draft.status).toBe(404);
  });
});
