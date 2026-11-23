import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import {
  FailedAuthentications,
  MAX_TRACKED_CLIENTS,
} from './failed-authentications.js';

const config = (max: number, windowMs = 60_000) =>
  ({
    get: (key: string) => (key === 'CCMS_AUTH_FAILURES_MAX' ? max : windowMs),
  }) as unknown as ConfigService<Env, true>;

describe('FailedAuthentications', () => {
  it('refuses a client past the limit until its window ends', () => {
    const failures = new FailedAuthentications(config(3));
    let now = 1_000_000;
    failures.now = () => now;
    for (let i = 0; i < 3; i++) {
      expect(failures.retryAfter('a')).toBeUndefined();
      failures.fail('a');
    }
    expect(failures.retryAfter('a')).toBe(60);
    // Another client is not affected.
    expect(failures.retryAfter('b')).toBeUndefined();
    now += 30_500;
    expect(failures.retryAfter('a')).toBe(30);
    now += 30_000;
    expect(failures.retryAfter('a')).toBeUndefined();
  });

  it('with a limit of 0, never refuses', () => {
    const failures = new FailedAuthentications(config(0));
    for (let i = 0; i < 100; i++) failures.fail('a');
    expect(failures.retryAfter('a')).toBeUndefined();
  });

  it('tracks a bounded number of clients', () => {
    const failures = new FailedAuthentications(config(1));
    failures.now = () => 0;
    for (let i = 0; i <= MAX_TRACKED_CLIENTS; i++) failures.fail(`c${i}`);
    // The oldest made room; the newest is held.
    expect(failures.retryAfter('c0')).toBeUndefined();
    expect(failures.retryAfter(`c${MAX_TRACKED_CLIENTS}`)).toBe(60);
  });
});
