/**
 * Applies pending migrations and exits: `pnpm nx run api:db-migrate`, or
 * `node dist/database/migrate.main.js` in a deployment that migrates
 * before starting servers (with `CCMS_DATABASE_MIGRATE=false` on them).
 * Reads only the `CCMS_DATABASE_*` settings and loads only the database code
 * and the job queue's installer (pg-boss's schema).
 */
import { z } from 'zod';
import { DatabaseEnv } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
import { installJobQueue } from '../jobs/repos/pg-boss-jobs.js';
import { reason } from './database.js';
import { openDatabase } from './open-database.js';

async function main(): Promise<void> {
  const settings = DatabaseEnv.omit({ CCMS_DATABASE_MIGRATE: true }).safeParse(
    process.env,
  );
  if (!settings.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(settings.error)}`,
    );
  }
  // The same path as the server's start: connect, migrate under the lock.
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  await database.close();
  // The job queue's schema (pg-boss's own, beside Drizzle's), so servers started with
  // CCMS_DATABASE_MIGRATE=false find it in place.
  try {
    await installJobQueue({
      connectionString: settings.data.CCMS_DATABASE_URL,
      max: 1,
    });
  } catch (error) {
    throw new StartupError(
      `Cannot install the job queue in ${database.target}: ${reason(error)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
