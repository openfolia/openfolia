/**
 * Rotates the instance secret key (#470): `pnpm nx run api:rotate-secret-key`
 * (in a deployment `node backend/api/dist/secrets/rotate-secret-key.main.js`).
 * Stop every server first: a running one keeps the old key. Re-seals
 * every stored secret under a new key in one transaction. With the key
 * file, the new key is made and replaces the file; with `CCMS_SECRET_KEY`
 * (or its old name), set `CCMS_SECRET_KEY_NEW` to the new key, then
 * `CCMS_SECRET_KEY` to it before starting again. Never prints a key.
 * Applies pending migrations first. Reads `CCMS_DATABASE_URL`, the
 * `CCMS_SECRET_KEY*` settings and `CCMS_CONTENT_DIR`.
 */
import { z } from 'zod';
import { DatabaseEnv } from '../config/database-env.js';
import { StartupError } from '../config/startup-error.js';
import { openDatabase } from '../database/open-database.js';
import { SecretKeyProblem } from './core/secret-key.js';
import { RotateSecretKeyEnv, rotateSecretKey } from './rotate-secret-key.js';

const USAGE =
  'Usage: rotate-secret-key (no arguments; stop every server first). For a key set by CCMS_SECRET_KEY, set CCMS_SECRET_KEY_NEW to the new key.';

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg !== '--')) {
    throw new StartupError(USAGE);
  }
  const settings = DatabaseEnv.omit({ CCMS_DATABASE_MIGRATE: true })
    .and(RotateSecretKeyEnv)
    .safeParse(process.env);
  if (!settings.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(settings.error)}`,
    );
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    const { origin, resealed } = await rotateSecretKey(settings.data, database);
    const counts = resealed
      .map(({ name, count }) => `${count} ${name}`)
      .join(', ');
    console.error(`Re-sealed ${counts || 'nothing'} under the new key.`);
    for (const { name, unreadable } of resealed) {
      if (unreadable > 0) {
        console.error(
          `${unreadable} ${name} did not open with the old key either (unreadable before the rotation) and were left as they were: give those a new secret.`,
        );
      }
    }
    console.error(
      origin.kind === 'file'
        ? `The key file ${origin.path} holds the new key: back it up again, then start the servers.`
        : 'Now set CCMS_SECRET_KEY to the new key (the value of CCMS_SECRET_KEY_NEW) on every server, remove CCMS_WEBHOOKS_SECRET_KEY and CCMS_SECRET_KEY_NEW, then start them.',
    );
  } catch (error) {
    if (error instanceof SecretKeyProblem) {
      throw new StartupError(error.message, { cause: error });
    }
    throw error;
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
