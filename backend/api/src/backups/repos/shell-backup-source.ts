import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Encrypter } from 'age-encryption';
import pg from 'pg';
import {
  type BackupManifest,
  BackupSource,
  BackupStepError,
  type EncryptedBackup,
  type PreparedBackup,
} from '../core/backup-ports.js';
import { pgEnvOf, quoteIdent } from './pg-env.js';
import { output, run, start } from './processes.js';
import { stageRun } from './staging.js';

/** What the source reads: the database, the content repository, the blobs, the key file. */
export interface BackupSourceSettings {
  readonly databaseUrl: string;
  readonly contentDir: string;
  /** The `fs` blob store's folder; undefined with an S3 blob store (not in the backup). */
  readonly blobRoot: string | undefined;
  /** The instance secret key file, when the key is one (`CCMS_SECRET_KEY_FILE` or the default). */
  readonly secretKeyFile: string | undefined;
  /** Where runs stage their files: the staging root (`staging.ts`), never in the backup volume. */
  readonly stagingRoot: string;
}

/** The columns that refer to blobs by hash (release outputs, imports, uploads, renditions). */
const BLOB_REFERENCES = `
  select sha256 as h from release_outputs where sha256 is not null
  union select upload_sha256 from imports
  union select sha256 from asset_uploads
  union select sha256 from asset_renditions
  union select source_sha256 from asset_renditions`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Counts bytes and hashes them as they pass. */
export function measure(): {
  stream: Transform;
  size: () => number;
  sha256: () => string;
} {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, size: () => size, sha256: () => hash.digest('hex') };
}

/**
 * `BackupSource` with `pg_dump`, `git bundle` and `tar` (#529), in the
 * guide's order: the database first, then the files, so the dump never
 * refers to a blob the archive lacks (blobs are only added, under their
 * hash; one deleted in between is caught by the check).
 *
 * - **The database:** a read-only repeatable-read transaction exports its
 *   snapshot (`pg_export_snapshot`); in it the row count of every table,
 *   the migrations applied and the blob hashes referred to are read, and
 *   `pg_dump -Fc --snapshot` dumps exactly that snapshot.
 * - **The content repository:** `git bundle create --all`, which reads
 *   refs and objects consistently while the API writes (objects are never
 *   changed in place), unlike a tar of the folder mid-pack.
 * - **The blobs and the key file** are archived from the data volume
 *   (`tar`, without the blob store's `tmp/`), streamed into age.
 */
export class ShellBackupSource extends BackupSource {
  constructor(private readonly settings: BackupSourceSettings) {
    super();
  }

  async prepare(runId: string): Promise<PreparedBackup> {
    const dir = await stageRun(this.settings.stagingRoot, runId);
    try {
      const database = await this.dump(join(dir, 'database.dump'));
      const content = await this.bundle(join(dir, 'content.bundle'));
      // The blob folder goes into the archive only when it exists; none, while the database
      // refers to blobs, is a broken instance and no backup.
      const blobRoot = this.settings.blobRoot;
      const blobsThere = blobRoot !== undefined && (await exists(blobRoot));
      if (
        blobRoot !== undefined &&
        !blobsThere &&
        database.referenced.length > 0
      ) {
        throw new BackupStepError(
          'archive-failed',
          `The database refers to ${database.referenced.length} blob(s), but the blob folder ${blobRoot} does not exist.`,
        );
      }
      const manifest: BackupManifest = {
        format: 1,
        runId,
        createdAt: new Date().toISOString(),
        database: { migrations: database.migrations, rows: database.rows },
        content,
        blobs:
          blobRoot !== undefined && blobsThere
            ? {
                dir: basename(blobRoot),
                referenced: database.referenced,
              }
            : null,
        secretKeyFile:
          this.settings.secretKeyFile !== undefined &&
          (await exists(this.settings.secretKeyFile))
            ? basename(this.settings.secretKeyFile)
            : null,
      };
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        {
          mode: 0o600,
        },
      );
      return { runId, dir, manifest };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async dump(file: string): Promise<{
    migrations: number;
    rows: Record<string, number>;
    referenced: string[];
  }> {
    const client = new pg.Client({
      connectionString: this.settings.databaseUrl,
    });
    try {
      await client.connect();
      await client.query('begin isolation level repeatable read, read only');
      const snapshot = (
        await client.query<{ s: string }>('select pg_export_snapshot() as s')
      ).rows[0]!.s;
      const tables = await client.query<{
        schemaname: string;
        tablename: string;
      }>(
        `select schemaname, tablename from pg_catalog.pg_tables
         where schemaname in ('public', 'drizzle') order by 1, 2`,
      );
      const rows: Record<string, number> = {};
      for (const t of tables.rows) {
        const counted = await client.query<{ n: string }>(
          `select count(*) as n from ${quoteIdent(t.schemaname)}.${quoteIdent(t.tablename)}`,
        );
        rows[`${t.schemaname}.${t.tablename}`] = Number(counted.rows[0]!.n);
      }
      const migrations = rows['drizzle.__drizzle_migrations'] ?? 0;
      const referenced = this.settings.blobRoot
        ? (await client.query<{ h: string }>(BLOB_REFERENCES)).rows
            .map((r) => r.h)
            .sort()
        : [];
      try {
        await run(
          'pg_dump',
          [
            '--format=custom',
            `--snapshot=${snapshot}`,
            '--no-password',
            `--file=${file}`,
          ],
          { env: pgEnvOf(this.settings.databaseUrl) },
        );
      } catch (error) {
        throw new BackupStepError(
          'database-dump-failed',
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      await client.query('commit');
      return { migrations, rows, referenced };
    } catch (error) {
      if (error instanceof BackupStepError) throw error;
      throw new BackupStepError(
        'database-dump-failed',
        `Reading the database failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async bundle(file: string): Promise<BackupManifest['content']> {
    const repo = this.settings.contentDir;
    if (!(await exists(repo))) return null;
    const git = ['-c', `safe.directory=${repo}`, '-C', repo];
    const refs = (
      await output('git', [...git, 'for-each-ref', '--format=%(refname)'])
    )
      .split('\n')
      .filter((line) => line.length > 0).length;
    if (refs === 0) return null;
    await run('git', [...git, 'bundle', 'create', '--quiet', file, '--all']);
    return { file: 'content.bundle', refs };
  }

  async encrypt(
    prepared: PreparedBackup,
    recipient: string,
  ): Promise<EncryptedBackup> {
    const { dir, manifest } = prepared;
    const args = ['-cf', '-'];
    if (manifest.blobs) args.push(`--exclude=${manifest.blobs.dir}/tmp`);
    args.push('-C', dir, 'manifest.json', 'database.dump');
    if (manifest.content) args.push(manifest.content.file);
    if (
      manifest.blobs &&
      this.settings.blobRoot &&
      (await exists(this.settings.blobRoot))
    ) {
      args.push('-C', dirname(this.settings.blobRoot), manifest.blobs.dir);
    }
    if (manifest.secretKeyFile && this.settings.secretKeyFile) {
      args.push(
        '-C',
        dirname(this.settings.secretKeyFile),
        manifest.secretKeyFile,
      );
    }
    const path = join(dir, 'backup.tar.age');
    const tar = start('tar', args, { stdout: 'pipe' });
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const plain = Readable.toWeb(
      tar.child.stdout!,
    ) as unknown as ReadableStream<Uint8Array>;
    const sealed = await encrypter.encrypt(plain);
    const measured = measure();
    try {
      await Promise.all([
        pipeline(
          Readable.fromWeb(sealed as unknown as WebReadableStream<Uint8Array>),
          measured.stream,
          createWriteStream(path, { mode: 0o600 }),
        ),
        tar.done,
      ]);
    } catch (error) {
      tar.child.kill('SIGTERM');
      throw error;
    }
    const size = (await stat(path)).size;
    if (size !== measured.size()) {
      throw new Error(
        `The encrypted file has ${size} bytes, ${measured.size()} were written.`,
      );
    }
    return { path, sizeBytes: size, sha256: measured.sha256() };
  }

  async discard(prepared: PreparedBackup): Promise<void> {
    await rm(prepared.dir, { recursive: true, force: true });
  }
}
