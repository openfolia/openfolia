/**
 * At most `max` tasks at once, in memory on this server. A task past it
 * waits for a slot, at most `waitMs` and with at most `maxWaiting` others;
 * past either, `run` throws what `busy()` makes and the task never runs.
 * A finished task hands its slot straight to the longest waiter, so no
 * newcomer slips in between and exceeds `max`.
 */
export class ConcurrencyLimit {
  #running = 0;
  readonly #waiting: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(
    readonly max: number,
    readonly waitMs: number,
    readonly maxWaiting: number,
    private readonly busy: () => Error,
  ) {}

  /** How many run now (for tests and logs). */
  get running(): number {
    return this.#running;
  }

  /** How many wait for a slot now. */
  get waiting(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < this.max) this.#running++;
    else await this.#wait();
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else {
        this.#running--;
      }
    }
  }

  /** Resolves once a finished task hands this one its slot; rejects past `waitMs` or `maxWaiting`. */
  #wait(): Promise<void> {
    if (this.#waiting.length >= this.maxWaiting) {
      return Promise.reject(this.busy());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const at = this.#waiting.indexOf(waiter);
          if (at >= 0) this.#waiting.splice(at, 1);
          reject(this.busy());
        }, this.waitMs),
      };
      this.#waiting.push(waiter);
    });
  }
}
