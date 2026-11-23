/**
 * Results kept for a short while, least recently made dropped first past
 * `max`: for checks, which depend on a commit and what the reader sees on
 * it (the key) and on the blob store (not in the key, hence the time
 * limit). Paging and filtering the same checks then reads them once. A
 * result that fails is not kept; asks for a key still being worked out
 * share it.
 */
export class Fresh<V> {
  readonly #entries = new Map<string, { made: number; value: Promise<V> }>();

  constructor(
    readonly max: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, make: () => Promise<V>): Promise<V> {
    const found = this.#entries.get(key);
    if (found && this.now() - found.made < this.ttlMs) return found.value;
    this.#entries.delete(key);
    const entry = { made: this.now(), value: make() };
    this.#entries.set(key, entry);
    entry.value.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return entry.value;
  }
}

/** How many sets of checks are kept, and for how long. */
export const CHECKS_KEPT = 32;
export const CHECKS_TTL_MS = 30_000;

/** A cache key from parts that may hold `|`. */
export const keyOf = (...parts: readonly string[]): string =>
  parts.map((part) => part.replaceAll('|', '||')).join('|');
