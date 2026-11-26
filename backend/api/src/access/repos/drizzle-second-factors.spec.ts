import { randomBytes } from 'node:crypto';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { MAX_PENDING_SIGN_INS } from '../core/pending-sign-ins.js';
import { secondFactorContext } from '../core/second-factors.js';
import { users } from './access.tables.js';
import {
  DrizzlePendingSignIns,
  DrizzleSecondFactors,
  SecondFactorSealedSecretSource,
} from './drizzle-second-factors.js';
import {
  pendingSignIns,
  secondFactorRecoveryCodes,
} from './second-factors.tables.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const at = new Date('2026-11-20T10:00:00Z');

let database: PgliteDatabase;
let unit: DrizzleUnitOfWork;

beforeEach(async () => {
  database = await createTestDatabase();
  unit = new DrizzleUnitOfWork(database);
  await database.db.insert(users).values([
    { id: 'pat', name: 'Pat' },
    { id: 'lee', name: 'Lee' },
  ]);
});

describe('DrizzleSecondFactors (#611)', () => {
  let factors: DrizzleSecondFactors;
  beforeEach(() => {
    factors = new DrizzleSecondFactors(database);
  });

  const begin = (sealed: string, userId = 'pat') =>
    unit.run((tx) => factors.begin(tx, userId, sealed, at));
  const confirm = (sealed: string, step = 5, codes = [hash(1), hash(2)]) =>
    unit.run((tx) => factors.confirm(tx, 'pat', sealed, at, step, codes));

  it('keeps one per person: begun again replaces an open one, never one that is on', async () => {
    expect(await factors.find('pat')).toBeUndefined();
    expect(await begin('one')).toBe(true);
    expect(await begin('two')).toBe(true);
    expect(await factors.find('pat')).toEqual({
      userId: 'pat',
      sealedSecret: 'two',
      begunAt: at,
      confirmedAt: null,
      recoveryCodesLeft: 0,
    });
    // The one before it confirms nothing.
    expect(await confirm('one')).toBe(false);
    expect(await confirm('two')).toBe(true);
    expect(await confirm('two')).toBe(false);
    expect(await begin('three')).toBe(false);
    expect(await factors.find('pat')).toMatchObject({
      sealedSecret: 'two',
      confirmedAt: at,
      recoveryCodesLeft: 2,
    });
  });

  it('accepts a step once, and none before it', async () => {
    const use = (step: number) =>
      unit.run((tx) => factors.useStep(tx, 'pat', step));
    await begin('one');
    expect(await use(6)).toBe(false);
    await confirm('one', 5);
    expect(await use(5)).toBe(false);
    expect(await use(4)).toBe(false);
    expect(await use(6)).toBe(true);
    expect(await use(6)).toBe(false);
    expect(await use(8)).toBe(true);
    expect(await use(7)).toBe(false);
    expect(
      (await Promise.all([use(9), use(9), use(9)])).filter(Boolean),
    ).toHaveLength(1);
  });

  it('accepts a recovery code once, for its person, and replaces them all', async () => {
    const use = (n: number, userId = 'pat') =>
      unit.run((tx) => factors.useRecoveryCode(tx, userId, hash(n)));
    await begin('one');
    await confirm('one');
    expect(await use(1, 'lee')).toBe(false);
    expect((await Promise.all([use(1), use(1)])).filter(Boolean)).toHaveLength(
      1,
    );
    expect(await use(1)).toBe(false);
    await unit.run((tx) => factors.replaceRecoveryCodes(tx, 'pat', [hash(3)]));
    expect(await use(2)).toBe(false);
    expect(await use(3)).toBe(true);
  });

  it('is removed with its codes, and says whether one was on', async () => {
    const remove = () => unit.run((tx) => factors.remove(tx, 'pat'));
    expect(await remove()).toBe(false);
    await begin('one');
    expect(await remove()).toBe(false);
    await begin('one');
    await confirm('one');
    expect(await remove()).toBe(true);
    expect(await database.db.select().from(secondFactorRecoveryCodes)).toEqual(
      [],
    );
  });

  it('is undone with its transaction', async () => {
    await begin('one');
    await confirm('one');
    await expect(
      unit.run(async (tx) => {
        await factors.useStep(tx, 'pat', 9);
        await factors.useRecoveryCode(tx, 'pat', hash(1));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await factors.find('pat'))?.recoveryCodesLeft).toBe(2);
    expect(await unit.run((tx) => factors.useStep(tx, 'pat', 9))).toBe(true);
  });

  it('is re-sealed by a rotation of the instance key', async () => {
    const source = new SecondFactorSealedSecretSource();
    await begin('one');
    await begin('two', 'lee');
    expect(await unit.run((tx) => source.sample(tx, 1))).toEqual([
      { sealed: 'two', context: secondFactorContext('lee') },
    ]);
    expect(
      await unit.run((tx) =>
        source.reseal(tx, (value) =>
          value.sealed === 'one' ? `${value.context}/new` : undefined,
        ),
      ),
    ).toBe(1);
    expect((await factors.find('pat'))?.sealedSecret).toBe(
      'second-factor:v1:pat/new',
    );
    expect((await factors.find('lee'))?.sealedSecret).toBe('two');
  });
});

describe('DrizzlePendingSignIns (#611)', () => {
  let pending: DrizzlePendingSignIns;
  beforeEach(() => {
    pending = new DrizzlePendingSignIns(database);
  });

  const later = (ms: number) => new Date(at.getTime() + ms);
  const create = (
    key: string,
    { userId = 'pat', now = at }: { userId?: string; now?: Date } = {},
  ) =>
    unit.run((tx) =>
      pending.create(
        tx,
        {
          hash: key,
          userId,
          step: 'verify',
          provider: 'password',
          via: null,
          expiresAt: new Date(now.getTime() + 1000),
        },
        now,
      ),
    );

  it('is found, and taken once, while it has not run out', async () => {
    await create(hash(1));
    expect(await pending.find(hash(1))).toEqual({
      hash: hash(1),
      userId: 'pat',
      step: 'verify',
      provider: 'password',
      via: null,
      expiresAt: later(1000),
    });
    const take = (now: Date) =>
      unit.run((tx) => pending.take(tx, hash(1), now));
    expect(await take(later(1000))).toBe(false);
    expect(await take(later(999))).toBe(true);
    expect(await take(later(999))).toBe(false);
    expect(await pending.find(hash(1))).toBeUndefined();
  });

  it('clears the person’s run-out ones, and all of them when asked, nobody else’s', async () => {
    await create(hash(1));
    await create(hash(2), { userId: 'lee' });
    await create(hash(3), { now: later(5000) });
    const left = async () =>
      (await database.db.select().from(pendingSignIns))
        .map((row) => row.tokenHash)
        .sort();
    expect(await left()).toEqual([hash(2), hash(3)]);
    await unit.run((tx) => pending.revokeAll(tx, 'pat'));
    expect(await left()).toEqual([hash(2)]);
  });

  it('keeps a bounded number per person, the newest', async () => {
    const keys = Array.from({ length: MAX_PENDING_SIGN_INS + 2 }, () =>
      randomBytes(32).toString('hex'),
    );
    for (const [i, key] of keys.entries()) await create(key, { now: later(i) });
    expect(await database.db.select().from(pendingSignIns)).toHaveLength(
      MAX_PENDING_SIGN_INS,
    );
    expect(await pending.find(keys[1]!)).toBeUndefined();
    expect(await pending.find(keys[2]!)).toBeDefined();
    expect(await pending.find(keys.at(-1)!)).toBeDefined();
  });
});
