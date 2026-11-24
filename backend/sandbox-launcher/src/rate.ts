// A token bucket per key: on average `perSecond` requests a second, at most `burst` at once. The
// buckets of keys that are full again are dropped, so the map holds only recent senders.

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    /** At most this many keys are tracked; past it, an unknown key is refused (a flood of them). */
    private readonly maxKeys = 100_000,
  ) {}

  /** Takes one token for `key`: 0 when allowed, else the seconds until one is there. */
  take(key: string): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune();
      if (this.buckets.size >= this.maxKeys) return 1;
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond,
    );
    bucket.at = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.perSecond);
  }

  /** Drops the buckets that are full again: they would allow a whole burst anyway. */
  prune(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const tokens =
        bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond;
      if (tokens >= this.burst) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
