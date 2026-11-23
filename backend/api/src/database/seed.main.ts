/**
 * Seeds roles and users and exits: `pnpm nx run api:db-seed -- --example`
 * writes the example ones (`access/repos/example-seed.ts`, which include an
 * admin holding every permission, so they are never the default);
 * `pnpm nx run api:db-seed -- <file.json>` writes the file's (the same
 * shape, `Seed`). Applies pending migrations first. Idempotent: running it
 * again changes nothing. Reads only `CCMS_DATABASE_URL`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { exampleSeed } from '../access/repos/example-seed.js';
import { Seed, seedAccess } from '../access/repos/seed.js';
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
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const [what] = args;
  if (
    args.length !== 1 ||
    what === undefined ||
    (what.startsWith('-') && what !== '--example')
  ) {
    throw new StartupError(
      'Usage: db-seed --example (the example roles and users) or db-seed <file.json>',
    );
  }
  const file = what === '--example' ? undefined : what;
  const seed = Seed.safeParse(
    file === undefined ? exampleSeed : await readJson(file),
  );
  if (!seed.success) {
    throw new StartupError(
      `Invalid seed ${file ?? '(the example)'}:\n${z.prettifyError(seed.error)}`,
    );
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    await seedAccess(database, seed.data);
  } finally {
    await database.close();
  }
  console.log(
    `Seeded ${seed.data.roles.length} roles and ${seed.data.users.length} users into ${database.target}` +
      (file === undefined ? ' (the example ones).' : ` from ${file}.`),
  );
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch (error) {
    throw new StartupError(
      `Cannot read the seed ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
