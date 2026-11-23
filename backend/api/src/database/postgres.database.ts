import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { StartupError } from '../config/startup-error.js';
import {
  Database,
  type Drizzle,
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
  reason,
  retryOnLockTimeout,
  withTimeout,
} from './database.js';
import * as schema from './schema.js';

/** How long opening a connection may take before it counts as failed. */
const CONNECT_TIMEOUT_MS = 5_000;

/** How long the first query on start may take (a server that accepts but never answers). */
const STARTUP_PING_TIMEOUT_MS = 10_000;

/** How long releasing a session advisory lock may take before its connection is just closed. */
const SESSION_UNLOCK_TIMEOUT_MS = 5_000;

/** How long migrating waits for another process's migration before failing. */
const MIGRATION_LOCK_TIMEOUT = '120s';

/** What `connect` takes besides the URL (`CCMS_DATABASE_*`). */
export interface PostgresOptions {
  /** Most pool connections. */
  poolMax: number;
  /** How long a migration statement waits for a table lock, in ms. */
  lockTimeoutMs: number;
  /** Runs of a migration that keeps hitting that timeout. */
  migrateAttempts: number;
}

const DEFAULT_OPTIONS: PostgresOptions = {
  poolMax: 10,
  lockTimeoutMs: 10_000,
  migrateAttempts: 3,
};

/**
 * Key of the advisory lock held while migrating, so that several servers
 * starting at once (or `db-migrate` next to a server) apply each migration
 * once. Any fixed number; it only has to be the same everywhere.
 */
const MIGRATION_LOCK = 7_301_946_118;

/** `Database` over a node-postgres pool, for `CCMS_DATABASE_URL`. */
export class PostgresDatabase extends Database {
  readonly db: Drizzle;

  private readonly pool: pg.Pool;

  private constructor(
    /** Connection settings, for the pool and for pings. */
    private readonly config: pg.ClientConfig,
    readonly target: string,
    private readonly options: PostgresOptions,
  ) {
    super();
    this.pool = new pg.Pool({ ...config, max: options.poolMax });
    // An idle connection that breaks (database restart, network) emits
    // `error` on the pool; unhandled, that would end the process. The pool
    // drops the connection and opens a new one on the next query.
    this.pool.on('error', (error) =>
      Logger.warn(
        `Idle database connection to ${target} failed: ${error.message}`,
        'Database',
      ),
    );
    this.db = drizzle({ client: this.pool, schema });
  }

  /**
   * Opens a pool and checks that the database answers. Fails with a
   * `StartupError` naming the server and database (never the password)
   * when it cannot be reached or refuses the credentials.
   */
  static async connect(
    url: string,
    options: Partial<PostgresOptions> = {},
  ): Promise<PostgresDatabase> {
    const target = describeTarget(url);
    const database = new PostgresDatabase(
      {
        connectionString: url,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        // Notices a peer that vanished (network partition) on idle connections.
        keepAlive: true,
      },
      target,
      { ...DEFAULT_OPTIONS, ...options },
    );
    try {
      await database.ping(STARTUP_PING_TIMEOUT_MS);
    } catch (error) {
      await database.close().catch(() => undefined);
      throw new StartupError(
        `Cannot use the database ${target} (CCMS_DATABASE_URL): ${reason(error)}`,
      );
    }
    return database;
  }

  /**
   * On a connection of its own, outside the pool, ended when the answer is
   * late: a hung database (a server that stopped answering, a network
   * partition) never holds a pool connection, and a full pool never makes
   * the database look down. The deadline covers connecting too.
   */
  override async ping(timeoutMs: number): Promise<void> {
    const client = new pg.Client(this.config);
    // An unhandled `error` (a reset socket) would end the process; the
    // failure reaches us through connect() or the query instead.
    client.on('error', ignore);
    try {
      await withTimeout(
        (async () => {
          await client.connect();
          await client.query('select 1');
        })(),
        timeoutMs,
      );
    } catch (error) {
      throw new Error(reason(error), { cause: error });
    } finally {
      // Destroys the socket mid-query; mid-handshake it is closed politely,
      // and pg's connectionTimeoutMillis (CONNECT_TIMEOUT_MS) bounds that.
      client.end().catch(() => undefined);
    }
  }

  /**
   * Migrates on a connection of its own, holding a session-level advisory
   * lock. The connection is destroyed afterwards instead of going back to
   * the pool, so the lock never outlives it. Needs a direct connection (or
   * a session-mode pooler), not a transaction pooler. A statement that
   * waits longer than `lockTimeoutMs` for a table lock fails the attempt
   * (Drizzle migrates in one transaction, so it rolls back); the attempt
   * is repeated, with a growing pause and the advisory lock kept, up to
   * `migrateAttempts` times. Waiting for the advisory lock is not repeated.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    // Unhandled, a reset socket would end the process; the queries fail too.
    client.on('error', (error) =>
      Logger.warn(`Migration connection failed: ${error.message}`, 'Database'),
    );
    try {
      await client.query(`set lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
      // A DDL statement waiting for a table lock queues every later query
      // on that table behind it: give up soon instead.
      await client.query(
        `set lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}`,
      );
      await retryOnLockTimeout(
        this.options.migrateAttempts,
        () =>
          migrate(drizzle({ client }), {
            migrationsFolder: MIGRATIONS_FOLDER,
            migrationsSchema: MIGRATIONS_TABLE.schema,
            migrationsTable: MIGRATIONS_TABLE.table,
          }),
        (attempt, delayMs) =>
          Logger.warn(
            `Migration waited more than ${this.options.lockTimeoutMs} ms for a table lock on ${this.target} (attempt ${attempt} of ${this.options.migrateAttempts}); trying again in ${delayMs} ms`,
            'Database',
          ),
      );
    } finally {
      client.release(true);
    }
  }

  /**
   * On a connection of its own, outside the pool (a long `work` never takes a pool
   * connection away from requests): `pg_advisory_lock(key, hashtext(name))`, waiting in
   * Postgres's queue (first come, first served, #527) until it is held or `signal` aborts (the
   * wait cancelled with `pg_cancel_backend`), then `work`, then the unlock. A connection lost meanwhile takes the lock with it: `work` goes on, and
   * another process may take its turn (each use is idempotent, so that costs work, not
   * correctness). Needs a direct connection or a session-mode pooler, as migrating does.
   */
  override async withSessionLock<T>(
    key: number,
    name: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = new pg.Client(this.config);
    let lost = false;
    // A dropped connection must not end the process; the lock went with it.
    client.on('error', () => {
      lost = true;
    });
    try {
      await client.connect();
      // Waits in Postgres's own queue for the lock (#527): waiters are granted it in the order
      // they asked, first come, first served, so a job that waited longest goes next instead of
      // whichever polls first. An abort cancels the wait: `pg_cancel_backend` from the pool, and
      // only while this session (its real pid and start, read here, never the driver's key,
      // which a pooler makes up) still waits for an advisory lock. Not cancelled that way (not
      // waiting yet, a cancel refused), the connection is ended, which ends the wait too. A lock
      // granted at the same moment is released below like any other.
      // The wait is one long statement and the session sits idle during `work`: a server's or
      // role's timeouts must not end either (this connection is private and ended afterwards).
      await client.query(
        'set statement_timeout = 0; set lock_timeout = 0; set idle_session_timeout = 0; set idle_in_transaction_session_timeout = 0',
      );
      const self = await client.query<{ pid: number; since: string }>(
        'select pid, backend_start::text as since from pg_stat_activity where pid = pg_backend_pid()',
      );
      const { pid, since } = self.rows[0] ?? {};
      let locked = false;
      const cancel = () => {
        void this.pool
          .query<{ cancelled: boolean }>(
            `select pg_cancel_backend(pid) as cancelled from pg_stat_activity
             where pid = $1::int4 and backend_start::text = $2 and wait_event_type = 'Lock' and wait_event = 'advisory'`,
            [pid, since],
          )
          .then(
            (r) => r.rows[0]?.cancelled === true,
            () => false,
          )
          .then((cancelled) => {
            if (cancelled || locked) return;
            Logger.warn(
              `The wait for the advisory lock ${key}/${name} was not cancelled; ending its connection.`,
              'Database',
            );
            void client.end().catch(() => undefined);
          });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        signal?.throwIfAborted();
        await client.query(
          'select pg_advisory_lock($1::int4, hashtext($2::text))',
          [key, name],
        );
        locked = true;
      } catch (error) {
        if (signal?.aborted) throw signal.reason as Error;
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
      try {
        signal?.throwIfAborted();
        return await work();
      } finally {
        // Aborted, the turn was not used: ending the connection below releases the lock (an
        // in-flight cancel could otherwise land on the unlock).
        if (!lost && !signal?.aborted) {
          // Bounded: ending the connection below releases the lock too, once the server notices it gone.
          const unlocked = await withTimeout(
            client.query<{ unlocked: boolean }>(
              'select pg_advisory_unlock($1::int4, hashtext($2::text)) as unlocked',
              [key, name],
            ),
            SESSION_UNLOCK_TIMEOUT_MS,
          ).then(
            (r) => r.rows[0]?.unlocked === true,
            () => false,
          );
          if (!unlocked) {
            Logger.warn(
              `The advisory lock ${key}/${name} was not released on its own connection; closing it. Behind a transaction-mode pooler it may stay held: use a direct connection or a session-mode pooler.`,
              'Database',
            );
          }
        }
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Whether queries wait for a free pool connection. */
  override saturated(): boolean {
    return this.pool.waitingCount > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** `host:port/database` of a connection URL, without user or password. */
export function describeTarget(url: string): string {
  const generic = 'at CCMS_DATABASE_URL';
  try {
    const { username, password, hostname, port, pathname, searchParams } =
      new URL(url);
    // A password with an unescaped `/`, `?` or `#` parses as host, path or fragment, and the
    // label would show part of it: when an `@` isn't accounted for as user info, name nothing.
    if (url.includes('@') && !username && !password) return generic;
    // As the driver reads it: query parameters win over the URL's own.
    const host = searchParams.get('host') || hostname || 'localhost';
    const at = searchParams.get('port') || port || '5432';
    const label = `${host}:${at}${decodeURIComponent(pathname)}`;
    return label.includes('@') ? generic : label;
  } catch {
    return generic;
  }
}

/** For clients whose failures surface through their own calls. */
function ignore(): void {
  // Nothing: see ping().
}
