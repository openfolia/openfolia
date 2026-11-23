import type { Transaction } from '../../base/core/unit-of-work.js';
import type { JobKind, JobPayload } from './job.js';

/** How `JobQueue.enqueue` queues a job. */
export interface EnqueueOptions {
  /**
   * What the job works on (an output row's ID, an import's ID): at most
   * one job per kind and key is queued or running at a time, so enqueueing
   * the same work twice (a retried request, two servers) makes one job.
   * Once that job has ended, the key is free again.
   */
  readonly key: string;
  /**
   * Queues it inside this transaction: it exists once the transaction
   * commits, and never when it rolls back, together with the rows that
   * describe its work (the release, its output rows).
   */
  readonly tx?: Transaction;
  /** Not before this time. */
  readonly startAfter?: Date;
  /**
   * Which of a kind's due jobs is claimed first: the higher, the sooner
   * (a whole number from 0, the default, to `MAX_JOB_PRIORITY`); among
   * equals, the oldest. Per kind: each kind's queue is claimed on its own.
   */
  readonly priority?: number;
}

/** The highest `EnqueueOptions.priority` (Postgres's largest integer). */
export const MAX_JOB_PRIORITY = 2 ** 31 - 1;

/** Whether `priority` is one `EnqueueOptions.priority` takes. */
export const isJobPriority = (priority: number): boolean =>
  Number.isInteger(priority) && priority >= 0 && priority <= MAX_JOB_PRIORITY;

/** Where a job stands. */
export type JobState =
  'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'cancelled';

/** A job as `JobQueue.find` reports it. */
export interface JobInfo {
  readonly id: string;
  readonly kind: string;
  readonly key: string | null;
  readonly state: JobState;
  /** Attempts started so far (0 while it has never run). */
  readonly attempts: number;
  readonly createdAt: Date;
  /** When its latest attempt started. */
  readonly startedAt: Date | null;
  /** When it was done, failed for good or cancelled. */
  readonly endedAt: Date | null;
}

/**
 * Port: background jobs that survive restarts (`pg-boss` on the
 * database). Producers enqueue; the jobs component runs each with its
 * kind's `JobHandler` on whichever server claims it. Not visible to API
 * clients: a component shows its work's progress in its own resources
 * (an import's state, a release's output rows), behind its own
 * permissions, and decides who may cancel it.
 */
export abstract class JobQueue {
  /**
   * Queues one job; its ID, or `undefined` when a job of this kind and
   * key is already queued or running (nothing was added). The payload is
   * checked against the kind's schema and its size (`MAX_PAYLOAD_BYTES`)
   * first; a payload that fails either is a programming error and throws.
   */
  abstract enqueue<P extends JobPayload>(
    kind: JobKind<P>,
    payload: P,
    options: EnqueueOptions,
  ): Promise<string | undefined>;

  /**
   * Raises the priority of the job of this kind and key that waits (queued,
   * or waiting to retry) to `priority`, for work someone now waits for;
   * one already that high, running or ended is left alone. Whether it
   * changed one.
   */
  abstract prioritize(
    kind: JobKind,
    key: string,
    priority: number,
  ): Promise<boolean>;

  /** The job, or `undefined` for an unknown (or malformed) ID or one already cleaned up. */
  abstract find(kind: JobKind, id: string): Promise<JobInfo | undefined>;

  /**
   * The newest job of this kind and key (queued, running or ended), or
   * `undefined` when there is none (never enqueued, or already cleaned
   * up): for a component that shows whether its work is still under way.
   */
  abstract latest(kind: JobKind, key: string): Promise<JobInfo | undefined>;

  /**
   * Which of `keys` have a job of this kind that has not ended (queued, running or waiting to
   * retry), in one query however many keys: for a component that tells how much of its work is
   * ahead of one (#497) or does it in order (#527).
   */
  abstract openKeys(
    kind: JobKind,
    keys: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /**
   * Cancels a job that has not ended: it is not run (again). An attempt
   * running now is told to stop at its next heartbeat (`signal`). False
   * when there was nothing to cancel.
   */
  abstract cancel(kind: JobKind, id: string): Promise<boolean>;
}
