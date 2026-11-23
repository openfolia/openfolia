import { eq, sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import {
  FakeSecretCipher,
  testKey,
} from '../../../tests/fakes/fake-secret-key.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  DrizzleUnitOfWork,
  drizzleOf,
} from '../../database/drizzle-unit-of-work.js';
import { InstanceSecretKey } from '../../secrets/core/instance-secret-key.js';
import { users } from './access.tables.js';
import {
  DrizzleEmailCodeHasher,
  DrizzleEmailCodes,
} from './drizzle-email-codes.js';
import { emailSignInCodes } from './email-codes.tables.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');

/** The instance secret key as the server's start opens it; `null`: none. */
function secretKey(byte: number | null): InstanceSecretKey {
  const instance = new InstanceSecretKey(new FakeSecretCipher());
  instance.use({
    key: byte === null ? undefined : testKey(byte),
    origin:
      byte === null
        ? { kind: 'none' }
        : { kind: 'environment', variable: 'CCMS_SECRET_KEY' },
    finishedRotation: false,
  });
  return instance;
}

describe('DrizzleEmailCodes (#634)', () => {
  let database: PgliteDatabase;
  let unit: DrizzleUnitOfWork;
  let codes: DrizzleEmailCodes;
  const later = new Date('2026-11-21T10:10:00Z');
  const now = new Date('2026-11-21T10:00:00Z');
  /** The address each person's code is mailed to: theirs, as the request read it. */
  const addressOf: Record<string, string> = {
    pat: 'Pat@Example.org',
    lee: 'lee@example.org',
  };
  const store = (
    userId: string,
    codeHash: string,
    linkHash: string,
    sentTo = addressOf[userId]!,
  ) =>
    unit.run((tx) =>
      codes.replace(tx, {
        userId,
        codeHash,
        linkHash,
        sentTo,
        expiresAt: later,
      }),
    );

  beforeEach(async () => {
    database = await createTestDatabase();
    unit = new DrizzleUnitOfWork(database);
    codes = new DrizzleEmailCodes(database);
    await database.db.insert(users).values([
      { id: 'pat', name: 'Pat', email: 'Pat@Example.org' },
      { id: 'lee', name: 'Lee', email: 'lee@example.org' },
    ]);
  });

  it('keeps one code per person: a new one replaces the earlier one, code and link', async () => {
    await store('pat', hash(1), hash(2));
    await store('pat', hash(3), hash(4));
    expect(await database.db.select().from(emailSignInCodes)).toHaveLength(1);
    expect(await codes.claim('pat@example.ORG', now)).toEqual({
      userId: 'pat',
      codeHash: hash(3),
      expiresAt: later,
      tries: 1,
      deactivatedAt: null,
    });
    expect(await codes.findByLink(hash(2))).toBeUndefined();
    expect(await codes.findByLink(hash(4))).toMatchObject({ userId: 'pat' });
    expect(await codes.claim('lee@example.org', now)).toBeUndefined();
    expect(await codes.claim('nobody@example.org', now)).toBeUndefined();
    // Expired: not claimed.
    expect(await codes.claim('pat@example.org', later)).toBeUndefined();
  });

  it('takes a code once, only while it is the one named and has not run out', async () => {
    await store('pat', hash(1), hash(2));
    const take = (
      which: { codeHash: string } | { linkHash: string },
      at: Date,
    ) => unit.run((tx) => codes.take(tx, 'pat', which, at));
    expect(await take({ codeHash: hash(9) }, now)).toBe(false);
    expect(await take({ linkHash: hash(1) }, now)).toBe(false);
    expect(await take({ codeHash: hash(1) }, later)).toBe(false);
    // By the code and by the link at once: one takes it.
    const both = await Promise.all([
      take({ codeHash: hash(1) }, now),
      take({ linkHash: hash(2) }, now),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await database.db.select().from(emailSignInCodes)).toHaveLength(0);
  });

  it('claims a code five times at most, however many try at once (#634)', async () => {
    await store('pat', hash(1), hash(2));
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => codes.claim('PAT@example.org', now)),
    );
    const granted = claims.filter((c) => c !== undefined);
    expect(granted).toHaveLength(5);
    expect(granted.map((c) => c?.tries).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await codes.claim('pat@example.org', now)).toBeUndefined();
    // The fifth try was spent: the code goes, and the right one is refused after it.
    await codes.dropSpent('pat');
    expect(
      await unit.run((tx) => codes.take(tx, 'pat', { codeHash: hash(1) }, now)),
    ).toBe(false);
    expect(await database.db.select().from(emailSignInCodes)).toHaveLength(0);
  });

  it('takes a code on its fifth try, keeps one with tries left, and a new code starts afresh', async () => {
    await store('pat', hash(1), hash(2));
    for (let i = 0; i < 4; i++) await codes.claim('pat@example.org', now);
    await codes.dropSpent('pat');
    const [row] = await database.db.select().from(emailSignInCodes);
    expect(row?.failures).toBe(4);
    await store('pat', hash(3), hash(4));
    for (let i = 0; i < 5; i++) await codes.claim('pat@example.org', now);
    expect(
      await unit.run((tx) => codes.take(tx, 'pat', { codeHash: hash(3) }, now)),
    ).toBe(true);
  });

  it('revokes by address, ignoring case, and nothing for an unknown one', async () => {
    await store('pat', hash(1), hash(2));
    await store('lee', hash(3), hash(4));
    await codes.revokeByEmail('nobody@example.org');
    await codes.revokeByEmail('PAT@example.org');
    const left = await database.db.select().from(emailSignInCodes);
    expect(left.map((r) => r.userId)).toEqual(['lee']);
  });

  it('revokes a person’s code in the transaction, only theirs, and says whether there was one (#645)', async () => {
    await store('pat', hash(1), hash(2));
    await store('lee', hash(3), hash(4));
    // Rolled back with the change that asked for it.
    await expect(
      unit.run(async (tx) => {
        expect(await codes.revokeAll(tx, 'pat')).toBe(true);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await codes.findByLink(hash(2))).toBeDefined();
    expect(await unit.run((tx) => codes.revokeAll(tx, 'pat'))).toBe(true);
    expect(await unit.run((tx) => codes.revokeAll(tx, 'pat'))).toBe(false);
    const left = await database.db.select().from(emailSignInCodes);
    expect(left.map((r) => r.userId)).toEqual(['lee']);
  });

  it('stores a code only for the address the person has now, ignoring case (#646)', async () => {
    expect(await store('pat', hash(1), hash(2), 'pat@example.ORG')).toBe(true);
    // The request read Pat under an address Pat no longer has: nothing is stored (or mailed),
    // and the code Pat has stays.
    expect(await store('pat', hash(3), hash(4), 'pat.old@example.org')).toBe(
      false,
    );
    expect(await store('nobody', hash(5), hash(6), 'pat@example.org')).toBe(
      false,
    );
    // Deactivated meanwhile: nothing stored either.
    await database.db
      .update(users)
      .set({ deactivatedAt: now })
      .where(eq(users.id, 'lee'));
    expect(await store('lee', hash(7), hash(8))).toBe(false);
    const rows = await database.db.select().from(emailSignInCodes);
    expect(rows.map((r) => [r.userId, r.linkHash, r.sentTo])).toEqual([
      ['pat', hash(2), 'pat@example.ORG'],
    ]);
  });

  it('refuses a code mailed to an address that is no longer the person’s: no claim, link or take (#646)', async () => {
    await store('pat', hash(1), hash(2));
    await store('lee', hash(3), hash(4));
    // Where a request racing an address change leaves it: the code stored under the old
    // address after the change had ended the open one.
    await database.db
      .update(users)
      .set({ email: 'pat.new@example.org' })
      .where(eq(users.id, 'pat'));
    expect(await codes.claim('pat.new@example.org', now)).toBeUndefined();
    expect(await codes.claim('Pat@Example.org', now)).toBeUndefined();
    expect(await codes.findByLink(hash(2))).toBeUndefined();
    const take = (which: { codeHash: string } | { linkHash: string }) =>
      unit.run((tx) => codes.take(tx, 'pat', which, now));
    expect(await take({ codeHash: hash(1) })).toBe(false);
    expect(await take({ linkHash: hash(2) })).toBe(false);
    // Nobody else's code is touched.
    expect(await codes.findByLink(hash(4))).toMatchObject({ userId: 'lee' });
    expect(
      await unit.run((tx) => codes.take(tx, 'lee', { linkHash: hash(4) }, now)),
    ).toBe(true);
  });

  it('holds the person’s row while a code is asked for and while their ways in end (#650)', async () => {
    // PGlite runs one transaction at a time, so this checks the row lock each one leaves
    // (`xmax` is the transaction holding it); `email-code-ways-in.postgres.spec.ts` runs the
    // two at once on a server.
    const heldHere = async (tx: Transaction, userId: string) => {
      const [row] = await drizzleOf(tx)
        .select({
          held: sql<boolean>`${users}.xmax = pg_current_xact_id()::xid`,
        })
        .from(users)
        .where(eq(users.id, userId));
      return row?.held;
    };
    await unit.run(async (tx) => {
      await codes.hold(tx, 'pat');
      expect(await heldHere(tx, 'pat')).toBe(true);
      expect(await heldHere(tx, 'lee')).toBe(false);
    });
    await unit.run(async (tx) => {
      await codes.revokeAll(tx, 'lee');
      expect(await heldHere(tx, 'lee')).toBe(true);
      expect(await heldHere(tx, 'pat')).toBe(false);
    });
  });

  it('stores nothing but hex hashes', async () => {
    await expect(store('pat', '123456', hash(2))).rejects.toThrow();
  });
});

describe('DrizzleEmailCodeHasher (#634)', () => {
  it('is keyed by the instance secret key and bound to the person', () => {
    const one = new DrizzleEmailCodeHasher(secretKey(7));
    expect(one.available).toBe(true);
    const h = one.hash('pat', '123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Another server with the same key: the same; another person or key: not.
    const same = new DrizzleEmailCodeHasher(secretKey(7));
    expect(same.hash('pat', '123456')).toBe(h);
    expect(one.hash('lee', '123456')).not.toBe(h);
    const other = new DrizzleEmailCodeHasher(secretKey(8));
    expect(other.hash('pat', '123456')).not.toBe(h);
  });

  it('is not available without a secret key, and refuses to hash', () => {
    const none = new DrizzleEmailCodeHasher(secretKey(null));
    expect(none.available).toBe(false);
    expect(() => none.hash('pat', '123456')).toThrow();
  });
});
