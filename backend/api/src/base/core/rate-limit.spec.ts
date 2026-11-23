import { MAX_KEYS, SlidingWindowLimit, WINDOW_MS } from './rate-limit.js';

describe('SlidingWindowLimit', () => {
  it('counts takes per key within a minute, then says when the next one fits', () => {
    let now = 1_000_000;
    const limit = new SlidingWindowLimit(2, () => now);
    expect(limit.take('a')).toEqual({ ok: true });
    now += 10_000;
    expect(limit.take('a')).toEqual({ ok: true });
    expect(limit.take('b')).toEqual({ ok: true });
    now += 5_000;
    // The first take leaves the window 45 s from now.
    expect(limit.take('a')).toEqual({ ok: false, retryAfterSeconds: 45 });
    now = 1_000_000 + WINDOW_MS + 1;
    expect(limit.take('a')).toEqual({ ok: true });
    expect(limit.take('a')).toEqual({ ok: false, retryAfterSeconds: 10 });
  });

  it('never says less than a second', () => {
    let now = 0;
    const limit = new SlidingWindowLimit(1, () => now);
    limit.take('a');
    now = WINDOW_MS - 1;
    expect(limit.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('forgets the least recently used key past MAX_KEYS', () => {
    const now = 0;
    const limit = new SlidingWindowLimit(1, () => now);
    for (let i = 0; i <= MAX_KEYS; i++) limit.take(`k${i}`);
    // k0 was forgotten, so it may take again; k1 was not.
    expect(limit.take('k0').ok).toBe(true);
    expect(limit.take(`k${MAX_KEYS}`).ok).toBe(false);
  });

  it('says whether a take would fit without counting one', () => {
    let now = 0;
    const limit = new SlidingWindowLimit(2, () => now);
    expect(limit.retryAfter('a')).toBeUndefined();
    limit.take('a');
    expect(limit.retryAfter('a')).toBeUndefined();
    expect(limit.retryAfter('a')).toBeUndefined();
    limit.take('a');
    now = 15_000;
    expect(limit.retryAfter('a')).toBe(45);
    expect(limit.retryAfter('b')).toBeUndefined();
    now = WINDOW_MS + 1;
    expect(limit.retryAfter('a')).toBeUndefined();
    expect(limit.take('a')).toEqual({ ok: true });
  });
});
