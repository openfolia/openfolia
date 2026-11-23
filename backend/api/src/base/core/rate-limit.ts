/** The window a `SlidingWindowLimit` counts over: a minute. */
export const WINDOW_MS = 60_000;

/** How many keys a limit keeps at most; past that, the oldest is forgotten. */
export const MAX_KEYS = 10_000;

/**
 * At most `limit` takes per key within any minute (a sliding window over
 * the times of the takes), in memory on this server. `take` either counts
 * a take or says how many seconds until the next one fits. Bounded: at
 * most `limit` times per key and `MAX_KEYS` keys.
 */
export class SlidingWindowLimit {
  private readonly takes = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a take for `key`; else the seconds to wait (at least 1). */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const recent = this.recent(key, now);
    if (recent.length >= this.limit) {
      this.takes.set(key, recent);
      return { ok: false, retryAfterSeconds: this.wait(recent, now) };
    }
    recent.push(now);
    // Re-inserted, so the map's order is by last take: the first key is the
    // one to forget.
    this.takes.delete(key);
    this.takes.set(key, recent);
    if (this.takes.size > MAX_KEYS) {
      const first = this.takes.keys().next();
      if (!first.done) this.takes.delete(first.value);
    }
    return { ok: true };
  }

  /**
   * Whether a take for `key` would fit now, without counting one: undefined when it would,
   * else the seconds to wait (at least 1). Changes nothing, so a caller may ask before
   * deciding whether the work it guards is needed at all.
   */
  retryAfter(key: string): number | undefined {
    const now = this.now();
    const recent = this.recent(key, now);
    return recent.length >= this.limit ? this.wait(recent, now) : undefined;
  }

  private recent(key: string, now: number): number[] {
    return (this.takes.get(key) ?? []).filter((at) => at > now - WINDOW_MS);
  }

  /** Until the oldest take leaves the window, in whole seconds, at least 1. */
  private wait(recent: readonly number[], now: number): number {
    const oldest = recent[0] as number;
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  }
}
