import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import type { BackupManifest } from '../core/backup-ports.js';
import { BACKUP_NAME } from '../core/backup-paths.js';
import { decryptTo, openArchive } from './age-archive.js';
import { stageRestore } from './staging.js';
import { resolveInside, type S3BackupTarget } from './backup-targets.js';
import { databaseOf, pgEnvOf } from './pg-env.js';
import { run } from './processes.js';

export interface RestoreSettings {
  readonly databaseUrl: string;
  readonly contentDir: string;
  readonly blobRoot: string | undefined;
  readonly secretKeyFile: string | undefined;
  /** The backup volume. */
  readonly volume: string;
  /** Where the backup is decrypted and unpacked: never inside the backup volume. */
  readonly staging: string;
}

export interface RestoreRequest {
  /** A path inside the backup volume (`<subfolder>/<name>`), or an object's name with `s3`. */
  readonly name: string;
  /** The age identity (the key's file content). */
  readonly identity: string;
  /** Restore into an instance that is not empty (its data is replaced). */
  readonly force: boolean;
  /** The S3 location to download `name` from, when it is there. */
  readonly s3?: S3BackupTarget;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** What a restore would overwrite: tables in the database, a content repository, blobs. */
async function nonEmpty(settings: RestoreSettings): Promise<string[]> {
  const found: string[] = [];
  const client = new pg.Client({ connectionString: settings.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      "select count(*) as n from pg_catalog.pg_tables where schemaname in ('public', 'drizzle')",
    );
    if (Number(rows[0]!.n) > 0) found.push('the database has tables');
  } finally {
    await client.end().catch(() => undefined);
  }
  if (await exists(settings.contentDir))
    found.push(`${settings.contentDir} exists`);
  if (settings.blobRoot && (await exists(settings.blobRoot))) {
    const entries = (await readdir(settings.blobRoot)).filter(
      (e) => e !== 'tmp',
    );
    if (entries.length > 0) found.push(`${settings.blobRoot} holds blobs`);
  }
  return found;
}

/**
 * Restores a backup onto a fresh stack (#529, `backup restore <name>`):
 * decrypt with the key, check the archive's members, then `pg_restore`,
 * the content repository from its bundle, the blobs and the instance
 * secret key file. Refused into an instance that is not empty unless
 * `force` (then the database objects are replaced, `--clean`, and the
 * content repository is set aside beside it, never deleted).
 */
export async function restoreBackup(
  settings: RestoreSettings,
  request: RestoreRequest,
  log: (message: string) => void,
): Promise<BackupManifest> {
  const staging = await stageRestore(settings.staging);
  try {
    let encrypted: string;
    if (request.s3) {
      if (!BACKUP_NAME.test(request.name)) {
        throw new Error(
          `"${request.name}" is no backup's name (openfolia-backup-….tar.age).`,
        );
      }
      encrypted = join(staging, request.name);
      log(`Downloading ${request.name} from ${request.s3.description} …`);
      await pipeline(
        await request.s3.download(request.name),
        createWriteStream(encrypted, { mode: 0o600 }),
      );
    } else {
      const folder = dirname(request.name) === '.' ? '' : dirname(request.name);
      const file = basename(request.name);
      if (!BACKUP_NAME.test(file)) {
        throw new Error(
          `"${file}" is no backup's name (openfolia-backup-….tar.age).`,
        );
      }
      encrypted = join(await resolveInside(settings.volume, folder), file);
      if (!(await exists(encrypted)))
        throw new Error(
          `There is no backup ${request.name} in the backup volume.`,
        );
    }
    const plain = join(staging, 'backup.tar');
    log('Decrypting …');
    await decryptTo(encrypted, request.identity, plain);
    const out = join(staging, 'out');
    await mkdir(out, { mode: 0o700 });
    const manifest = await openArchive(plain, out, { withSecretKey: true });
    await rm(plain, { force: true });

    const found = await nonEmpty(settings);
    // Another instance secret key where this one goes: refused before anything is written.
    const keyFrom = manifest.secretKeyFile
      ? join(out, manifest.secretKeyFile)
      : undefined;
    const keyThere =
      keyFrom !== undefined &&
      settings.secretKeyFile !== undefined &&
      (await exists(settings.secretKeyFile));
    if (keyThere) {
      const [a, b] = await Promise.all([
        readFile(keyFrom),
        readFile(settings.secretKeyFile!),
      ]);
      if (!a.equals(b)) {
        found.push(
          `${settings.secretKeyFile} holds another instance secret key`,
        );
      }
    }
    if (found.length > 0 && !request.force) {
      throw new Error(
        `Refusing to restore into an instance that is not empty (${found.join('; ')}). Restore onto a fresh stack, or pass --force to replace it.`,
      );
    }

    log('Restoring the database (pg_restore) …');
    await run(
      'pg_restore',
      [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--no-password',
        ...(request.force ? ['--clean', '--if-exists'] : []),
        `--dbname=${databaseOf(settings.databaseUrl)}`,
        join(out, 'database.dump'),
      ],
      { env: pgEnvOf(settings.databaseUrl) },
    );

    if (manifest.content) {
      log(`Restoring the content repository to ${settings.contentDir} …`);
      if (await exists(settings.contentDir)) {
        const aside = `${settings.contentDir}.before-restore-${Date.now()}`;
        await rename(settings.contentDir, aside);
        log(`The content repository there before is kept as ${aside}.`);
      }
      await run('git', [
        'clone',
        '--quiet',
        '--mirror',
        join(out, manifest.content.file),
        settings.contentDir,
      ]);
      await run('git', [
        '-C',
        settings.contentDir,
        'remote',
        'remove',
        'origin',
      ]);
    }

    if (manifest.blobs && settings.blobRoot) {
      log(`Restoring the blobs to ${settings.blobRoot} …`);
      await mkdir(settings.blobRoot, { recursive: true, mode: 0o700 });
      await cp(join(out, manifest.blobs.dir), settings.blobRoot, {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }

    if (keyFrom !== undefined && settings.secretKeyFile) {
      const from = keyFrom;
      if (keyThere && !request.force) {
        // The same key (another one was refused above).
      } else {
        log(`Restoring the instance secret key to ${settings.secretKeyFile} …`);
        await mkdir(dirname(settings.secretKeyFile), {
          recursive: true,
          mode: 0o700,
        });
        await copyFile(from, settings.secretKeyFile);
        await chmod(settings.secretKeyFile, 0o600);
      }
    } else if (!manifest.secretKeyFile) {
      log(
        'The backup holds no instance secret key file (it came from CCMS_SECRET_KEY): set the same key on the new stack.',
      );
    }
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
