/**
 * Runs tasks one after another, in the order they come, at most `limit` waiting or running:
 * past it a task is refused at once with what `busy` makes (a 503 with `Retry-After`), so
 * piled-up requests never queue without bound. For the checks' renderings (`renderer-busy`)
 * and the chunk sets built for a verdict (`chunk-sets-busy`, #710).
 */
export class OneAtATime {
  #last: Promise<unknown> = Promise.resolve();
  #pending = 0;

  constructor(
    private readonly limit: number,
    private readonly busy: () => Error,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.limit) return Promise.reject(this.busy());
    this.#pending++;
    const result = this.#last.then(task, task).finally(() => this.#pending--);
    this.#last = result.catch(() => undefined);
    return result;
  }
}
