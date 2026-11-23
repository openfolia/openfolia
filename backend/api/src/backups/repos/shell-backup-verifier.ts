import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import {
  type BackupManifest,
  BackupStepError,
  BackupVerifier,
  type EncryptedBackup,
  type PreparedBackup,
} from '../core/backup-ports.js';
import type { VerifyMode } from '../core/backup-run.js';
import { decryptTo, openArchive } from './age-archive.js';
import { databaseOf, pgEnvOf, quoteIdent, withDatabase } from './pg-env.js';
import { output, run } from './processes.js';

export interface BackupVerifierSettings {
  /** Where throwaway databases are made: `CCMS_BACKUP_VERIFY_DATABASE_URL`, else the instance's. */
  readonly verifyDatabaseUrl: string;
  /** The live `fs` blob folder, for a check before encryption. */
  readonly blobRoot: string | undefined;
}

/** What starts every age file. */
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');

/** A throwaway database's name: `<db>_verify_<UTC yyyymmddhhmmss>_<run>`. */
export function verifyDatabaseName(
  base: string,
  at: Date,
  runId: string,
): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const prefix = base
    .replace(/[^a-z0-9_]/gi, '_')
    .slice(0, 30)
    .toLowerCase();
  return `${prefix}_verify_${stamp}_${runId.replace(/-/g, '').slice(0, 8)}`;
}

const VERIFY_NAME = /_verify_(\d{14})_[0-9a-f]{8}$/;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const fail = (message: string): never => {
  throw new BackupStepError('verify-failed', message);
};

/**
 * `BackupVerifier` (#529, "verifies it"): restores the dump into a
 * throwaway database and compares the migrations and row counts with the
 * snapshot's, clones the content bundle and runs `git fsck`, and checks
 * the hash of every blob the database refers to. With the identity it
 * checks what the encrypted file decrypts to; without, the parts before
 * encryption, and the encrypted file by its age header, size and SHA-256.
 * The throwaway database is always dropped (`finally`, and leftovers older
 * than an hour at start, `dropLeftovers`).
 */
export class ShellBackupVerifier extends BackupVerifier {
  constructor(private readonly settings: BackupVerifierSettings) {
    super();
  }

  async verify(input: {
    prepared: PreparedBackup;
    encrypted: EncryptedBackup;
    identity: string | undefined;
  }): Promise<VerifyMode> {
    const { prepared, encrypted, identity } = input;
    const work = join(prepared.dir, 'verify');
    await mkdir(work, { recursive: true, mode: 0o700 });
    try {
      if (identity !== undefined) {
        const plain = join(work, 'backup.tar');
        await decryptTo(encrypted.path, identity, plain);
        const out = join(work, 'out');
        await mkdir(out, { mode: 0o700 });
        // Never unpacks the instance secret key: a check needs only the parts it compares.
        const manifest = await openArchive(plain, out, {
          withSecretKey: false,
        });
        await rm(plain, { force: true });
        if (manifest.runId !== prepared.manifest.runId) {
          fail('The decrypted backup is another run’s.');
        }
        await this.checkParts(
          out,
          manifest,
          manifest.blobs ? join(out, manifest.blobs.dir) : undefined,
          work,
        );
        return 'decrypted';
      }
      await this.checkEncryptedFile(encrypted);
      await this.checkParts(
        prepared.dir,
        prepared.manifest,
        this.settings.blobRoot,
        work,
      );
      return 'before-encryption';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async checkEncryptedFile(encrypted: EncryptedBackup): Promise<void> {
    const handle = await open(encrypted.path, 'r');
    try {
      const head = Buffer.alloc(AGE_HEADER.length);
      await handle.read(head, 0, head.length, 0);
      if (!head.equals(AGE_HEADER)) fail('The written file is no age file.');
    } finally {
      await handle.close();
    }
    const size = (await stat(encrypted.path)).size;
    if (size !== encrypted.sizeBytes) {
      fail(
        `The written file has ${size} bytes, ${encrypted.sizeBytes} were written.`,
      );
    }
    if ((await sha256Of(encrypted.path)) !== encrypted.sha256) {
      fail('The written file’s SHA-256 is not what was written.');
    }
  }

  private async checkParts(
    dir: string,
    manifest: BackupManifest,
    blobDir: string | undefined,
    work: string,
  ): Promise<void> {
    await this.checkDatabase(join(dir, 'database.dump'), manifest);
    if (manifest.content) {
      const clone = join(work, 'content-check.git');
      try {
        await run('git', [
          'clone',
          '--quiet',
          '--mirror',
          join(dir, manifest.content.file),
          clone,
        ]);
        await run('git', ['-C', clone, 'fsck', '--full', '--no-progress']);
        const refs = (
          await output('git', [
            '-C',
            clone,
            'for-each-ref',
            '--format=%(refname)',
          ])
        )
          .split('\n')
          .filter((r) => r.length > 0 && !r.startsWith('refs/remotes/')).length;
        if (refs !== manifest.content.refs) {
          fail(
            `The content bundle holds ${refs} refs, the repository had ${manifest.content.refs}.`,
          );
        }
      } catch (error) {
        if (error instanceof BackupStepError) throw error;
        fail(
          `The content repository does not check out: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (manifest.blobs && blobDir !== undefined) {
      for (const hash of manifest.blobs.referenced) {
        const path = join(blobDir, hash.slice(0, 2), hash);
        let actual: string;
        try {
          actual = await sha256Of(path);
        } catch {
          fail(`The blob ${hash} the database refers to is missing.`);
          return;
        }
        if (actual !== hash) fail(`The blob ${hash} does not match its hash.`);
      }
    }
  }

  private async checkDatabase(
    dump: string,
    manifest: BackupManifest,
  ): Promise<void> {
    const admin = this.settings.verifyDatabaseUrl;
    const name = verifyDatabaseName(
      databaseOf(admin),
      new Date(),
      manifest.runId,
    );
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(`create database ${quoteIdent(name)}`);
      try {
        try {
          await run(
            'pg_restore',
            [
              '--no-owner',
              '--no-acl',
              '--exit-on-error',
              '--no-password',
              `--dbname=${name}`,
              dump,
            ],
            { env: pgEnvOf(admin, name) },
          );
        } catch (error) {
          fail(
            `The dump does not restore: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const restored = new pg.Client({
          connectionString: withDatabase(admin, name),
        });
        await restored.connect();
        try {
          for (const [table, expected] of Object.entries(
            manifest.database.rows,
          )) {
            const [schema, rel] = table.split('.') as [string, string];
            let counted: number;
            try {
              const r = await restored.query<{ n: string }>(
                `select count(*) as n from ${quoteIdent(schema)}.${quoteIdent(rel)}`,
              );
              counted = Number(r.rows[0]!.n);
            } catch {
              fail(`The restored database lacks the table ${table}.`);
              return;
            }
            if (counted !== expected) {
              fail(
                `The restored ${table} has ${counted} rows, the snapshot had ${expected}.`,
              );
            }
          }
          if (
            (manifest.database.rows['drizzle.__drizzle_migrations'] ?? 0) !==
            manifest.database.migrations
          ) {
            fail('The migrations recorded do not match the snapshot.');
          }
        } finally {
          await restored.end().catch(() => undefined);
        }
      } finally {
        await client.query(
          `drop database if exists ${quoteIdent(name)} with (force)`,
        );
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Drops throwaway databases older than an hour that a stopped process left. */
  async dropLeftovers(now: Date): Promise<string[]> {
    const admin = this.settings.verifyDatabaseUrl;
    const prefix = verifyDatabaseName(
      databaseOf(admin),
      now,
      '00000000',
    ).replace(VERIFY_NAME, '');
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    const dropped: string[] = [];
    try {
      const { rows } = await client.query<{ datname: string }>(
        'select datname from pg_database where datname like $1',
        [`${prefix.replace(/_/g, '\\_')}\\_verify\\_%`],
      );
      for (const { datname } of rows) {
        const match = VERIFY_NAME.exec(datname);
        if (!match) continue;
        const s = match[1]!;
        const at = Date.UTC(
          +s.slice(0, 4),
          +s.slice(4, 6) - 1,
          +s.slice(6, 8),
          +s.slice(8, 10),
          +s.slice(10, 12),
          +s.slice(12, 14),
        );
        if (now.getTime() - at < 3_600_000) continue;
        await client.query(
          `drop database if exists ${quoteIdent(datname)} with (force)`,
        );
        dropped.push(datname);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
    return dropped;
  }
}
