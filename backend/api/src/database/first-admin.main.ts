/**
 * Makes the first admin of a deployment with password sign-in (#610) and prints a one-time
 * link for them to choose their password: `pnpm nx run api:first-admin -- <email> [--name
 * <name>] [--editor <url>]` (in a deployment `node dist/database/first-admin.main.js …`).
 * Creates the user and the role `admin` when missing. The link opens the editor at
 * `--editor`, else `CCMS_PUBLIC_URL`, else `CCMS_EDITOR_URL`; it works `CCMS_INVITE_DAYS`
 * days (default 7), once. Run it again for a new link (the earlier one stops working).
 * Applies pending migrations first.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { firstAdminLocally } from '../access/repos/first-admin-locally.js';
import { DatabaseEnv } from '../config/database-env.js';
import { DEFAULT_INVITE_DAYS } from '../config/sign-in-env.js';
import { StartupError } from '../config/startup-error.js';
import { DrizzleInstallationSettingsStore } from '../settings/repos/drizzle-installation-settings-store.js';
import { openDatabase } from './open-database.js';

const USAGE = 'Usage: first-admin <email> [--name <name>] [--editor <url>]';

/** An editor address as a link base: absolute http(s), ending in `/`. */
function linkBase(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new StartupError(`Not an address: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StartupError(`Not an http(s) address: ${raw}`);
  }
  url.search = '';
  url.hash = '';
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

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
      options: { name: { type: 'string' }, editor: { type: 'string' } },
    });
  } catch {
    throw new StartupError(USAGE);
  }
  const [email, ...rest] = parsed.positionals;
  if (email === undefined || rest.length > 0) throw new StartupError(USAGE);
  const days = Number(process.env['CCMS_INVITE_DAYS'] || DEFAULT_INVITE_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new StartupError(
      'CCMS_INVITE_DAYS must be a whole number from 1 to 90.',
    );
  }
  const base = linkBase(
    parsed.values.editor ||
      process.env['CCMS_PUBLIC_URL'] ||
      process.env['CCMS_EDITOR_URL'],
  );
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  try {
    const made = await firstAdminLocally(database, {
      email,
      name: parsed.values.name,
      inviteMs: days * 24 * 60 * 60 * 1000,
      linkBase: base,
    });
    console.error(
      `${made.created ? 'Made' : 'Found'} the admin "${made.userId}". Open this link to choose their password; it works once, until ${made.expiresAt.toISOString()}, and is not shown again${base === null ? ' (put the editor’s address in front of it, or pass --editor)' : ''}:`,
    );
    console.log(made.link);
    const { settings: installation } =
      await new DrizzleInstallationSettingsStore(database).read();
    if (
      installation.singleSignOn !== 'optional' &&
      installation.breakGlassUserId !== made.userId
    ) {
      console.error(
        'This installation requires single sign-on: the link works only once it no longer does (allow-other-sign-ins), or for its emergency account.',
      );
    }
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
