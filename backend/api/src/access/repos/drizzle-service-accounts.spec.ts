import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { mintServiceToken } from '../core/service-token.js';
import { roles } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleServiceAccountStore } from './drizzle-service-accounts.js';
import { serviceTokens } from './service-accounts.tables.js';

describe('DrizzleServiceAccountStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleServiceAccountStore;
  let unit: DrizzleUnitOfWork;

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleServiceAccountStore(database);
    unit = new DrizzleUnitOfWork(database);
    await database.db.insert(roles).values([
      {
        id: 'reader',
        name: 'Reader',
        permissions: ['content.read'],
        languages: ['de'],
      },
      { id: 'publisher', name: 'Publisher', permissions: ['release.publish'] },
    ]);
    await unit.run(async (tx) => {
      expect(
        await store.insert(tx, {
          id: 'portal',
          name: 'Portal',
          description: null,
        }),
      ).toBe(true);
      expect(
        await store.insert(tx, { id: 'portal', name: 'X', description: null }),
      ).toBe(false);
      await store.insert(tx, { id: 'agent', name: 'Agent', description: 'AI' });
      expect(await store.assign(tx, 'portal', 'reader')).toBe(true);
      expect(await store.assign(tx, 'portal', 'publisher')).toBe(true);
      expect(await store.assign(tx, 'portal', 'reader')).toBe(false);
    });
  });

  afterEach(() => database?.close());

  it('lists, filters, finds and changes accounts', async () => {
    const all = await store.list({ number: 1, size: 50 });
    expect(all.total).toBe(2);
    expect(all.items.map((a) => [a.id, a.roleIds])).toEqual([
      ['agent', []],
      ['portal', ['publisher', 'reader']],
    ]);
    expect(
      (await store.list({ number: 1, size: 50 }, { role: 'reader' })).items,
    ).toHaveLength(1);
    expect(
      (await store.list({ number: 1, size: 50 }, { q: 'AGE' })).items[0]?.id,
    ).toBe('agent');
    await unit.run(async (tx) => {
      await store.update(tx, 'agent', { name: 'Bot', description: null });
      expect(await store.unassign(tx, 'portal', 'reader')).toBe(true);
      expect(await store.setDeactivated(tx, 'agent', true)).toBeInstanceOf(
        Date,
      );
    });
    expect(await store.find('agent')).toMatchObject({
      name: 'Bot',
      description: null,
    });
    expect(
      (await store.list({ number: 1, size: 50 }, { active: false })).items,
    ).toHaveLength(1);
    expect((await store.find('portal'))?.roleIds).toEqual(['publisher']);
    expect(await store.find('Not An ID')).toBeUndefined();
  });

  it('counts service accounts as role holders', async () => {
    const admin = new DrizzleAccessAdmin(database);
    expect((await admin.findRole('reader'))?.holders).toBe(1);
  });

  it('stores tokens as hashes and reads a credential in one go', async () => {
    const minted = mintServiceToken();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const token = await unit.run((tx) =>
      store.insertToken(tx, {
        id: minted.id,
        serviceAccountId: 'portal',
        name: 'CI',
        secretHash: minted.secretHash,
        expiresAt,
      }),
    );
    expect(token).toMatchObject({ id: minted.id, lastUsedAt: null });
    expect(token).not.toHaveProperty('secretHash');
    const [row] = await database.db
      .select()
      .from(serviceTokens)
      .where(eq(serviceTokens.id, minted.id));
    expect(JSON.stringify(row)).not.toContain(minted.token.slice(26));

    const credential = await store.credential(minted.id);
    expect(credential?.token.secretHash).toBe(minted.secretHash);
    expect(credential?.account).toEqual({ id: 'portal', deactivatedAt: null });
    expect(credential?.roles.map((r) => r.id)).toEqual(['publisher', 'reader']);
    expect(await store.credential('0000000000000000')).toBeUndefined();
    expect(await store.credential("x' or 1=1")).toBeUndefined();

    const at = new Date();
    await store.touch(minted.id, at);
    await store.touch(minted.id, new Date(at.getTime() + 1000));
    expect((await store.credential(minted.id))?.token.lastUsedAt).toEqual(at);

    await unit.run(async (tx) => {
      expect(await store.countActiveTokens(tx, 'portal')).toBe(1);
      expect(await store.findToken(tx, 'agent', minted.id)).toBeUndefined();
      expect(await store.revokeToken(tx, minted.id)).toBeInstanceOf(Date);
      expect(await store.countActiveTokens(tx, 'portal')).toBe(0);
      // An ID taken: nothing written.
      expect(
        await store.insertToken(tx, {
          id: minted.id,
          serviceAccountId: 'agent',
          name: 'x',
          secretHash: minted.secretHash,
          expiresAt,
        }),
      ).toBeUndefined();
    });
    const page = await store.listTokens('portal', { number: 1, size: 50 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('refuses a malformed token row in the database', async () => {
    await expect(
      database.db.insert(serviceTokens).values({
        id: 'short',
        serviceAccountId: 'portal',
        name: 'x',
        secretHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(serviceTokens).values({
        id: '0123456789abcdef',
        serviceAccountId: 'portal',
        name: 'x',
        secretHash: 'not a hash',
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
  });
});
