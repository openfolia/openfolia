import { Injectable } from '@nestjs/common';
import { count, eq, gt, lt, max, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import {
  CONSUMER_KEPT_SECONDS,
  CONSUMER_LIVE_SECONDS,
  type ConsumerBeat,
  JobConsumers,
  JobsOverview,
  type JobsStatus,
} from '../core/job-consumers.js';
import { JOBS_SCHEMA, PgBossJobs } from './pg-boss-jobs.js';
import { jobConsumers as t } from './job-consumers.tables.js';

/** `JobConsumers` in `job_consumers`, on the app's database, with the database's clock. */
@Injectable()
export class DrizzleJobConsumers extends JobConsumers {
  constructor(private readonly database: Database) {
    super();
  }

  async beat(beat: ConsumerBeat): Promise<void> {
    const now = sql`now()`;
    await this.database.db
      .insert(t)
      .values({
        id: beat.id,
        role: beat.role,
        host: beat.host.slice(0, 255) || 'unknown',
        pid: beat.pid,
        startedAt: beat.startedAt,
        seenAt: now,
        ...(beat.consumed && { consumedAt: now }),
      })
      .onConflictDoUpdate({
        target: t.id,
        set: {
          seenAt: now,
          ...(beat.consumed && { consumedAt: now }),
        },
      });
    await this.database.db
      .delete(t)
      .where(
        lt(
          t.seenAt,
          sql`now() - make_interval(secs => ${CONSUMER_KEPT_SECONDS})`,
        ),
      );
  }

  async leave(id: string): Promise<void> {
    await this.database.db.delete(t).where(eq(t.id, id));
  }

  /** Live consumers and the last time any consumed, at the database's `now()`. */
  async consumers(): Promise<{
    checkedAt: Date;
    live: number;
    lastConsumedAt: Date | null;
  }> {
    const [row] = await this.database.db
      .select({
        checkedAt: sql<Date>`now()`.mapWith((v: string | Date) => new Date(v)),
        live: count(),
        lastConsumedAt: max(t.consumedAt),
      })
      .from(t)
      .where(
        gt(
          t.seenAt,
          sql`now() - make_interval(secs => ${CONSUMER_LIVE_SECONDS})`,
        ),
      );
    const [last] = await this.database.db
      .select({ at: max(t.consumedAt) })
      .from(t);
    return {
      checkedAt: row?.checkedAt ?? new Date(),
      live: row?.live ?? 0,
      lastConsumedAt: last?.at ?? null,
    };
  }
}

interface QueueRow {
  ready: string | number;
  running: string | number;
  oldest: string | Date | null;
}

/**
 * `JobsOverview`: the consumers from `job_consumers`, the queue from
 * pg-boss's job table (due and waiting: `created` or `retry`, not blocked,
 * `start_after` passed; running: `active`), read on pg-boss's own pool.
 */
@Injectable()
export class PgBossJobsOverview extends JobsOverview {
  constructor(
    private readonly consumers: DrizzleJobConsumers,
    private readonly jobs: PgBossJobs,
  ) {
    super();
  }

  async status(): Promise<JobsStatus> {
    const [consumers, queue] = await Promise.all([
      this.consumers.consumers(),
      this.jobs.boss
        .getDb()
        .executeSql(
          `SELECT count(*) FILTER (WHERE state IN ('created', 'retry') AND NOT blocked AND start_after <= now()) AS ready, count(*) FILTER (WHERE state = 'active') AS running, min(start_after) FILTER (WHERE state IN ('created', 'retry') AND NOT blocked AND start_after <= now()) AS oldest FROM ${JOBS_SCHEMA}.job WHERE state IN ('created', 'retry', 'active')`,
        ),
    ]);
    const row = queue.rows[0] as QueueRow | undefined;
    return {
      checkedAt: consumers.checkedAt,
      consumers: consumers.live,
      lastConsumedAt: consumers.lastConsumedAt,
      ready: Number(row?.ready ?? 0),
      running: Number(row?.running ?? 0),
      oldestReadyAt: row?.oldest ? new Date(row.oldest) : null,
    };
  }
}
