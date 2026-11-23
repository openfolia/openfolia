import { Logger } from '@nestjs/common';
import { createTestDatabase } from '../../../tests/database.js';
import { Database, type Drizzle } from '../../database/database.js';
import {
  DrizzleDatabaseProbe,
  PING_REUSE_MS,
  PING_TIMEOUT_MS,
} from './drizzle-database-probe.js';

/** A database whose queries never answer. */
class HangingDatabase extends Database {
  readonly db = {
    execute: () => new Promise(() => undefined),
  } as unknown as Drizzle;
  readonly target = 'hanging';
  migrate = () => Promise.resolve();
  close = () => Promise.resolve();
}

describe('DrizzleDatabaseProbe', () => {
  it('resolves when the database answers', async () => {
    const database = await createTestDatabase();
    try {
      await expect(
        new DrizzleDatabaseProbe(database).ping(),
      ).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it('rejects when the database does not answer in time, logging only the change', async () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const probe = new DrizzleDatabaseProbe(new HangingDatabase());
      const pings = [probe.ping(), probe.ping()];
      const outcome = expect(Promise.all(pings)).rejects.toThrow(
        /no answer within/,
      );
      await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
      await outcome;
      expect(warn).toHaveBeenCalledTimes(1);
      // Still down a while later: no new line.
      await vi.advanceTimersByTimeAsync(PING_REUSE_MS);
      const again = expect(probe.ping()).rejects.toThrow(/no answer within/);
      await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
      await again;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('shares one ping between concurrent checks and reuses it briefly', async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(() => Promise.resolve());
      const probe = new DrizzleDatabaseProbe({ ping } as unknown as Database);
      await Promise.all([probe.ping(), probe.ping(), probe.ping()]);
      await probe.ping();
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PING_REUSE_MS);
      await probe.ping();
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when the database is back', async () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      let up = false;
      const ping = () =>
        up ? Promise.resolve() : Promise.reject(new Error('refused'));
      const probe = new DrizzleDatabaseProbe({ ping } as unknown as Database);
      await expect(probe.ping()).rejects.toThrow('refused');
      up = true;
      await vi.advanceTimersByTimeAsync(PING_REUSE_MS);
      await probe.ping();
      expect(log).toHaveBeenCalledWith('Database available again');
      up = false;
      await vi.advanceTimersByTimeAsync(PING_REUSE_MS);
      await expect(probe.ping()).rejects.toThrow('refused');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      vi.useRealTimers();
    }
  });
});
