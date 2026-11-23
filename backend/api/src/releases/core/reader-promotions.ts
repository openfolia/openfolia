import type { Actor } from '../../access/core/actor.js';
import { MAX_KEYS, WINDOW_MS } from '../../base/core/rate-limit.js';

/**
 * How many outputs one reader may move up the render queue within a minute (#497), by asking
 * for files not rendered yet, beside the release's own bound (`PROMOTED_PER_RELEASE`): one
 * reader asking for every file of many releases moves no more than this, so another reader's
 * request still finds room ahead. It bounds the moves, not the requests: one that moves
 * nothing costs no place (the stable addresses' and the API's own limits bound requests). Past it, the file waits its turn at its release's priority,
 * and the answer is the same 409 `output-not-ready`, no other error.
 */
export const PROMOTIONS_PER_READER = 4;

/** A place `ReaderPromotions.tryTake` reserved: given back when nothing moved. */
export interface PromotionPlace {
  refund(): void;
}

/**
 * Counts each reader's promotions over a sliding minute, in memory on this server (bounded:
 * at most `perMinute` times per reader and `MAX_KEYS` readers), as the stable addresses' limit
 * does: with several servers a reader may take this many on each, which the per-release bound
 * still caps. A place is reserved before the move is tried, synchronously, so requests of one
 * reader in parallel never all pass the check before any of them counts.
 */
export class ReaderPromotions {
  private readonly takes = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number = PROMOTIONS_PER_READER,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserves one of the reader's places now, or undefined when none is left this minute. */
  tryTake(actor: Actor): PromotionPlace | undefined {
    const key = `${actor.kind}:${actor.id}`;
    const now = this.now();
    const recent = (this.takes.get(key) ?? []).filter(
      (at) => at > now - WINDOW_MS,
    );
    if (recent.length >= this.perMinute) {
      this.takes.set(key, recent);
      return undefined;
    }
    recent.push(now);
    // Re-inserted, so the map's order is by last take: the first key is the one to forget.
    this.takes.delete(key);
    this.takes.set(key, recent);
    if (this.takes.size > MAX_KEYS) {
      const first = this.takes.keys().next();
      if (!first.done) this.takes.delete(first.value);
    }
    let refunded = false;
    return {
      refund: () => {
        if (refunded) return;
        refunded = true;
        const times = this.takes.get(key);
        const at = times?.lastIndexOf(now) ?? -1;
        if (times && at >= 0) times.splice(at, 1);
      },
    };
  }
}
