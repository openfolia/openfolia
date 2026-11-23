import type { z } from 'zod';

/** A job kind's name: lowercase words joined by `.` (`release.outputs`, `import.apply`). */
export const JOB_KIND_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** What a job carries: a small JSON object of IDs, never content or secrets. */
export type JobPayload = Record<string, unknown>;

/** The largest payload `enqueue` takes, as JSON (16 KiB): a job names its work, it doesn't hold it. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * One kind of background job: its name, the schema of its payload and how
 * it is retried. Defined by the component whose work it is (in its
 * `core/`), with `defineJob`, and run by that component's `JobHandler`.
 */
export interface JobKind<P extends JobPayload = JobPayload> {
  readonly name: string;
  /**
   * Checked when a job is enqueued and again before it runs: a stored
   * payload is data, and one this server cannot read (a different
   * version wrote it, someone edited the row) never reaches the handler.
   */
  readonly payload: z.ZodType<P>;
  /** Retries after the first attempt (default 3); 0: one attempt only. */
  readonly retryLimit: number;
  /** The pause before the first retry, doubled for each one after it, with jitter (default 10 s). */
  readonly retryDelaySeconds: number;
  /** How long one attempt may run before it is stopped and counts as failed (default 15 min). */
  readonly timeoutSeconds: number;
  /** How many jobs of this kind one server runs at once (default 1). */
  readonly concurrency: number;
  /**
   * How long a job may wait (queued, or waiting to retry) before the queue
   * drops it (default 14 days, pg-boss's), without a `failed` call: a kind
   * whose jobs may wait long behind others keeps them longer.
   */
  readonly retentionSeconds: number;
}

/** The longest `timeoutSeconds`: the queue's own expiry adds a minute, and pg-boss takes at most a day. */
export const MAX_TIMEOUT_SECONDS = 86_400 - 60;

/** `defineJob`'s defaults. */
export const JOB_DEFAULTS = {
  retryLimit: 3,
  retryDelaySeconds: 10,
  timeoutSeconds: 15 * 60,
  concurrency: 1,
  retentionSeconds: 14 * 86_400,
} as const;

/** A job kind, with the defaults for what it leaves out. */
export function defineJob<P extends JobPayload>(
  kind: Pick<JobKind<P>, 'name' | 'payload'> &
    Partial<Omit<JobKind<P>, 'name' | 'payload'>>,
): JobKind<P> {
  if (!JOB_KIND_NAME.test(kind.name)) {
    throw new Error(`Not a job kind name: ${kind.name}`);
  }
  const defined = { ...JOB_DEFAULTS, ...kind };
  const whole = (n: number, min: number, max: number) =>
    Number.isInteger(n) && n >= min && n <= max;
  if (
    !whole(defined.retryLimit, 0, 100) ||
    !whole(defined.retryDelaySeconds, 1, 86_400) ||
    !whole(defined.timeoutSeconds, 1, MAX_TIMEOUT_SECONDS) ||
    !whole(defined.concurrency, 1, 100) ||
    !whole(defined.retentionSeconds, 60, 10 * 365 * 86_400)
  ) {
    throw new Error(`Job kind ${kind.name}: a setting is out of range.`);
  }
  return Object.freeze(defined);
}

/** What a handler is told about the attempt it runs. */
export interface JobContext {
  /** The job's ID (a UUID). */
  readonly id: string;
  /** 1 for the first attempt, 2 for the first retry, … */
  readonly attempt: number;
  /** Whether a failure now is final (no retry follows; `failed` is called next). */
  readonly lastAttempt: boolean;
  /**
   * Aborted when this attempt must stop: the server shuts down, the
   * attempt ran out of time, or its claim lapsed (the job was cancelled,
   * or given to another server after a missed heartbeat). The attempt has
   * then already been recorded as failed and will be retried; whatever
   * the handler still does may run twice.
   */
  readonly signal: AbortSignal;
}

/**
 * Runs the jobs of one kind. A Nest provider in its component's module;
 * the jobs component finds every one at start-up.
 *
 * Jobs run **at least once**: an attempt cut off by a crash, a shutdown
 * or a timeout runs again, and its own effects may have happened already.
 * So `run` is idempotent: it reads the current state first and moves it
 * by compare-and-swap (e.g. an output row from `queued` to `done`), and
 * never trusts the payload beyond the IDs it names: it reads what they
 * name again, and acts as the service actor its component defines, never
 * as whoever caused the job.
 */
export abstract class JobHandler<P extends JobPayload = JobPayload> {
  abstract readonly kind: JobKind<P>;

  /**
   * How many of the kind's jobs one server runs at once, when a setting
   * decides it (`CCMS_RENDER_CONCURRENCY`); left out, the kind's own
   * `concurrency`. Read once, as the jobs component starts.
   */
  readonly concurrency?: number;

  /**
   * One attempt. Resolving: done. Throwing: failed, retried by the kind's
   * policy; the error's name and message are kept with the job and logged,
   * so they never hold a secret or content. Heed `signal`: an attempt
   * that keeps running after it is cut off holds one of the kind's
   * `concurrency` slots on this server until it ends.
   */
  abstract run(payload: P, context: JobContext): Promise<void>;

  /**
   * Called once a job has failed for good: its last attempt threw, ran
   * out of time, or its server vanished. For marking what it worked on as
   * failed, so nothing waits for it forever. Optional; it is itself
   * retried when it throws, so it must be idempotent too.
   */
  failed?(payload: P): Promise<void>;
}
