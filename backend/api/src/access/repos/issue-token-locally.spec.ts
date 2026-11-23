import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { auditEvents } from '../../audit/repos/audit.tables.js';
import { hashServiceToken, serviceTokenId } from '../core/service-token.js';
import { roles } from './access.tables.js';
import { DrizzleServiceAccountStore } from './drizzle-service-accounts.js';
import { issueTokenLocally } from './issue-token-locally.js';

describe('issueTokenLocally', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
    await database.db
      .insert(roles)
      .values({ id: 'reader', name: 'Reader', permissions: ['content.read'] });
  });
  afterEach(() => database?.close());

  it('creates the account with its roles, issues a token and audits it without the token', async () => {
    const { token, expiresAt } = await issueTokenLocally(database, {
      serviceAccountId: 'agent',
      name: 'MCP',
      roleIds: ['reader'],
      days: 7,
    });
    const store = new DrizzleServiceAccountStore(database);
    expect((await store.find('agent'))?.roleIds).toEqual(['reader']);
    const credential = await store.credential(serviceTokenId(token)!);
    expect(credential?.token.secretHash).toBe(hashServiceToken(token));
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const events = await database.db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toEqual([
      'service-account.create',
      'role.assign',
      'service-token.issue',
    ]);
    expect(
      JSON.stringify(events, (_, v: unknown) =>
        typeof v === 'bigint' ? String(v) : v,
      ),
    ).not.toContain(token.slice(26));
    expect(events[0]?.actorId).toBe('service:cli');

    // Again: another token, the roles untouched.
    const again = await issueTokenLocally(database, {
      serviceAccountId: 'agent',
      name: 'MCP 2',
      roleIds: [],
    });
    expect(again.token).not.toBe(token);
  });

  it('refuses what it should not do', async () => {
    await expect(
      issueTokenLocally(database, {
        serviceAccountId: 'agent',
        name: 'x',
        roleIds: ['nope'],
      }),
    ).rejects.toThrow('No role nope');
    await issueTokenLocally(database, {
      serviceAccountId: 'agent',
      name: 'x',
      roleIds: [],
    });
    await expect(
      issueTokenLocally(database, {
        serviceAccountId: 'agent',
        name: 'x',
        roleIds: ['reader'],
      }),
    ).rejects.toThrow('changed in Admin');
    await expect(
      issueTokenLocally(database, {
        serviceAccountId: 'agent',
        name: 'x',
        roleIds: [],
        days: 400,
      }),
    ).rejects.toThrow('1 to 366 days');
  });
});
