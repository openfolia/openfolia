import { z } from 'zod';
import { field, flag, wholeNumber } from './fields.js';

/**
 * A `postgres://` or `postgresql://` URL with a host and a database name.
 * The messages never repeat the value: it usually holds a password.
 */
const postgresUrl = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      // A host, or a Unix socket folder as `?host=/path`.
      (url.hostname !== '' || url.searchParams.has('host')) &&
      url.pathname.length > 1
    );
  }, 'must be a URL like postgres://user:password@host:5432/database');

/**
 * The database settings: part of `Env`, and all `db-migrate` reads (so it
 * loads nothing else of the server).
 */
export const DatabaseEnv = z.object({
  CCMS_DATABASE_URL: field(postgresUrl),
  /** Apply pending migrations on start; off when a deployment runs `db-migrate` itself. */
  CCMS_DATABASE_MIGRATE: field(flag.default(true)),
  /** Most connections the server's pool opens; past it, queries wait (and `/health/ready` says so). */
  CCMS_DATABASE_POOL_MAX: field(wholeNumber(1, 500).default(10)),
  /** How long a migration statement waits for a table lock before that attempt rolls back. */
  CCMS_DATABASE_LOCK_TIMEOUT_MS: field(wholeNumber(1, 600_000).default(10_000)),
  /** How often a migration that hit the lock timeout is tried again (with backoff) before start-up fails. */
  CCMS_DATABASE_MIGRATE_ATTEMPTS: field(wholeNumber(1, 20).default(3)),
  /**
   * How long a statement of a write transaction that holds rows others
   * wait for (a save point, an abandon, a lock break) waits for a row or
   * table lock (`SET LOCAL lock_timeout`); past it, 503 `database-timeout`.
   */
  CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS: field(
    wholeNumber(1, 600_000).default(5_000),
  ),
  /** How long one statement of such a transaction may run (`SET LOCAL statement_timeout`). */
  CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: field(
    wholeNumber(1, 600_000).default(30_000),
  ),
});

/** The database settings, as parsed. */
export type DatabaseSettings = z.infer<typeof DatabaseEnv>;
