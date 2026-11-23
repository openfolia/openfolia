import { Logger } from '@nestjs/common';
import type { DatabaseSettings } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
import { type Database, reason } from './database.js';
import { PostgresDatabase } from './postgres.database.js';

/**
 * Connects to `CCMS_DATABASE_URL` and, unless `CCMS_DATABASE_MIGRATE` is
 * false, applies pending migrations before the server accepts requests.
 * Failing either stops start-up with a `StartupError`.
 */
export async function openDatabase(
  config: Pick<
    DatabaseSettings,
    'CCMS_DATABASE_URL' | 'CCMS_DATABASE_MIGRATE'
  > &
    Partial<DatabaseSettings> & {
      /**
       * Instead of migrating, wait at most this long for the migrations to
       * be applied by another process (#527: a `worker`, which never
       * migrates, waits for the API's).
       */
      waitForMigrationsMs?: number;
    },
  connect: (url: string) => Promise<Database> = (url) =>
    PostgresDatabase.connect(url, {
      ...(config.CCMS_DATABASE_POOL_MAX !== undefined && {
        poolMax: config.CCMS_DATABASE_POOL_MAX,
      }),
      ...(config.CCMS_DATABASE_LOCK_TIMEOUT_MS !== undefined && {
        lockTimeoutMs: config.CCMS_DATABASE_LOCK_TIMEOUT_MS,
      }),
      ...(config.CCMS_DATABASE_MIGRATE_ATTEMPTS !== undefined && {
        migrateAttempts: config.CCMS_DATABASE_MIGRATE_ATTEMPTS,
      }),
    }),
): Promise<Database> {
  const database = await connect(config.CCMS_DATABASE_URL);
  if (config.waitForMigrationsMs !== undefined) {
    await waitForMigrations(database, config.waitForMigrationsMs);
    return database;
  }
  if (!config.CCMS_DATABASE_MIGRATE) return database;
  try {
    await database.migrate();
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new StartupError(
      `Cannot migrate the database ${database.target}: ${reason(error)}`,
    );
  }
  Logger.log(`Migrations applied to ${database.target}`, 'Database');
  return database;
}

/** How often `waitForMigrations` looks again. */
const MIGRATION_POLL_MS = 2_000;

/**
 * Resolves once every committed migration is applied; a `StartupError`
 * (the database closed) when they are not within `timeoutMs`, or the
 * database cannot say.
 */
async function waitForMigrations(
  database: Database,
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  let logged = false;
  for (;;) {
    let pending: boolean;
    try {
      pending = await database.migrationsPending();
    } catch (error) {
      await database.close().catch(() => undefined);
      throw new StartupError(
        `Cannot read the migrations applied to ${database.target}: ${reason(error)}`,
      );
    }
    if (!pending) return;
    if (Date.now() >= until) {
      await database.close().catch(() => undefined);
      throw new StartupError(
        `The database ${database.target} is not migrated to this version, and a worker never migrates (CCMS_ROLE=worker): start the API, or run db-migrate, first.`,
      );
    }
    if (!logged) {
      Logger.log(
        `Waiting for the migrations to be applied to ${database.target} (by the API or db-migrate)`,
        'Database',
      );
      logged = true;
    }
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_POLL_MS));
  }
}
