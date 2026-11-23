import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Env } from '../../config/env.js';
import { ServerRole } from '../../config/server-role.js';
import { RunJobAction } from '../core/actions/run-job.action.js';
import {
  type ClaimedJob,
  HEARTBEAT_MS,
  JobClaims,
} from '../core/job-claims.js';
import { CONSUMER_BEAT_MS, JobConsumers } from '../core/job-consumers.js';
import { JobHandlers, type JobQueueSpec } from '../core/job-handlers.js';

/** How long shutdown waits for running attempts before it hands them back to the queue. */
export const SHUTDOWN_WAIT_MS = 5_000;
/** The most jobs one `drain` runs, so a job that keeps queueing itself cannot hang a test. */
export const DRAIN_LIMIT = 1_000;

/** Why an attempt was cut off before its handler finished. */
type Lapse = 'shutdown' | 'timeout' | 'lost';

const LAPSE_MESSAGE: Record<Lapse, string> = {
  shutdown:
    'The server shut down while the job ran; it is queued again, and this attempt does not count.',
  timeout: 'The attempt ran out of time.',
  lost: 'The claim on the job lapsed (cancelled, or given to another server).',
};

interface Running {
  readonly done: Promise<void>;
  /**
   * Cuts the attempt off, then its signal aborts: a timeout is recorded as
   * a failed attempt, a shutdown hands the job back without counting the
   * attempt, a lost claim records nothing (another holds the job).
   */
  readonly lapse: (why: Lapse) => Promise<void>;
}

/**
 * Claims jobs from every queue a handler runs and runs them
 * (`RunJobAction`): each queue is polled every `CCMS_JOBS_POLL_MS`
 * (default 2 s) and again as soon as one of its attempts ends, with at
 * most the kind's `concurrency` attempts at once on this server. 0 runs
 * none here (tests call `drain`; a server may only enqueue, leaving the
 * work to others), and so does the `api` role (`CCMS_ROLE`, #527): only
 * `all` and `worker` consume. Servers side by side share the queues: a job
 * is claimed by one of them. A consuming one records itself in
 * `JobConsumers` every `CONSUMER_BEAT_MS` (and whether it consumed since),
 * and leaves on shutdown, for `GET /jobs/status`.
 *
 * A running attempt sends a heartbeat every `HEARTBEAT_MS`; one whose
 * claim has lapsed is aborted. One that runs past its kind's
 * `timeoutSeconds` is failed (and retried) and aborted. Shutdown claims
 * nothing more (a claim in flight hands its jobs straight back), waits up
 * to `SHUTDOWN_WAIT_MS` for the running ones, then hands the rest back to
 * the queue without counting the attempt, so a deploy never uses up a
 * job's retries, and aborts them. A server that dies without shutting down
 * leaves its attempts to the heartbeat: the queue retries them after
 * `JOB_HEARTBEAT_SECONDS`.
 */
@Injectable()
export class JobWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(JobWorker.name);
  private readonly pollMs: number;
  private readonly running = new Map<string, Running>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Claims in flight, by queue: shutdown waits for them. */
  private readonly polling = new Map<string, Promise<void>>();
  private stopped = false;
  /** This process in `job_consumers` (#527): made at start, never reused. */
  private readonly consumerId = randomUUID();
  private readonly startedAt = new Date();
  private beatTimer?: NodeJS.Timeout;
  private beating?: Promise<void>;
  /** Whether an attempt was claimed since the last beat. */
  private claimedSinceBeat = false;

  constructor(
    private readonly handlers: JobHandlers,
    private readonly claims: JobClaims,
    private readonly runJob: RunJobAction,
    private readonly consumers: JobConsumers,
    private readonly role: ServerRole,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('CCMS_JOBS_POLL_MS', { infer: true });
  }

  /**
   * Whether this process claims jobs: only a `worker` or `all` process
   * (#527; the `api` role only enqueues), and only with polling on.
   */
  get consumes(): boolean {
    return this.pollMs > 0 && this.role.runsBackground;
  }

  onApplicationBootstrap(): void {
    if (!this.consumes) return;
    for (const queue of this.handlers.queues) this.schedule(queue, 0);
    this.beat();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stopConsuming();
    await this.leave();
  }

  private async stopConsuming(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.beatTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // A claim in flight hands what it got back (see poll) before we look.
    await Promise.all(this.polling.values());
    if (this.running.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.running.values()].map((r) => r.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    const left = [...this.running.values()];
    if (left.length === 0) return;
    await Promise.all(left.map((r) => r.lapse('shutdown')));
    this.logger.warn(
      `Shut down with ${left.length} job(s) still running; they are queued again.`,
    );
  }

  /** Removes this process from `job_consumers` once it consumes no more (a clean stop). */
  private async leave(): Promise<void> {
    if (!this.consumes) return;
    await this.beating;
    await this.consumers
      .leave(this.consumerId)
      .catch((error: unknown) =>
        this.logger.warn(
          'Removing this server from the job consumers failed',
          error,
        ),
      );
  }

  /**
   * Records this process as consuming (`job_consumers`), now and every
   * `CONSUMER_BEAT_MS`: seen, and consumed when it claimed or ran an
   * attempt since the last beat. A failed beat is logged; the next tries
   * again.
   */
  private beat(): void {
    if (this.stopped) return;
    const consumed = this.claimedSinceBeat || this.running.size > 0;
    this.claimedSinceBeat = false;
    this.beating = this.consumers
      .beat({
        id: this.consumerId,
        role: this.role.name === 'worker' ? 'worker' : 'all',
        host: hostname(),
        pid: process.pid,
        startedAt: this.startedAt,
        consumed,
      })
      .catch((error: unknown) => {
        if (consumed) this.claimedSinceBeat = true;
        this.logger.warn(
          'Recording this server as a job consumer failed',
          error,
        );
      })
      .finally(() => {
        this.beating = undefined;
        if (this.stopped) return;
        this.beatTimer = setTimeout(() => this.beat(), CONSUMER_BEAT_MS);
        this.beatTimer.unref();
      });
  }

  /**
   * Runs every job that is due, one at a time, until none is left (at
   * most `DRAIN_LIMIT`), and says how many ran: the synchronous seam for
   * tests, which set `CCMS_JOBS_POLL_MS=0`. The same claiming and
   * settling as the timer's.
   */
  async drain(): Promise<number> {
    let ran = 0;
    for (;;) {
      let claimed = false;
      for (const queue of this.handlers.queues) {
        if (this.stopped || ran >= DRAIN_LIMIT) return ran;
        const [job] = await this.claims.claim(queue.name, 1);
        if (!job) continue;
        claimed = true;
        ran++;
        await this.execute(queue, job);
      }
      if (!claimed) return ran;
    }
  }

  private schedule(queue: JobQueueSpec, delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(queue.name));
    const timer = setTimeout(() => void this.poll(queue), delay);
    // Never keeps the process alive on its own.
    timer.unref();
    this.timers.set(queue.name, timer);
  }

  private poll(queue: JobQueueSpec): Promise<void> {
    if (this.stopped || this.polling.has(queue.name)) return Promise.resolve();
    const polling = this.claimAndRun(queue).finally(() => {
      this.polling.delete(queue.name);
      this.schedule(queue, this.pollMs);
    });
    this.polling.set(queue.name, polling);
    return polling;
  }

  private async claimAndRun(queue: JobQueueSpec): Promise<void> {
    try {
      const free = queue.policy.concurrency - this.runningIn(queue.name);
      if (free <= 0) return;
      const jobs = await this.claims.claim(queue.name, free);
      if (jobs.length > 0) this.claimedSinceBeat = true;
      for (const job of jobs) {
        if (this.stopped) {
          // Shutdown began while claiming: back to the queue, unrun.
          await this.claims
            .release(job)
            .catch((error: unknown) =>
              this.logger.error(`Handing back job ${job.id} failed`, error),
            );
          continue;
        }
        // As soon as one ends, look for the next.
        void this.execute(queue, job).finally(() => this.schedule(queue, 0));
      }
    } catch (error) {
      this.logger.error(`Claiming jobs of ${queue.name} failed`, error);
    }
  }

  private runningIn(queue: string): number {
    let count = 0;
    for (const key of this.running.keys()) {
      if (key.startsWith(`${queue} `)) count++;
    }
    return count;
  }

  /** One attempt, settled exactly once: by its outcome, or by whatever cut it off first. */
  private execute(queue: JobQueueSpec, job: ClaimedJob): Promise<void> {
    // Per attempt: a retry may be claimed here while a cut-off attempt that
    // ignores its signal still runs; each keeps its own entry.
    const key = `${queue.name} ${job.id} ${job.retryCount}`;
    const what = `job ${job.id} (${queue.name}, attempt ${job.retryCount + 1})`;
    const abort = new AbortController();
    let ended = false;
    // Both timers are made below; stopTimers only runs after that.
    const stopTimers = () => {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    };

    const lapse = async (why: Lapse): Promise<void> => {
      if (ended) return;
      ended = true;
      stopTimers();
      // Recorded before the handler hears of it, so its own late settling finds nothing to settle.
      const record =
        why === 'timeout'
          ? this.claims.fail(job, LAPSE_MESSAGE[why])
          : why === 'shutdown'
            ? this.claims.release(job)
            : undefined;
      await record?.catch((error: unknown) =>
        this.logger.error(`Recording that ${what} was cut off failed`, error),
      );
      this.logger.warn(`${what}: ${LAPSE_MESSAGE[why]}`);
      abort.abort(new Error(LAPSE_MESSAGE[why]));
    };

    const heartbeat = setInterval(() => {
      this.claims.touch(job).then(
        (alive) => {
          if (!alive) void lapse('lost');
        },
        // A database hiccup is not a lost claim: the next beat tries again.
        (error: unknown) =>
          this.logger.warn(`Heartbeat of ${what} failed`, error),
      );
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const deadline = setTimeout(
      () => void lapse('timeout'),
      queue.policy.timeoutSeconds * 1_000,
    );
    deadline.unref();

    const done = (async () => {
      try {
        const result = await this.runJob.handle(job, abort.signal);
        if (ended) {
          this.logger.warn(`${what} ended after its attempt was cut off.`);
          return;
        }
        ended = true;
        stopTimers();
        await this.settle(job, what, result);
      } catch (error) {
        this.logger.error(`Settling ${what} failed`, error);
      } finally {
        stopTimers();
        this.running.delete(key);
      }
    })();
    this.running.set(key, { done, lapse });
    return done;
  }

  private async settle(
    job: ClaimedJob,
    what: string,
    result: Awaited<ReturnType<RunJobAction['handle']>>,
  ): Promise<void> {
    switch (result.outcome) {
      case 'done':
        await this.claims.complete(job);
        return;
      case 'failed': {
        await this.claims.fail(job, result.message);
        const next =
          job.retryCount >= job.retryLimit ? 'failed for good' : 'retried';
        this.logger.warn(`${what} failed (${next}): ${result.message}`);
        return;
      }
      case 'refused':
        await this.claims.refuse(job);
        this.logger.error(
          result.reason === 'payload'
            ? `${what} not run: its payload is not what its kind takes.`
            : `${what} not run: no handler runs its queue.`,
        );
        return;
    }
  }
}
