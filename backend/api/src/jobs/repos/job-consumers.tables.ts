import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The processes consuming jobs (#527): one row per `worker` or `all`
 * process, written by its beat (`DrizzleJobConsumers`), so the `api` role
 * and the admin overview can tell whether jobs are taken. Operational
 * state only: a row quiet for a day is removed, and a clean shutdown
 * removes its own.
 */
export const jobConsumers = pgTable(
  'job_consumers',
  {
    id: uuid('id').primaryKey(),
    role: text('role').notNull(),
    host: text('host').notNull(),
    pid: integer('pid').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
    /** When it last claimed or ran a job; null until it has. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('job_consumers_role', sql`${t.role} in ('all', 'worker')`),
    check('job_consumers_host', sql`char_length(${t.host}) between 1 and 255`),
    check('job_consumers_pid', sql`${t.pid} >= 0`),
    index('job_consumers_seen').on(t.seenAt),
  ],
);
