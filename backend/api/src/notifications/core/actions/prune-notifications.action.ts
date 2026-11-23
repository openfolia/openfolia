import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { NotificationStore } from '../notification-store.js';

/** How many notifications one delete takes; a run repeats it up to `MAX_PRUNE_ROUNDS` times. */
export const PRUNE_BATCH = 1_000;
export const MAX_PRUNE_ROUNDS = 20;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Retention: deletes notifications read more than `keepDays` ago
 * (`CCMS_NOTIFICATIONS_KEEP_DAYS`, default 90), so one read today is kept
 * that long however old its event. Unread ones are kept however old. In batches, so a run never
 * holds many rows at once; what is left waits for the next run. Runs for
 * nobody: `NotificationsConsumer` starts it.
 */
@Injectable()
export class PruneNotificationsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(private readonly store: NotificationStore) {}

  async handle({
    keepDays,
    now = Date.now(),
  }: {
    readonly keepDays: number;
    readonly now?: number;
  }): Promise<number> {
    const before = new Date(now - keepDays * DAY_MS);
    let removed = 0;
    for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
      const count = await this.store.removeReadBefore(before, PRUNE_BATCH);
      removed += count;
      if (count < PRUNE_BATCH) break;
    }
    return removed;
  }
}
