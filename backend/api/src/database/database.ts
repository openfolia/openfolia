import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

/**
 * What `db.execute()` returns: the drivers' results differ, but both carry
 * the rows (node-postgres `QueryResult`, PGlite `Results`).
 */
export interface QueryResultHKT extends PgQueryResultHKT {
  type: QueryResult<this['row']>;
}
interface QueryResult<Row> {
  rows: Row[];
}

/** Drizzle over Postgres (node-postgres in the server, PGlite in tests). */
export type Drizzle = PgDatabase<QueryResultHKT, typeof schema>;

/**
 * The committed drizzle-kit migrations (`backend/api/migrations`). The same
 * two levels up from `src/database/` (tests) and `dist/database/` (build).
 */
export const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
);

/** The journal time of the newest committed migration (drizzle-kit's `when`), if any. */
export function newestMigrationTime(): number | undefined {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { when: number }[] };
  return journal.entries.at(-1)?.when;
}

/** Where Drizzle records the migrations it applied (its defaults, named once). */
export const MIGRATIONS_TABLE = {
  schema: 'drizzle',
  table: '__drizzle_migrations',
};

/**
 * The application's database. Inject it in `repos/` adapters and use `db`;
 * `core/` never sees it (a lint rule holds that). `DatabaseModule` provides
 * the Postgres one; tests use `createTestDatabase()` (`tests/database.ts`).
 */
export abstract class Database {
  abstract readonly db: Drizzle;

  /** Which database this is, without credentials, for log and error messages. */
  abstract readonly target: string;

  /** Applies the migrations not applied yet, in order. */
  abstract migrate(): Promise<void>;

  /**
   * Whether queries are waiting for a free connection, i.e. the pool is
   * exhausted. A database without a pool never is.
   */
  saturated(): boolean {
    return false;
  }

  /**
   * Whether a migration of `MIGRATIONS_FOLDER` is not applied yet (#527:
   * a `worker` never migrates and waits for this to be false). Drizzle
   * applies one only when its journal time is later than the last one
   * applied, so comparing the newest of each tells.
   */
  async migrationsPending(): Promise<boolean> {
    const newest = newestMigrationTime();
    if (newest === undefined) return false;
    const exists = await this.db.execute<{ table: string | null }>(
      sql`select to_regclass(${`${MIGRATIONS_TABLE.schema}.${MIGRATIONS_TABLE.table}`})::text as table`,
    );
    if (!exists.rows[0]?.table) return true;
    const applied = await this.db.execute<{ at: string | number | null }>(
      sql`select max(created_at) as at from ${sql.identifier(MIGRATIONS_TABLE.schema)}.${sql.identifier(MIGRATIONS_TABLE.table)}`,
    );
    const at = applied.rows[0]?.at;
    return at === null || at === undefined || Number(at) < newest;
  }

  /** The turns `withSessionLock` hands out here, by key (a database of one connection). */
  readonly #turns = new Map<string, Promise<unknown>>();

  /**
   * Runs `work` holding the session advisory lock (`key`, `hashtext(name)`): across every
   * process on this database, one `work` per key and name at a time (#527: release planning,
   * per product). Waits for its turn, first come, first served, until `signal` aborts
   * (rejecting with its reason). This default is for a database of one
   * connection in one process (PGlite in tests): turns within this process.
   * `PostgresDatabase` holds the lock on a connection of its own, outside the pool.
   */
  async withSessionLock<T>(
    key: number,
    name: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const id = `${key}|${name}`;
    const before = this.#turns.get(id) ?? Promise.resolve();
    const mine = before.then(
      () => (signal?.throwIfAborted(), work()),
      () => (signal?.throwIfAborted(), work()),
    );
    const tail = mine.catch(() => undefined);
    this.#turns.set(id, tail);
    try {
      return await mine;
    } finally {
      if (this.#turns.get(id) === tail) this.#turns.delete(id);
    }
  }

  /** Ends every connection; the database is unusable afterwards. */
  abstract close(): Promise<void>;

  /**
   * Resolves once the database has answered a query within `timeoutMs`;
   * rejects with the driver's reason (or the timeout) otherwise.
   */
  async ping(timeoutMs: number): Promise<void> {
    try {
      await withTimeout(this.db.execute(sql`select 1`), timeoutMs);
    } catch (error) {
      throw new Error(reason(error), { cause: error });
    }
  }
}

/**
 * The driver's own reason for a failure: Drizzle wraps it in `cause`
 * ("Failed query: select 1"), and connecting to "localhost" fails once per
 * address (an `AggregateError`). Driver messages hold no credentials.
 */
export function reason(error: unknown, depth = 0): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map((e: unknown) => reason(e, depth + 1)).join('; ');
  }
  if (error instanceof Error) {
    // Bounded: a cause chain may loop.
    if (error.cause !== undefined && depth < 10) {
      return reason(error.cause, depth + 1);
    }
    return error.message || (error as { code?: string }).code || error.name;
  }
  return String(error);
}

/** `promise`, or a rejection once `ms` have passed (the work itself is not cancelled). */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Postgres' error code for `lock_timeout` ("lock_not_available"). */
const LOCK_NOT_AVAILABLE = '55P03';

/** Whether `error`, or something it was caused by, is a lock timeout. */
export function isLockTimeout(error: unknown, depth = 0): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((e: unknown) => isLockTimeout(e, depth + 1));
  }
  if (!(error instanceof Error) || depth >= 10) return false;
  return (
    (error as { code?: string }).code === LOCK_NOT_AVAILABLE ||
    isLockTimeout(error.cause, depth + 1)
  );
}

/**
 * Postgres' error codes for a statement that waited or ran too long:
 * `lock_not_available` (`lock_timeout`) and `query_canceled`
 * (`statement_timeout`).
 */
const TIMED_OUT = new Set([LOCK_NOT_AVAILABLE, '57014']);

/** Whether `error`, or something it was caused by, is such a timeout. */
export function isTimedOut(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth >= 10) return false;
  return (
    TIMED_OUT.has((error as { code?: string }).code ?? '') ||
    isTimedOut(error.cause, depth + 1)
  );
}

/**
 * Postgres' error codes for a transaction broken off because it contended
 * with another: `serialization_failure` and `deadlock_detected`.
 */
const CONTENDED = new Set(['40001', '40P01']);

/** Whether `error`, or something it was caused by, is such a failure. */
export function isContended(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth >= 10) return false;
  return (
    CONTENDED.has((error as { code?: string }).code ?? '') ||
    isContended(error.cause, depth + 1)
  );
}

/** Pause before attempt `attempt + 1`: 1 s, 2 s, 4 s ... at most 15 s. */
export const lockRetryDelayMs = (attempt: number): number =>
  Math.min(1_000 * 2 ** (attempt - 1), 15_000);

/**
 * Runs `work`, and again (up to `attempts` runs, with a growing pause) while
 * it fails with a lock timeout: a long transaction on a table the migration
 * changes ends sooner or later, and the migration rolled back, so trying
 * again is safe. Any other failure, or the last one, is thrown.
 */
export async function retryOnLockTimeout(
  attempts: number,
  work: () => Promise<void>,
  onRetry: (attempt: number, delayMs: number) => void = () => undefined,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isLockTimeout(error)) throw error;
      const delay = lockRetryDelayMs(attempt);
      onRetry(attempt, delay);
      await sleep(delay);
    }
  }
}
