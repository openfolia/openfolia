/**
 * Issues a service account's token from the server's command line and
 * prints it, once: `pnpm nx run api:service-token -- <service-account>
 * [--role <role>]… [--name <what for>] [--days <1-366>]` (in a deployment
 * `node backend/api/dist/database/service-token.main.js …`). Creates the
 * service account with the roles given when it does not exist. For the
 * first service account where nobody can sign in yet; afterwards, use
 * Admin. Applies pending migrations first. Reads only `CCMS_DATABASE_URL`.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { issueTokenLocally } from '../access/repos/issue-token-locally.js';
import { DatabaseEnv } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
import { openDatabase } from './open-database.js';

const USAGE =
  'Usage: service-token <service-account> [--role <role>]... [--name <what for>] [--days <1-366>]';

async function main(): Promise<void> {
  const settings = DatabaseEnv.omit({ CCMS_DATABASE_MIGRATE: true }).safeParse(
    process.env,
  );
  if (!settings.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(settings.error)}`,
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      // pnpm and node pass a `--` separator on to the script; nx drops it.
      args: process.argv.slice(2).filter((arg) => arg !== '--'),
      allowPositionals: true,
      options: {
        role: { type: 'string', multiple: true },
        name: { type: 'string' },
        days: { type: 'string' },
      },
    });
  } catch {
    throw new StartupError(USAGE);
  }
  const [account, ...rest] = parsed.positionals;
  const days =
    parsed.values.days === undefined ? undefined : Number(parsed.values.days);
  if (
    account === undefined ||
    rest.length > 0 ||
    (days !== undefined && !Number.isInteger(days))
  ) {
    throw new StartupError(USAGE);
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    const { token, expiresAt } = await issueTokenLocally(database, {
      serviceAccountId: account,
      name: parsed.values.name ?? 'issued on the command line',
      roleIds: parsed.values.role ?? [],
      ...(days !== undefined && { days }),
    });
    console.error(
      `A token for the service account "${account}", valid until ${expiresAt.toISOString()}. Store it now: it is not shown again.`,
    );
    console.log(token);
  } catch (error) {
    throw new StartupError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
