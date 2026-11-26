/**
 * Removes a person's second factor (#611) from the server's command line, for an administrator
 * who lost their phone and recovery codes with nobody else to reset it:
 * `pnpm nx run api:reset-second-factor -- <email>` (in a deployment
 * `node dist/database/reset-second-factor.main.js <email>`).
 */
import { z } from 'zod';
import { resetSecondFactorLocally } from '../access/repos/reset-second-factor-locally.js';
import { DatabaseEnv } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
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
  const [email, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  if (email === undefined || rest.length > 0) {
    throw new StartupError('Usage: reset-second-factor <email>');
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    const userId = await resetSecondFactorLocally(database, email);
    console.error(
      `Two-factor sign-in is off for "${userId}": they sign in without a code now, and set it up again where it is required.`,
    );
  } catch (error) {
    // The first line only: a database error's parameters hold the address.
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
