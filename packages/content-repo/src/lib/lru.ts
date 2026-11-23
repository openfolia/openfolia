/** How many values heavier than the capacity a `pinOversized` cache keeps at most, one per group. */
export const PINNED_KEPT = 8;

/**
 * A small least-recently-used cache bounded by total weight (bytes, or 1 per entry); `weigh`
 * gets the key too, for a weight in bytes that counts it. A value heavier than the capacity is
 * not kept, unless `pinOversized` names its group (a folder, for whole-folder indexes): then
 * the newest such value of each group is kept beside the others, outside the capacity (at most
 * `PINNED_KEPT` groups, the one set longest ago forgotten first), so a large `modules/` index
 * stays however other folders are read in between.
 */
export class Lru<V> {
  private readonly map = new Map<string, { value: V; weight: number }>();
  private total = 0;
  /** The oversized values kept, by group: newest set last. */
  private readonly pinned = new Map<
    string,
    { key: string; value: V; weight: number }
  >();

  constructor(
    readonly capacity: number,
    private readonly weigh: (value: V, key: string) => number = () => 1,
    private readonly options: {
      readonly pinOversized?: (key: string) => string;
    } = {},
  ) {}

  /** The weight kept within the capacity: at most `capacity`. */
  get weight(): number {
    return this.total;
  }

  /** The weight of the oversized values kept besides (`pinOversized`). */
  get pinnedWeight(): number {
    let n = 0;
    for (const p of this.pinned.values()) n += p.weight;
    return n;
  }

  /** How many entries are kept. */
  get size(): number {
    return this.map.size + this.pinned.size;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return this.pinnedEntry(key)?.value;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  delete(key: string): void {
    this.unpin(key);
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.weight;
  }

  has(key: string): boolean {
    return this.map.has(key) || this.pinnedEntry(key) !== undefined;
  }

  set(key: string, value: V): void {
    const weight = this.weigh(value, key);
    this.delete(key);
    if (weight > this.capacity) {
      const group = this.options.pinOversized?.(key);
      if (group === undefined) return;
      this.pinned.delete(group);
      this.pinned.set(group, { key, value, weight });
      if (this.pinned.size > PINNED_KEPT) {
        const first = this.pinned.keys().next();
        if (!first.done) this.pinned.delete(first.value);
      }
      return;
    }
    this.map.set(key, { value, weight });
    this.total += weight;
    for (const [k, e] of this.map) {
      if (this.total <= this.capacity) break;
      this.map.delete(k);
      this.total -= e.weight;
    }
  }

  private pinnedEntry(
    key: string,
  ): { key: string; value: V; weight: number } | undefined {
    if (!this.options.pinOversized || this.pinned.size === 0) return undefined;
    const found = this.pinned.get(this.options.pinOversized(key));
    return found?.key === key ? found : undefined;
  }

  private unpin(key: string): void {
    const group = this.options.pinOversized?.(key);
    if (group !== undefined && this.pinned.get(group)?.key === key) {
      this.pinned.delete(group);
    }
  }
}
