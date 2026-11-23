/**
 * How often a running attempt says it is alive. The queue declares a
 * heartbeat of three times this (`JOB_HEARTBEAT_SECONDS`): an attempt
 * whose server vanished is given to another server after that.
 */
export const HEARTBEAT_MS = 10_000;
export const JOB_HEARTBEAT_SECONDS = 30;

/** A job a server has claimed and now runs (one attempt of it). */
export interface ClaimedJob {
  /** The queue it came from (`JobQueueSpec.name`). */
  readonly queue: string;
  readonly id: string;
  /** Retries before this attempt: 0 for the first. Fences every settlement to this attempt. */
  readonly retryCount: number;
  /** Retries the job may have in all. */
  readonly retryLimit: number;
  /** As stored: checked against the kind's schema before it is used. */
  readonly payload: unknown;
}

/**
 * Port: claiming and settling jobs, for the jobs worker (`JobWorker`).
 * Every settlement names the attempt it was claimed as: once that attempt
 * has lapsed (the job was cancelled, timed out, or handed to another
 * server after a missed heartbeat), settling it changes nothing and says
 * so (`false`), so a late attempt never overwrites a newer one.
 */
export abstract class JobClaims {
  /** Up to `limit` jobs of the queue that are due, now claimed by this server. */
  abstract claim(queue: string, limit: number): Promise<ClaimedJob[]>;

  /** The attempt succeeded. */
  abstract complete(job: ClaimedJob): Promise<boolean>;

  /** The attempt failed: retried by the queue's policy, or failed for good after the last. */
  abstract fail(job: ClaimedJob, message: string): Promise<boolean>;

  /**
   * Hands the attempt back unrun, without counting it as one: queued
   * again at once, for this server's next start or another server (a
   * shutdown). False once its claim has lapsed.
   */
  abstract release(job: ClaimedJob): Promise<boolean>;

  /** The job is never run (again): its payload cannot be read. */
  abstract refuse(job: ClaimedJob): Promise<boolean>;

  /** The attempt is still running (its heartbeat). False once its claim has lapsed. */
  abstract touch(job: ClaimedJob): Promise<boolean>;
}
