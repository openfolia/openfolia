/**
 * The backup process (#529): `CCMS_ROLE=backup` in the API image
 * (`deploy/compose.yaml`, service `backup`), which the server's entry point
 * (`main.ts`, the one parser of `CCMS_ROLE`: `config/role.ts`, #527) hands
 * its arguments, or `node backend/api/dist/backups/backup.main.js <command>`.
 *
 *   run                         the loop: requests from Admin → Backups, scheduled runs (default)
 *   now                         one backup now, then exit (0 when it succeeded)
 *   list                        the backups at the location in force
 *   restore <name> [--key-file <file>] [--s3] [--force]
 *                               restores a backup onto a fresh stack; the key from the file
 *                               (default CCMS_BACKUP_KEY_FILE), or from stdin with --key-file -
 *
 * Reads the settings of `config/backup-env.ts` (`.env.example`, "Backups").
 * Never logs a secret.
 */
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { BackupEnv } from '../config/backup-env.js';
import { StartupError } from '../config/startup-error.js';
import { DrizzleUnitOfWork } from '../database/drizzle-unit-of-work.js';
import { openDatabase } from '../database/open-database.js';
import { OpenSecretKeyAction } from '../secrets/core/actions/open-secret-key.action.js';
import { InstanceSecretKey } from '../secrets/core/instance-secret-key.js';
import { SealedSecretSources } from '../secrets/core/secret-key-ports.js';
import { AesSecretCipher } from '../secrets/repos/aes-secret-cipher.js';
import { DrizzleSecretKeyCheck } from '../secrets/repos/drizzle-secret-key-check.js';
import { EnvSecretKeySettings } from '../secrets/repos/env-secret-key-settings.js';
import { FsSecretKeyFile } from '../secrets/repos/fs-secret-key-file.js';
import { sealedSecretSources } from '../secrets/sealed-secret-sources.js';
import {
  BackupLog,
  BackupTickAction,
  RunBackupAction,
} from './core/actions/run-backup.action.js';
import { SystemBackupClock } from './core/backup-clock.js';
import { S3_ALLOW_PRIVATE } from './core/backup-endpoint.js';
import { effectiveSettings, fingerprintOf } from './core/effective-settings.js';
import { AgeBackupKeys, identityLine } from './repos/age-backup-keys.js';
import {
  FsAndS3BackupTargets,
  S3BackupTarget,
} from './repos/backup-targets.js';
import { DrizzleBackupStore } from './repos/drizzle-backup-store.js';
import {
  BackupEnvProblem,
  EnvBackupEnvironment,
} from './repos/env-backup-environment.js';
import { OutboxBackupIncidents } from './repos/outbox-backup-incidents.js';
import { PgBackupLock } from './repos/pg-backup-lock.js';
import { restoreBackup } from './repos/restore-backup.js';
import { ShellBackupSource } from './repos/shell-backup-source.js';
import { ShellBackupVerifier } from './repos/shell-backup-verifier.js';
import { clearStaging, openStagingRoot } from './repos/staging.js';

const USAGE =
  'Usage: backup [run | now | list | restore <name> [--key-file <file>|-] [--s3] [--force]]';

/** Heartbeats, independent of a long run. */
const HEARTBEAT_MS = 15_000;

class ConsoleBackupLog extends BackupLog {
  info(message: string): void {
    console.log(`openfolia backup: ${message}`);
  }
  warn(message: string): void {
    console.error(`openfolia backup: ${message}`);
  }
}

async function readIdentity(path: string): Promise<string> {
  const text = path === '-' ? await readStdin() : await readFile(path, 'utf8');
  const line = identityLine(text);
  if (!line)
    throw new StartupError(
      `${path === '-' ? 'stdin' : path} holds no age identity.`,
    );
  return line;
}

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

async function main(args: readonly string[]): Promise<void> {
  process.umask(0o077);
  const [command = 'run', ...rest] = args.filter((a) => a !== '--');
  const parsed = BackupEnv.safeParse(process.env);
  if (!parsed.success) {
    throw new StartupError(
      `Invalid settings (see .env.example, "Backups"):\n${z.prettifyError(parsed.error)}`,
    );
  }
  const env = parsed.data;
  const log = new ConsoleBackupLog();
  const blobRoot =
    env.CCMS_BLOB_DRIVER === 'fs' ? env.CCMS_BLOB_FS_ROOT : undefined;
  const keySettings = new EnvSecretKeySettings({
    ...env,
    CCMS_SECRET_KEY_GENERATE: false,
  });
  const secretKeyFile = keySettings.configured ? undefined : keySettings.file;
  let stagingRoot: string;
  try {
    stagingRoot = await openStagingRoot(
      env.CCMS_BACKUP_STAGING_DIR,
      env.CCMS_BACKUP_DIR,
      [
        env.CCMS_CONTENT_DIR,
        ...(blobRoot ? [blobRoot] : []),
        ...(secretKeyFile ? [dirname(secretKeyFile)] : []),
      ],
    );
  } catch (error) {
    throw new StartupError(
      error instanceof Error ? error.message : String(error),
    );
  }
  // A root made for this process alone (no CCMS_BACKUP_STAGING_DIR) goes with it.
  if (env.CCMS_BACKUP_STAGING_DIR === undefined) {
    const made = stagingRoot;
    process.once('exit', () => {
      rmSync(made, { recursive: true, force: true });
    });
  }

  if (command === 'restore') {
    const name = rest.find(
      (a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--key-file',
    );
    const keyAt = rest.indexOf('--key-file');
    const keyFile = keyAt >= 0 ? rest[keyAt + 1] : env.CCMS_BACKUP_KEY_FILE;
    if (!name || !keyFile) throw new StartupError(USAGE);
    const identity = await readIdentity(keyFile);
    const s3 =
      rest.includes('--s3') && env.CCMS_BACKUP_LOCATION === 's3'
        ? new S3BackupTarget(
            {
              kind: 's3',
              endpoint: env.CCMS_BACKUP_S3_ENDPOINT ?? null,
              region: env.CCMS_BACKUP_S3_REGION,
              bucket: env.CCMS_BACKUP_S3_BUCKET!,
              prefix: env.CCMS_BACKUP_S3_PREFIX ?? '',
              accessKeyId: env.CCMS_BACKUP_S3_ACCESS_KEY_ID!,
            },
            env.CCMS_BACKUP_S3_SECRET_ACCESS_KEY,
            { allowPrivate: env.CCMS_BACKUP_S3_ALLOW_PRIVATE },
          )
        : undefined;
    if (rest.includes('--s3') && !s3) {
      throw new StartupError(
        '--s3 needs CCMS_BACKUP_LOCATION=s3 and the CCMS_BACKUP_S3_* settings.',
      );
    }
    // Under the backup lock: no run starts meanwhile, and none clears the restore's staging.
    const restored = await new PgBackupLock(env.CCMS_DATABASE_URL).tryWith(() =>
      restoreBackup(
        {
          databaseUrl: env.CCMS_DATABASE_URL,
          contentDir: env.CCMS_CONTENT_DIR,
          blobRoot,
          secretKeyFile,
          volume: env.CCMS_BACKUP_DIR,
          staging: stagingRoot,
        },
        { name, identity, force: rest.includes('--force'), ...(s3 && { s3 }) },
        (m) => log.info(m),
      ),
    );
    if (restored === undefined) {
      throw new StartupError(
        'A backup is running: stop the backup service first (docker compose stop backup), then restore.',
      );
    }
    log.info('Restored. Start the stack: docker compose up -d --wait');
    return;
  }
  if (!['run', 'now', 'list'].includes(command) || rest.length > 0) {
    throw new StartupError(USAGE);
  }

  const database = await openDatabase({
    CCMS_DATABASE_URL: env.CCMS_DATABASE_URL,
    CCMS_DATABASE_MIGRATE: false,
    CCMS_DATABASE_POOL_MAX: 3,
  });
  try {
    const unit = new DrizzleUnitOfWork(database);
    const cipher = new AesSecretCipher();
    const opened = await new OpenSecretKeyAction(
      keySettings,
      new FsSecretKeyFile(keySettings.file),
      cipher,
      new SealedSecretSources(sealedSecretSources()),
      new DrizzleSecretKeyCheck(),
      unit,
    ).handle({ generate: false });
    const sealer = new InstanceSecretKey(cipher);
    sealer.use(opened);

    const keys = new AgeBackupKeys();
    const identity = env.CCMS_BACKUP_KEY_FILE
      ? await readIdentity(env.CCMS_BACKUP_KEY_FILE)
      : undefined;
    const keyFingerprint = identity
      ? fingerprintOf(await keys.recipientOf(identity))
      : undefined;
    const environment = new EnvBackupEnvironment(env, identity, keyFingerprint);
    const store = new DrizzleBackupStore(database);
    const clock = new SystemBackupClock();
    const targets = new FsAndS3BackupTargets(env.CCMS_BACKUP_DIR, {
      allowPrivate: env.CCMS_BACKUP_S3_ALLOW_PRIVATE,
    });
    const incidents = new OutboxBackupIncidents(database);
    const lock = new PgBackupLock(env.CCMS_DATABASE_URL);
    const verifier = new ShellBackupVerifier({
      verifyDatabaseUrl:
        env.CCMS_BACKUP_VERIFY_DATABASE_URL ?? env.CCMS_DATABASE_URL,
      blobRoot,
    });
    const runBackup = new RunBackupAction(
      store,
      environment,
      keys,
      sealer,
      new ShellBackupSource({
        databaseUrl: env.CCMS_DATABASE_URL,
        contentDir: env.CCMS_CONTENT_DIR,
        blobRoot,
        secretKeyFile,
        stagingRoot,
      }),
      verifier,
      targets,
      incidents,
      clock,
      log,
    );

    if (command === 'list') {
      const settings = effectiveSettings(
        await store.settings(),
        environment.overrides,
      );
      const target = targets.open(
        settings.location,
        await runBackup.secretForTest(),
      );
      for (const b of (await target.list()).sort(
        (a, b) => a.at.getTime() - b.at.getTime(),
      )) {
        console.log(`${b.at.toISOString()}  ${b.name}`);
      }
      return;
    }
    if (command === 'now') {
      const outcome = await lock.tryWith(async () => {
        // Under the lock: no other process is running a backup, so nothing staged is in use.
        await clearStaging(stagingRoot);
        return runBackup.handle({
          trigger: 'command',
          scheduledFor: null,
          requestId: null,
        });
      });
      if (!outcome)
        throw new StartupError(
          'Another backup process is running a backup; try again once it has finished.',
        );
      if (outcome.status !== 'succeeded') {
        throw new StartupError(
          `The backup failed (${outcome.error}): ${outcome.errorDetail}`,
        );
      }
      return;
    }

    // The loop.
    const tick = new BackupTickAction(
      store,
      environment,
      lock,
      runBackup,
      targets,
      incidents,
      clock,
      log,
    );
    const startedAt = clock.now();
    const beat = async () => {
      try {
        await store.heartbeat({
          processId: environment.processId,
          startedAt,
          lastSeenAt: clock.now(),
          overrides: {
            ...environment.overrides,
            ...(env.CCMS_BACKUP_S3_ALLOW_PRIVATE && {
              [S3_ALLOW_PRIVATE]: {
                variable: 'CCMS_BACKUP_S3_ALLOW_PRIVATE',
                value: true,
              },
            }),
          },
          keyFingerprint: keyFingerprint ?? null,
        });
      } catch (error) {
        log.warn(
          `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await beat();
    const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
    try {
      await tick.recover();
      // What a stopped run left, under the lock (no other process is in a run then): its staged
      // parts and its throwaway database.
      await lock.tryWith(async () => {
        const left = await clearStaging(stagingRoot);
        if (left.length > 0)
          log.warn(`Removed what a stopped run staged: ${left.join(', ')}.`);
        try {
          const dropped = await verifier.dropLeftovers(clock.now());
          if (dropped.length > 0)
            log.warn(
              `Dropped throwaway databases a stopped run left: ${dropped.join(', ')}.`,
            );
        } catch (error) {
          log.warn(
            `Could not look for throwaway databases a stopped run left: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      log.info(
        `Running (every ${env.CCMS_BACKUP_POLL_MS} ms; fixed by the environment: ${
          Object.values(environment.overrides)
            .map((o) => o.variable)
            .join(', ') || 'nothing'
        }).`,
      );
      while (!stopping) {
        try {
          await tick.handle();
        } catch (error) {
          log.warn(
            `A pass failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!stopping) await sleep(env.CCMS_BACKUP_POLL_MS);
      }
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    if (error instanceof BackupEnvProblem)
      throw new StartupError(error.message, { cause: error });
    throw error;
  } finally {
    await database.close();
  }
}

/** Runs one backup command (`run` when none): from `main.ts` for `CCMS_ROLE=backup`, or directly. */
export async function runBackupCommand(args: readonly string[]): Promise<void> {
  try {
    await main(args);
  } catch (error: unknown) {
    // The message only: a refusal (a restore into an instance that holds data, a run that
    // failed) is the operator's to read, and no message here holds a secret.
    console.error(
      `openfolia backup: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Run directly (`node dist/backups/backup.main.js <command>`), not imported by `main.ts`.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runBackupCommand(process.argv.slice(2));
}
