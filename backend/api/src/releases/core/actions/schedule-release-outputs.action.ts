import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import type { Release } from '../release.js';
import {
  PROMOTED_PER_RELEASE,
  PROMOTED_PRIORITY,
  QUEUED_PER_RELEASE,
  releasePriority,
  outputJob,
  type ReleaseOutput,
} from '../release-output.js';
import { ReleaseOutputStore } from '../release-output-store.js';

/**
 * Keeps a release's render jobs topped up (#497): planning writes every
 * output's row, but only `QUEUED_PER_RELEASE` of them get a job at a time
 * (`ReleaseOutputStore.schedule`); each render that ends (done, failed,
 * or found finished already) queues the next, at the release's priority
 * (`releasePriority`: the newest release first). So the job queue stays
 * small however many releases wait, and a new release's files never wait
 * behind every older release's.
 *
 * Idempotent: it only ever fills the release up to the limit, so running
 * it again (a retried job, two servers) queues nothing twice; and each
 * job is keyed by its output, so one queued already is not queued again.
 */
@Injectable()
export class ScheduleReleaseOutputsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly jobs: JobQueue,
    private readonly unit: UnitOfWork,
  ) {}

  /** Tops the release up, in one transaction (the outputs marked and their jobs); how many it queued. */
  handle(release: Release): Promise<number> {
    return this.unit.run(async (tx) => {
      const next = await this.outputs.schedule(
        tx,
        release.id,
        QUEUED_PER_RELEASE,
      );
      for (const output of next) {
        await this.enqueue(output, releasePriority(release), tx);
      }
      return next.length;
    });
  }

  /**
   * Queues again the jobs of the release's scheduled outputs that have
   * none (#497): a job lost or ended without moving its output (cancelled
   * by hand, its payload refused) would otherwise hold one of the
   * release's places forever. Planning it again runs this; a job that is
   * there already is left as it is (keyed by the output).
   */
  async repair(release: Release): Promise<void> {
    for (const output of await this.outputs.scheduled(release.id)) {
      await this.enqueue(
        output,
        // One moved up keeps its place ahead.
        output.promotedAt === null
          ? releasePriority(release)
          : PROMOTED_PRIORITY,
      );
    }
  }

  /**
   * Someone waits for this output now (#497: its file was asked for before
   * it was rendered): it goes ahead of every release's bulk work, at
   * `PROMOTED_PRIORITY`, queued now if it was still waiting for its turn,
   * else its job's priority raised. Bounded: at most
   * `PROMOTED_PER_RELEASE` of a release's unfinished outputs are moved up
   * at a time (under the release's lock), so asking for every file of a
   * backlog moves only that many; the rest wait their turn. Nothing for
   * one that is not queued or was moved up already. Whether it moved it.
   */
  async now(output: ReleaseOutput): Promise<boolean> {
    if (output.state !== 'queued') return false;
    let moved = false;
    const raise = await this.unit.run(async (tx) => {
      const promoted = await this.outputs.promote(
        tx,
        output.id,
        PROMOTED_PER_RELEASE,
      );
      if (!promoted) return false;
      moved = true;
      if (!promoted.scheduled) return true;
      // Queued now; a job there already (keyed by the output) is raised.
      return (
        (await this.enqueue(promoted.output, PROMOTED_PRIORITY, tx)) ===
        undefined
      );
    });
    if (raise) {
      await this.jobs.prioritize(
        outputJob(output),
        output.id,
        PROMOTED_PRIORITY,
      );
    }
    return moved;
  }

  private enqueue(
    output: ReleaseOutput,
    priority: number,
    tx?: Transaction,
  ): Promise<string | undefined> {
    return this.jobs.enqueue(
      outputJob(output),
      { outputId: output.id, retries: output.retries },
      { key: output.id, priority, ...(tx && { tx }) },
    );
  }
}
