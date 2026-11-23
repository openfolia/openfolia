import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { ReleaseStore } from '../release-store.js';
import { ReleaseOutputStore } from '../release-output-store.js';
import { ScheduleReleaseOutputsAction } from './schedule-release-outputs.action.js';

/** A release none of whose outputs still to render moved for this long is looked at again. */
export const STALLED_AFTER_MS = 30 * 60_000;
/** At most this many releases per sweep, the longest still first. */
export const SWEPT_PER_RUN = 100;

/**
 * Gives releases whose outputs stopped moving their render jobs again
 * (#497): a release has at most `QUEUED_PER_RELEASE` jobs at a time and
 * each that ends queues the next, so jobs lost without ending their
 * output (cancelled by hand, dropped by the queue, a payload refused)
 * would hold its places for good. For each release whose outputs still
 * to render none moved for `STALLED_AFTER_MS`: the scheduled ones' jobs
 * are queued again (keyed by the output, so a job still there is left as
 * it is) and the release topped up. One merely waiting behind newer
 * releases is looked at too, and nothing changes for it.
 */
@Injectable()
export class SweepReleaseOutputsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly releases: ReleaseStore,
    private readonly schedule: ScheduleReleaseOutputsAction,
  ) {}

  /**
   * The releases looked at. Each sweep goes on after where the last one
   * stopped (the cursor in the database, #527), so every stalled release
   * is looked at in turn however many merely wait behind newer ones (they
   * never move), back to the start after the last, whichever server
   * sweeps. The window is taken by compare-and-swap before it is looked
   * at: a server that loses it to another sweeping at once looks at none.
   */
  async handle({ now }: { now: Date }): Promise<number> {
    const cursor = await this.outputs.sweepCursor();
    const ids = await this.outputs.stalled(
      new Date(now.getTime() - STALLED_AFTER_MS),
      SWEPT_PER_RUN,
      cursor.after,
    );
    const next = ids.length < SWEPT_PER_RUN ? undefined : ids.at(-1);
    if (!(await this.outputs.moveSweepCursor(cursor.version, next))) return 0;
    for (const id of ids) {
      const release = await this.releases.find(id);
      if (!release) continue;
      await this.schedule.repair(release);
      await this.schedule.handle(release);
    }
    return ids.length;
  }
}
