/**
 * How often a process consuming jobs says it is there (`JobConsumers.beat`).
 * One is counted as live while its last beat is less than
 * `CONSUMER_LIVE_SECONDS` old (four beats), and its row is removed once it
 * has been quiet for `CONSUMER_KEPT_SECONDS` (it stopped without saying so).
 */
export const CONSUMER_BEAT_MS = 15_000;
export const CONSUMER_LIVE_SECONDS = 60;
export const CONSUMER_KEPT_SECONDS = 24 * 60 * 60;

/**
 * Jobs waiting this long with no consumer having consumed for as long are
 * a warning (`JobsStatus.level`): no worker takes them.
 */
export const STALL_SECONDS = 5 * 60;

/** One process consuming jobs (a `worker` or `all`), as its beat records it. */
export interface ConsumerBeat {
  /** Made at the process's start; never reused. */
  readonly id: string;
  readonly role: 'all' | 'worker';
  /** The host it runs on (a container's host name), for the overview. */
  readonly host: string;
  readonly pid: number;
  readonly startedAt: Date;
  /** Whether it claimed or ran an attempt since its last beat. */
  readonly consumed: boolean;
}

/**
 * Port: who consumes the job queue (#527). Every consuming process beats
 * (`beat`), so the `api` role, which consumes none, can tell whether jobs
 * are taken at all. Times are the database's, so no server's clock decides.
 */
export abstract class JobConsumers {
  /**
   * Records the process as seen now (and as having consumed now when
   * `consumed`), and removes the rows quiet for `CONSUMER_KEPT_SECONDS`.
   */
  abstract beat(beat: ConsumerBeat): Promise<void>;
  /** Removes the process's row (a clean shutdown). */
  abstract leave(id: string): Promise<void>;
}

/** Where the job queue stands, as `JobsOverview.status` reads it. */
export interface JobsStatus {
  /** The database's time of the reading. */
  readonly checkedAt: Date;
  /** Consuming processes heard from within `CONSUMER_LIVE_SECONDS`. */
  readonly consumers: number;
  /** When any consuming process last claimed or ran a job; null for never (or long ago). */
  readonly lastConsumedAt: Date | null;
  /** Jobs due and waiting to be claimed. */
  readonly ready: number;
  /** Attempts running now. */
  readonly running: number;
  /** Since when the longest-waiting due job is due; null when none waits. */
  readonly oldestReadyAt: Date | null;
}

/** Port: reads the job queue's state for the overview and the worker's health. */
export abstract class JobsOverview {
  abstract status(): Promise<JobsStatus>;
}

/** Seconds the longest-waiting due job has waited (0 when none waits): the queue's lag. */
export function lagSeconds(status: JobsStatus): number {
  if (!status.oldestReadyAt) return 0;
  return Math.max(
    0,
    Math.floor(
      (status.checkedAt.getTime() - status.oldestReadyAt.getTime()) / 1000,
    ),
  );
}

/**
 * `warning` when due jobs have waited longer than `STALL_SECONDS` and no
 * consumer has consumed for as long: nothing takes them (no worker runs,
 * or every one is stuck). Else `ok`.
 */
export function levelOf(status: JobsStatus): 'ok' | 'warning' {
  if (status.ready === 0 || lagSeconds(status) < STALL_SECONDS) return 'ok';
  const consumedAgo =
    status.lastConsumedAt === null
      ? Infinity
      : (status.checkedAt.getTime() - status.lastConsumedAt.getTime()) / 1000;
  return consumedAgo >= STALL_SECONDS ? 'warning' : 'ok';
}
