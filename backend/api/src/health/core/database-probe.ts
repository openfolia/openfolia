/** Port: whether the database answers. */
export abstract class DatabaseProbe {
  /** Resolves when the database answered in time; rejects otherwise. */
  abstract ping(): Promise<void>;

  /** Whether queries wait for a free connection (the pool is exhausted). */
  abstract saturated(): boolean;
}
