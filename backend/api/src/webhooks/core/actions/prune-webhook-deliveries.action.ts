import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { WebhookStore } from '../webhook-store.js';

/** Deleted per statement. */
export const PRUNE_CHUNK = 1_000;
/** The most one run deletes; the rest waits for the next. */
export const PRUNE_MAX = 20_000;

/**
 * Deletes settled deliveries (succeeded, failed, skipped) made more than
 * `keepDays` ago, `PRUNE_CHUNK` at a time and at most `PRUNE_MAX` per run;
 * pending ones are kept. Answers how many it deleted. Runs for nobody.
 */
@Injectable()
export class PruneWebhookDeliveriesAction implements UnguardedAction {
  readonly policy = 'internal';
  now: () => number = Date.now;

  constructor(private readonly store: WebhookStore) {}

  async handle({ keepDays }: { keepDays: number }): Promise<number> {
    const before = new Date(this.now() - keepDays * 24 * 60 * 60 * 1000);
    let removed = 0;
    while (removed < PRUNE_MAX) {
      const n = await this.store.pruneDeliveries(before, PRUNE_CHUNK);
      removed += n;
      if (n < PRUNE_CHUNK) break;
    }
    return removed;
  }
}
