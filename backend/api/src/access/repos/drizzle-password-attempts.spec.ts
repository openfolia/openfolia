import type { ConfigService } from '@nestjs/config';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import type { Env } from '../../config/env.js';
import { InstanceSecretKey } from '../../secrets/core/instance-secret-key.js';
import {
  FakeSecretCipher,
  testKey,
} from '../../../tests/fakes/fake-secret-key.js';
import { accountKey } from '../api/failed-authentications.js';
import { DrizzlePasswordAttempts } from './drizzle-password-attempts.js';
import { passwordAttempts, passwordAttemptsKey } from './passwords.tables.js';

const WINDOW_MS = 900_000;
const config = (max: number) =>
  ({
    get: (key: string) =>
      key === 'CCMS_PASSWORD_FAILURES_MAX' ? max : WINDOW_MS,
  }) as unknown as ConfigService<Env, true>;

describe('DrizzlePasswordAttempts (#610)', () => {
  let database: PgliteDatabase;
  let clock: number;
  /** The instance secret key, opened as the server starts; none: `null`. */
  const secretKey = (byte: number | null) => {
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
  };
  const make = (max = 3, key: number | null = 7) => {
    const attempts = new DrizzlePasswordAttempts(
      database,
      config(max),
      secretKey(key),
    );
    attempts.now = () => clock;
    return attempts;
  };
  const limited = async (attempts: DrizzlePasswordAttempts, key: string) =>
    'retryAfter' in (await attempts.reserve(key));

  beforeEach(async () => {
    database = await createTestDatabase();
    clock = Date.parse('2026-11-21T10:00:00.000Z');
  });

  it('locks a known and an unknown address alike, and unlocks both when the window ends', async () => {
    const attempts = make();
    // Whether anyone has the address is not known here at all: both are only keys.
    const known = accountKey('pat@example.org');
    const unknown = accountKey('nobody@example.org');
    for (let i = 0; i < 3; i++) {
      expect(await limited(attempts, known)).toBe(false);
      expect(await limited(attempts, unknown)).toBe(false);
    }
    const held = await attempts.reserve(known);
    expect(held).toEqual({ retryAfter: WINDOW_MS / 1000 });
    expect(await attempts.reserve(unknown)).toEqual(held);
    // The address is not in the table, only its HMAC.
    const rows = await database.db.select().from(passwordAttempts);
    expect(JSON.stringify(rows)).not.toContain('example.org');
    expect(rows).toHaveLength(2);

    clock += WINDOW_MS;
    expect(await limited(attempts, known)).toBe(false);
    expect(await limited(attempts, unknown)).toBe(false);
  });

  it('says how many tries the window has left after each (#634)', async () => {
    const attempts = make();
    const key = accountKey('pat@example.org');
    const left = [];
    for (let i = 0; i < 3; i++) {
      const counted = await attempts.reserve(key);
      if ('remaining' in counted) left.push(counted.remaining);
    }
    expect(left).toEqual([2, 1, 0]);
    expect(await make(0).reserve(key)).toMatchObject({ remaining: Infinity });
  });

  it('keeps an account locked however many made-up addresses fail after it', async () => {
    const attempts = make();
    const real = accountKey('pat@example.org');
    for (let i = 0; i < 3; i++) await attempts.reserve(real);
    for (let i = 0; i < 2_000; i++) {
      await attempts.reserve(accountKey(`nobody-${i}@example.org`));
    }
    expect(await limited(attempts, real)).toBe(true);
  });

  it('counts attempts at once against the limit, and takes back a right one in its own window only', async () => {
    const attempts = make();
    const key = accountKey('pat@example.org');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => attempts.reserve(key)),
    );
    expect(results.filter((r) => 'attempt' in r)).toHaveLength(3);
    const first = results.find((r) => 'attempt' in r);
    if (!first || !('attempt' in first)) throw new Error('none counted');
    await attempts.forgive(first.attempt);
    expect(await limited(attempts, key)).toBe(false);
    expect(await limited(attempts, key)).toBe(true);

    // A later window is never touched by taking back one from before it.
    clock += WINDOW_MS;
    const later = await attempts.reserve(key);
    await attempts.forgive(first.attempt);
    expect('attempt' in later).toBe(true);
    expect(await limited(attempts, key)).toBe(false);
    expect(await limited(attempts, key)).toBe(false);
    expect(await limited(attempts, key)).toBe(true);
  });

  it('keeps the counts across a restart and between servers sharing the secret key', async () => {
    const key = accountKey('pat@example.org');
    const before = make();
    for (let i = 0; i < 3; i++) await before.reserve(key);
    // A new instance (a restart, another server) on the same database sees the same count.
    expect(await limited(make(), key)).toBe(true);
    // Without a secret key, a key made once and kept in the database, shared the same way.
    const keyless = make(3, null);
    for (let i = 0; i < 3; i++) await keyless.reserve(key);
    expect(await limited(make(3, null), key)).toBe(true);
    expect(await database.db.select().from(passwordAttemptsKey)).toHaveLength(
      1,
    );
  });

  it('deletes ended windows only, and counts nothing at 0', async () => {
    const attempts = make();
    await attempts.reserve(accountKey('old@example.org'));
    clock += WINDOW_MS;
    await attempts.reserve(accountKey('new@example.org'));
    expect(await attempts.prune()).toBe(1);
    expect(await database.db.select().from(passwordAttempts)).toHaveLength(1);

    const off = make(0);
    for (let i = 0; i < 10; i++) {
      expect(await limited(off, accountKey('pat@example.org'))).toBe(false);
    }
  });
});
