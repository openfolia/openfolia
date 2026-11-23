/**
 * Whether a read started earlier may still write what it read: true until the generation it
 * started in has ended.
 */
export type Live = () => boolean;

/**
 * A guard for a cache that is read asynchronously and forgotten when what it depends on changes
 * (the person acting, the tag or ref it was read at): a read takes a `Live` check when it starts
 * and writes its result only while that check holds. `start` ends the generation before it (the
 * latest read wins), `join` takes part in the current one without ending it (reads side by side)
 * and `end` ends the current one without starting a read (`forget()`), so no read started before
 * either ever lands afterwards, whatever order the answers come in.
 *
 * ```ts
 * const live = this.reads.start();
 * const found = await read();
 * if (live()) this.cache.set(found);
 * ```
 */
export class Generation {
  private current = 0;

  /** Starts a read: every read started before it is stale from now on. */
  start(): Live {
    const mine = ++this.current;
    return () => mine === this.current;
  }

  /**
   * Joins the current generation without ending it: for reads that run side by side (updates of
   * several change sets, say) and go stale only together, at the next `start` or `end`.
   */
  join(): Live {
    const mine = this.current;
    return () => mine === this.current;
  }

  /** Ends the current generation: every read started so far is stale from now on. */
  end(): void {
    this.current++;
  }
}
