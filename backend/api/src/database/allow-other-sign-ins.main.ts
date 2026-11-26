/**
 * Turns "Require single sign-on" (#378) off from the server's command line, for an identity
 * provider that is gone and no break-glass account to sign in with:
 * `pnpm nx run api:allow-other-sign-ins` (in a deployment
 * `node dist/database/allow-other-sign-ins.main.js`).
 */
import { z } from 'zod';
import { DatabaseEnv } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
import { allowOtherSignInsLocally } from '../settings/repos/allow-other-sign-ins-locally.js';
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
  // pnpm and node pass a `--` separator on to the script; nx drops it.
  if (process.argv.slice(2).some((arg) => arg !== '--')) {
    throw new StartupError('Usage: allow-other-sign-ins');
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    console.error(
      (await allowOtherSignInsLocally(database))
        ? 'Single sign-on is no longer required. Everyone is signed out and may sign in again in any way the server offers.'
        : 'Single sign-on is not required here; nothing changed.',
    );
  } catch (error) {
    // The first line only: a database error's parameters hold personal data.
    throw new StartupError(
      error instanceof Error
        ? (error.message.split('\n', 1)[0] ?? error.name)
        : 'unknown error',
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
