import { ContendedError, TimedOutError } from '../base/core/errors.js';
import type { Database } from './database.js';
import { isContended, isTimedOut } from './database.js';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work.js';

/** An error as Drizzle throws it: the driver's, with its code, as `cause`. */
const failedQuery = (code: string) =>
  new Error('Failed query: select …', {
    cause: Object.assign(new Error('the driver says no'), { code }),
  });

/** A database whose every transaction fails with `error`. */
const failing = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
  }) as unknown as Database;

describe('contended transactions', () => {
  it('knows a deadlock and a serialization failure, wrapped or not', () => {
    expect(isContended(failedQuery('40P01'))).toBe(true);
    expect(isContended(failedQuery('40001'))).toBe(true);
    expect(isContended(Object.assign(new Error('x'), { code: '40P01' }))).toBe(
      true,
    );
    for (const other of [failedQuery('23505'), failedQuery('55P03'), 'x']) {
      expect(isContended(other)).toBe(false);
    }
  });

  it('become ContendedError (409 lock-contended); anything else passes as it is', async () => {
    const deadlock = failedQuery('40P01');
    const answer = await new DrizzleUnitOfWork(failing(deadlock))
      .run(() => Promise.resolve())
      .catch((e: unknown) => e);
    expect(answer).toBeInstanceOf(ContendedError);
    expect(answer).toMatchObject({ code: 'lock-contended', cause: deadlock });
    const unique = failedQuery('23505');
    await expect(
      new DrizzleUnitOfWork(failing(unique)).run(() => Promise.resolve()),
    ).rejects.toBe(unique);
  });

  it('turn a lock or statement timeout into TimedOutError (503 database-timeout)', async () => {
    for (const code of ['55P03', '57014']) {
      const timeout = failedQuery(code);
      expect(isTimedOut(timeout)).toBe(true);
      const answer = await new DrizzleUnitOfWork(failing(timeout))
        .run(() => Promise.resolve(), { bounded: true })
        .catch((e: unknown) => e);
      expect(answer).toBeInstanceOf(TimedOutError);
      expect(answer).toMatchObject({
        code: 'database-timeout',
        retryAfterSeconds: 1,
        cause: timeout,
      });
    }
    expect(isTimedOut(failedQuery('40P01'))).toBe(false);
  });
});
