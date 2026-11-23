import { describe, expect, it } from 'vitest';
import { rateLimitWait, retryingGh } from '../gh-api.mjs';

describe('rateLimitWait', () => {
  it('waits out the secondary rate limit, doubling per retry', () => {
    expect(
      rateLimitWait('HTTP 403: You have exceeded a secondary rate limit', 0),
    ).toBe(60_000);
    expect(
      rateLimitWait('HTTP 403: You have exceeded a secondary rate limit', 2),
    ).toBe(240_000);
    expect(rateLimitWait('HTTP 429 retry-after: 7', 0)).toBe(7_000);
  });

  it('does not retry other failures', () => {
    expect(rateLimitWait('HTTP 404: Not Found', 0)).toBeNull();
    expect(rateLimitWait('HTTP 403: API rate limit exceeded', 0)).toBeNull();
  });
});

describe('retryingGh', () => {
  it('retries a rate-limited call, then returns its answer', () => {
    let calls = 0;
    const gh = retryingGh(
      () => {
        calls++;
        if (calls === 1) throw new Error('HTTP 429 retry-after: 1');
        return 'ok';
      },
      { sleep: () => undefined, log: () => undefined },
    );
    expect(gh(['api', 'user'])).toBe('ok');
    expect(calls).toBe(2);
  });
});
