/**
 * Port: one release of a product planned at a time, across every process (#527). A release's
 * planning reads the previous release's outputs to reuse them (#497); planned at the same
 * moment as that one on another worker, it would find them half written and render again
 * files the previous release is about to make. One process with one planning at a time had
 * this order by itself; several workers have it through this.
 */
export abstract class PlanningTurns {
  /**
   * Runs `work` once no other planning of `product` runs anywhere, then lets the next one
   * go; waits for the turn until `signal` aborts (rejecting with its reason).
   */
  abstract take<T>(
    product: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
