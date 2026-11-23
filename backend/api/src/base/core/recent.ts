/** A weight bound for `Recent` (#684): what the kept results may weigh together. */
export interface RecentWeight<V> {
  /** The most the kept results may weigh together; the newest one is kept whatever it weighs. */
  readonly maxWeight: number;
  /** A result's weight (for example the characters it holds), worked out once it is made. */
  readonly weigh: (value: V) => number;
}

/**
 * The results of the last `max` keys asked for, least recently used
 * dropped first: for derived data that never changes for its key (a key
 * naming commits, never a branch). A result that fails is not kept, so the
 * next ask tries again; asks for a key still being worked out share it.
 *
 * With `bound` (#684), the kept results also weigh at most `maxWeight` together: once a result
 * is made, the least recently used others are dropped until they do. A result still being made
 * weighs nothing until it is; one heavier than `maxWeight` on its own is kept alone, until the
 * next is made.
 */
export class Recent<V> {
  readonly #entries = new Map<string, Promise<V>>();
  /** The weight of each kept result made so far (with `bound` only). */
  readonly #weights = new Map<string, number>();
  #weight = 0;

  constructor(
    readonly max: number,
    private readonly bound?: RecentWeight<V>,
  ) {}

  get(key: string, make: () => Promise<V>): Promise<V> {
    const found = this.#entries.get(key);
    if (found) {
      this.#entries.delete(key);
      this.#entries.set(key, found);
      return found;
    }
    const made = make();
    this.#entries.set(key, made);
    made.then(
      (value) => {
        if (this.#entries.get(key) === made) this.#weighed(key, value);
      },
      () => {
        if (this.#entries.get(key) === made) this.#delete(key);
      },
    );
    this.#trim();
    return made;
  }

  /** The result kept for `key` (moved to the most recent), or undefined. */
  peek(key: string): Promise<V> | undefined {
    const found = this.#entries.get(key);
    if (found) {
      this.#entries.delete(key);
      this.#entries.set(key, found);
    }
    return found;
  }

  /** Keeps `value` for `key`, as `get` keeps what it made. */
  set(key: string, value: V): void {
    this.#delete(key);
    this.#entries.set(key, Promise.resolve(value));
    this.#weighed(key, value);
    this.#trim();
  }

  /** Forgets everything kept. */
  clear(): void {
    this.#entries.clear();
    this.#weights.clear();
    this.#weight = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** What the kept results weigh together (0 without `bound`). */
  get weight(): number {
    return this.#weight;
  }

  /** Drops the least recently used while more than `max` are kept. */
  #trim(): void {
    while (this.#entries.size > this.max) {
      this.#delete(this.#entries.keys().next().value as string);
    }
  }

  /** Records `key`'s weight, then drops the least recently used others past `maxWeight`. */
  #weighed(key: string, value: V): void {
    if (!this.bound) return;
    const weight = this.bound.weigh(value);
    this.#weights.set(key, weight);
    this.#weight += weight;
    // Least recently used first: `#entries` holds that order (a hit moves to its end).
    for (const other of [...this.#entries.keys()]) {
      if (this.#weight <= this.bound.maxWeight) break;
      if (other !== key && this.#weights.has(other)) this.#delete(other);
    }
  }

  #delete(key: string): void {
    this.#entries.delete(key);
    const weight = this.#weights.get(key);
    if (weight === undefined) return;
    this.#weights.delete(key);
    this.#weight -= weight;
  }
}
