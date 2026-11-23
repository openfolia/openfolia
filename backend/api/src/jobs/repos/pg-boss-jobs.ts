import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import {
  type ConstructorOptions,
  fromDrizzle,
  type JobWithMetadata,
  PgBoss,
} from 'pg-boss';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { StartupError } from '../../config/startup-error.js';
import { reason } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type ClaimedJob,
  JOB_HEARTBEAT_SECONDS,
  JobClaims,
} from '../core/job-claims.js';
import { JobHandlers, type JobQueueSpec } from '../core/job-handlers.js';
import {
  type EnqueueOptions,
  isJobPriority,
  type JobInfo,
  JobQueue,
  type JobState,
} from '../core/job-queue.js';
import {
  JobHandler,
  type JobKind,
  type JobPayload,
  MAX_PAYLOAD_BYTES,
} from '../core/job.js';

/** The Postgres schema pg-boss keeps its tables in (beside the app's, never in Drizzle's migrations). */
export const JOBS_SCHEMA = 'pgboss';

/** How much longer than a kind's `timeoutSeconds` pg-boss waits before it expires an attempt itself. */
const EXPIRY_SLACK_SECONDS = 60;
/** The longest pause between retries. */
const MAX_RETRY_DELAY_SECONDS = 60 * 60;
/** The longest key `enqueue` takes. */
const MAX_KEY_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where pg-boss connects: a pool of its own on `CCMS_DATABASE_URL` in the
 * server (`JobsModule`), the test database's PGlite in tests
 * (`tests/test-app.ts`). Its own pool, not the app's: workers polling and
 * heartbeats never wait behind requests for a connection, nor requests
 * behind them.
 */
export abstract class JobsConnection {
  abstract readonly options: ConstructorOptions;
  /** Install or upgrade pg-boss's schema at start (`CCMS_DATABASE_MIGRATE`); else only check its version. */
  abstract readonly migrate: boolean;
}

/** The options every pg-boss instance of the app shares. */
function bossOptions(options: ConstructorOptions): ConstructorOptions {
  return {
    schema: JOBS_SCHEMA,
    application_name: 'openfolia-jobs',
    // Recurring jobs come with their first user.
    schedule: false,
    ...options,
  };
}

/**
 * Installs (or upgrades) pg-boss's schema and returns: for `db-migrate`
 * and the test databases' template. pg-boss holds an advisory lock of its
 * own while it does, so servers starting at once install it once.
 */
export async function installJobQueue(
  options: ConstructorOptions,
): Promise<void> {
  const boss = new PgBoss(
    bossOptions({
      ...options,
      migrate: true,
      supervise: false,
      registerInstance: false,
    }),
  );
  boss.on('error', () => undefined);
  await boss.start();
  await boss.stop({ graceful: false });
}

/**
 * The app's pg-boss instance: started before the server listens, with a
 * queue made (or brought up to date) for every `JobHandler` among the
 * app's providers, which it loads into `JobHandlers`; stopped
 * after the HTTP server, once `JobWorker` has settled what it ran.
 */
@Injectable()
export class PgBossJobs implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private instance?: PgBoss;

  constructor(
    private readonly connection: JobsConnection,
    readonly handlers: JobHandlers,
    private readonly discovery: DiscoveryService,
  ) {}

  get boss(): PgBoss {
    if (!this.instance) throw new Error('The job queue has not started.');
    return this.instance;
  }

  async onModuleInit(): Promise<void> {
    // Every provider is made before any is initialised: all handlers are there.
    this.handlers.load(
      this.discovery
        .getProviders()
        .map((wrapper) => wrapper.instance as unknown)
        .filter(
          (instance): instance is JobHandler => instance instanceof JobHandler,
        ),
    );
    const boss = new PgBoss(
      bossOptions({
        ...this.connection.options,
        migrate: this.connection.migrate,
      }),
    );
    // Unhandled, an `error` event would end the process.
    boss.on('error', (error) =>
      this.logger.error(`Job queue: ${eventReason(error)}`),
    );
    boss.on('warning', (warning) =>
      this.logger.warn(`Job queue: ${warning.message}`),
    );
    try {
      await boss.start();
      // A failed queue first: the kind's queue refers to it.
      const queues = [...this.handlers.queues].sort(
        (a, b) => Number(a.phase === 'run') - Number(b.phase === 'run'),
      );
      for (const queue of queues) await ensureQueue(boss, queue);
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw new StartupError(
        `Cannot start the job queue (pg-boss, schema ${JOBS_SCHEMA}): ${reason(error)}${
          this.connection.migrate
            ? ''
            : ' (CCMS_DATABASE_MIGRATE=false: run db-migrate first)'
        }`,
      );
    }
    this.instance = boss;
  }

  async onApplicationShutdown(): Promise<void> {
    // JobWorker has failed (requeued) what it still ran; pg-boss runs no workers of its own.
    await this.instance?.stop({ graceful: false });
  }
}

/** pg-boss emits some errors as plain objects (`{ ...error, message }`). */
function eventReason(error: unknown): string {
  if (error instanceof Error) return reason(error);
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/** Makes the queue, or brings an existing one's retries and timeouts up to date. */
async function ensureQueue(boss: PgBoss, queue: JobQueueSpec): Promise<void> {
  const { policy } = queue;
  const options = {
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: MAX_RETRY_DELAY_SECONDS,
    expireInSeconds: policy.timeoutSeconds + EXPIRY_SLACK_SECONDS,
    heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
    retentionSeconds: policy.retentionSeconds,
  };
  if (!(await boss.getQueue(queue.name))) {
    await boss.createQueue(queue.name, {
      ...options,
      ...(queue.failedQueue && { deadLetter: queue.failedQueue }),
      // A kind's queue: one job per key at a time. A failed queue takes
      // every copy that lands there.
      policy: queue.phase === 'run' ? 'exclusive' : 'standard',
    });
    return;
  }
  await boss.updateQueue(queue.name, {
    ...options,
    deadLetter: queue.failedQueue ?? null,
  });
}

/** `JobQueue` on pg-boss: a job per kind and key, enqueued in the caller's transaction when given one. */
@Injectable()
export class PgBossJobQueue extends JobQueue {
  constructor(private readonly jobs: PgBossJobs) {
    super();
  }

  async enqueue<P extends JobPayload>(
    kind: JobKind<P>,
    payload: P,
    { key, tx, startAfter, priority }: EnqueueOptions,
  ): Promise<string | undefined> {
    if (!this.jobs.handlers.handles(kind)) {
      throw new Error(`No job handler runs the job kind ${kind.name}.`);
    }
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`A job key has 1 to ${MAX_KEY_LENGTH} characters.`);
    }
    if (priority !== undefined && !isJobPriority(priority)) {
      throw new Error(`Not a job priority: ${priority}.`);
    }
    const data = kind.payload.parse(payload);
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `A ${kind.name} job's payload is larger than ${MAX_PAYLOAD_BYTES} bytes.`,
      );
    }
    const id = await this.jobs.boss.send(kind.name, data, {
      singletonKey: key,
      ...(startAfter && { startAfter }),
      ...(priority !== undefined && { priority }),
      ...(tx && { db: inTransaction(tx) }),
    });
    return id ?? undefined;
  }

  async find(kind: JobKind, id: string): Promise<JobInfo | undefined> {
    if (!UUID.test(id)) return undefined;
    const [job] = await this.jobs.boss.findJobs<object>(kind.name, { id });
    return job && info(job);
  }

  async latest(kind: JobKind, key: string): Promise<JobInfo | undefined> {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) return undefined;
    // pg-boss's findJobs reads oldest first, up to a limit: the newest row
    // directly instead (at most one is open per key, the newest).
    const { rows } = await this.jobs.boss
      .getDb()
      .executeSql(
        `SELECT id, name, singleton_key, state, retry_count, created_on, started_on, completed_on FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on DESC, id DESC LIMIT 1`,
        [kind.name, key],
      );
    const row = rows[0] as LatestRow | undefined;
    return (
      row &&
      info({
        id: row.id,
        name: row.name,
        singletonKey: row.singleton_key,
        state: row.state,
        retryCount: Number(row.retry_count),
        createdOn: new Date(row.created_on),
        startedOn: row.started_on === null ? null : new Date(row.started_on),
        completedOn:
          row.completed_on === null ? null : new Date(row.completed_on),
      } as unknown as JobWithMetadata)
    );
  }

  async openKeys(
    kind: JobKind,
    keys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const valid = keys.filter(
      (k) => k.length > 0 && k.length <= MAX_KEY_LENGTH,
    );
    if (valid.length === 0) return new Set();
    const { rows } = await this.jobs.boss
      .getDb()
      .executeSql(
        `SELECT DISTINCT singleton_key AS key FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND singleton_key = ANY($2::text[]) AND state IN ('created', 'retry', 'active')`,
        [kind.name, valid],
      );
    return new Set((rows as { key: string }[]).map((r) => r.key));
  }

  async prioritize(
    kind: JobKind,
    key: string,
    priority: number,
  ): Promise<boolean> {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
    if (!isJobPriority(priority)) {
      throw new Error(`Not a job priority: ${priority}.`);
    }
    // Only one that waits (`created`, or `retry` between attempts): a running
    // attempt is claimed already, and an ended job is not claimed again.
    const { rows } = await this.jobs.boss
      .getDb()
      .executeSql(
        `UPDATE ${JOBS_SCHEMA}.job SET priority = $3 WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry') AND priority < $3 RETURNING id`,
        [kind.name, key, priority],
      );
    return rows.length > 0;
  }

  async cancel(kind: JobKind, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return affected(await this.jobs.boss.cancel(kind.name, id));
  }
}

/** pg-boss's statements on the caller's Drizzle transaction. */
function inTransaction(tx: Transaction) {
  return fromDrizzle(drizzleOf(tx), sql);
}

const STATES: Record<JobWithMetadata['state'], JobState> = {
  created: 'queued',
  retry: 'retrying',
  active: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** A row of `latest`'s query, as the driver gives it. */
interface LatestRow {
  readonly id: string;
  readonly name: string;
  readonly singleton_key: string | null;
  readonly state: JobWithMetadata['state'];
  readonly retry_count: number | string;
  readonly created_on: Date | string;
  readonly started_on: Date | string | null;
  readonly completed_on: Date | string | null;
}

function info(job: JobWithMetadata): JobInfo {
  const ended =
    job.state === 'completed' ||
    job.state === 'failed' ||
    job.state === 'cancelled';
  return {
    id: job.id,
    kind: job.name,
    key: job.singletonKey,
    state: STATES[job.state],
    // Attempts before the latest, plus the latest if it started (a released one did not).
    attempts: job.retryCount + (job.startedOn ? 1 : 0),
    createdAt: job.createdOn,
    startedAt: job.startedOn ?? null,
    endedAt: ended ? (job.completedOn ?? null) : null,
  };
}

/** `JobClaims` on pg-boss: every settlement fenced to the attempt claimed (`{ id, retryCount }`). */
@Injectable()
export class PgBossJobClaims extends JobClaims {
  constructor(private readonly jobs: PgBossJobs) {
    super();
  }

  async claim(queue: string, limit: number): Promise<ClaimedJob[]> {
    const jobs = await this.jobs.boss.fetch(queue, {
      batchSize: limit,
      includeMetadata: true,
    });
    return jobs.map((job) => ({
      queue,
      id: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      payload: job.data,
    }));
  }

  async complete(job: ClaimedJob): Promise<boolean> {
    return affected(await this.jobs.boss.complete(job.queue, attempt(job)));
  }

  async fail(job: ClaimedJob, message: string): Promise<boolean> {
    return affected(
      await this.jobs.boss.fail(job.queue, attempt(job), { message }),
    );
  }

  async release(job: ClaimedJob): Promise<boolean> {
    // pg-boss has no public, fenced "hand back": its own restore, fenced to
    // the attempt. A job without `started_on` is claimed again at the same
    // retry count, so the attempt is not counted.
    const { rows } = await this.jobs.boss
      .getDb()
      .executeSql(
        `UPDATE ${JOBS_SCHEMA}.job SET state = 'created', started_on = NULL, heartbeat_on = NULL WHERE name = $1 AND id = $2 AND state = 'active' AND retry_count = $3 RETURNING id`,
        [job.queue, job.id, job.retryCount],
      );
    return rows.length > 0;
  }

  async refuse(job: ClaimedJob): Promise<boolean> {
    return affected(await this.jobs.boss.cancel(job.queue, attempt(job)));
  }

  async touch(job: ClaimedJob): Promise<boolean> {
    return affected(await this.jobs.boss.touch(job.queue, attempt(job)));
  }
}

const attempt = (job: ClaimedJob) => ({
  id: job.id,
  retryCount: job.retryCount,
});
/**
 * Whether a command changed a job. pg-boss's `CommandResponse` type is empty;
 * the object carries `affected` (the rows the statement changed).
 */
const affected = (response: unknown): boolean =>
  ((response as { affected?: number }).affected ?? 0) > 0;
