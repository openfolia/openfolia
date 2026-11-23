import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  backupTimeOf,
  BACKUP_NAME,
  subfolderProblem,
} from '../core/backup-paths.js';
import {
  BackupStepError,
  BackupTarget,
  BackupTargets,
  type EncryptedBackup,
} from '../core/backup-ports.js';
import type { BackupLocation } from '../core/backup-settings.js';
import type { StoredBackup } from '../core/retention.js';
import { bareHost, endpointProblem } from '../core/backup-endpoint.js';
import { isIP } from 'node:net';
import { guardedAgents, refusal } from './guarded-lookup.js';

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
  );
};

/**
 * The folder `subfolder` names inside the volume `root`, made when
 * missing (0700), resolved on disk: refused when it is no folder name the
 * page allows or when a link on the way leads out of the volume, so the
 * local location can never be an arbitrary server path.
 */
export async function resolveInside(
  root: string,
  subfolder: string,
): Promise<string> {
  const problem = subfolderProblem(subfolder);
  if (problem) throw new BackupStepError('location-unavailable', problem);
  const realRoot = await realpath(root).catch((error: unknown) => {
    throw new BackupStepError(
      'location-unavailable',
      `The backup volume ${root} is not there: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let current = realRoot;
  for (const segment of subfolder.split('/').filter(Boolean)) {
    const next = join(current, segment);
    const info = await lstat(next).catch(() => undefined);
    if (!info) {
      await mkdir(next, { mode: 0o700 });
    } else if (info.isSymbolicLink()) {
      const target = await realpath(next);
      if (!inside(realRoot, target)) {
        throw new BackupStepError(
          'location-unavailable',
          `The subfolder "${subfolder}" leads out of the backup volume (through a link); refused.`,
        );
      }
    } else if (!info.isDirectory()) {
      throw new BackupStepError(
        'location-unavailable',
        `"${segment}" in the backup volume is no folder.`,
      );
    }
    current = await realpath(next);
    if (!inside(realRoot, current)) {
      throw new BackupStepError(
        'location-unavailable',
        `The subfolder "${subfolder}" leads out of the backup volume; refused.`,
      );
    }
  }
  return current;
}

/** A folder inside the backup volume. */
export class LocalBackupTarget extends BackupTarget {
  readonly description: string;
  private folder: Promise<string> | undefined;

  constructor(
    private readonly root: string,
    private readonly subfolder: string,
  ) {
    super();
    this.description = `local:${subfolder === '' ? '/' : subfolder}`;
  }

  private dir(): Promise<string> {
    this.folder ??= resolveInside(this.root, this.subfolder);
    return this.folder;
  }

  async put(file: EncryptedBackup, name: string): Promise<void> {
    const dir = await this.dir();
    const target = join(dir, name);
    try {
      await rename(file.path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      const temp = join(dir, `.${name}.partial`);
      await copyFile(file.path, temp);
      await rename(temp, target);
    }
  }

  async list(): Promise<StoredBackup[]> {
    const dir = await this.dir();
    return (await readdir(dir))
      .map((name) => ({ name, at: backupTimeOf(name) }))
      .filter((b): b is StoredBackup => b.at !== undefined);
  }

  async delete(name: string): Promise<void> {
    if (!BACKUP_NAME.test(name))
      throw new Error(`Not a backup's name: ${name}`);
    await unlink(join(await this.dir(), name));
  }

  async test(): Promise<void> {
    const dir = await this.dir();
    const path = join(dir, `.openfolia-location-test-${randomUUID()}`);
    const body = `openfolia location test ${new Date().toISOString()}`;
    try {
      await writeFile(path, body, { mode: 0o600 });
      const back = await readFile(path, 'utf8');
      if (back !== body)
        throw new Error('What was read back differs from what was written.');
    } finally {
      await rm(path, { force: true });
    }
  }
}

/** Uploads above this size go in parts. */
const PART_BYTES = 64 * 1024 * 1024;

const describeS3Error = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode;
  return `${error.name}${status ? ` (HTTP ${status})` : ''}: ${error.message}`;
};

/** A bucket of an S3-compatible service, under a prefix. */
export class S3BackupTarget extends BackupTarget {
  readonly description: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(
    location: Extract<BackupLocation, { kind: 's3' }>,
    secret: string | undefined,
    connections: { readonly allowPrivate: boolean } = { allowPrivate: false },
  ) {
    super();
    // Checked again where it is used: a setting from the environment or an older row too.
    const problem =
      location.endpoint === null
        ? undefined
        : endpointProblem(location.endpoint);
    if (problem !== undefined) throw new Error(problem);
    // An IP literal host is connected to without a lookup: checked here, before any connection
    // (and each socket again on connecting).
    if (location.endpoint !== null) {
      const host = bareHost(new URL(location.endpoint).hostname);
      if (isIP(host) !== 0) {
        const why = refusal(host, host, connections.allowPrivate);
        if (why !== undefined) throw new Error(why);
      }
    }
    this.bucket = location.bucket;
    this.prefix = location.prefix;
    this.description = `s3:${location.bucket}/${location.prefix}`;
    this.client = new S3Client({
      region: location.region,
      ...(location.endpoint !== null && {
        endpoint: location.endpoint,
        forcePathStyle: true,
      }),
      // Only the credentials set for this location: never the host's own (its environment, an
      // instance or task role), which could reach other buckets.
      credentials:
        secret !== undefined
          ? { accessKeyId: location.accessKeyId, secretAccessKey: secret }
          : () =>
              Promise.reject(
                new Error('No secret access key is set for this S3 location.'),
              ),
      // Every connection resolves the host again and refuses an address backups may not reach
      // (a name that resolves or rebinds to a metadata service, say).
      requestHandler: guardedAgents(connections),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  private async call<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new BackupStepError(
        'upload-failed',
        `${what} at ${this.description} failed: ${describeS3Error(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  async put(file: EncryptedBackup, name: string): Promise<void> {
    const Key = this.key(name);
    if (file.sizeBytes <= PART_BYTES) {
      await this.call('Uploading', () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key,
            Body: createReadStream(file.path),
            ContentLength: file.sizeBytes,
            ContentType: 'application/octet-stream',
          }),
        ),
      );
    } else {
      await this.multipart(file, Key);
    }
    const head = await this.call('Checking the upload', () =>
      this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key })),
    );
    if (head.ContentLength !== file.sizeBytes) {
      throw new BackupStepError(
        'upload-failed',
        `The uploaded object has ${head.ContentLength} bytes, the backup ${file.sizeBytes}.`,
      );
    }
  }

  private async multipart(file: EncryptedBackup, Key: string): Promise<void> {
    const created = await this.call('Starting the upload', () =>
      this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key }),
      ),
    );
    const UploadId = created.UploadId!;
    try {
      const parts: { ETag: string; PartNumber: number }[] = [];
      for (
        let start = 0, n = 1;
        start < file.sizeBytes;
        start += PART_BYTES, n++
      ) {
        const end = Math.min(file.sizeBytes, start + PART_BYTES) - 1;
        const part = await this.call(`Uploading part ${n}`, () =>
          this.client.send(
            new UploadPartCommand({
              Bucket: this.bucket,
              Key,
              UploadId,
              PartNumber: n,
              Body: createReadStream(file.path, { start, end }),
              ContentLength: end - start + 1,
            }),
          ),
        );
        parts.push({ ETag: part.ETag!, PartNumber: n });
      }
      await this.call('Finishing the upload', () =>
        this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key,
            UploadId,
            MultipartUpload: { Parts: parts },
          }),
        ),
      );
    } catch (error) {
      await this.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key,
            UploadId,
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<StoredBackup[]> {
    const out: StoredBackup[] = [];
    let token: string | undefined;
    do {
      const page = await this.call('Listing', () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.prefix,
            ContinuationToken: token,
          }),
        ),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(this.prefix.length) ?? '';
        const at = backupTimeOf(name);
        if (at) out.push({ name, at });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(name: string): Promise<void> {
    if (!BACKUP_NAME.test(name))
      throw new Error(`Not a backup's name: ${name}`);
    await this.call('Deleting', () =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(name) }),
      ),
    );
  }

  async test(): Promise<void> {
    const Key = this.key(`.openfolia-location-test-${randomUUID()}`);
    const body = `openfolia location test ${new Date().toISOString()}`;
    const raw = async <T>(what: string, work: () => Promise<T>) => {
      try {
        return await work();
      } catch (error) {
        throw new Error(`${what} failed: ${describeS3Error(error)}`, {
          cause: error,
        });
      }
    };
    await raw('Writing a test object', () =>
      this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key, Body: body }),
      ),
    );
    try {
      const got = await raw('Reading it back', () =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key })),
      );
      const back = await got.Body?.transformToString();
      if (back !== body)
        throw new Error('What was read back differs from what was written.');
    } finally {
      await raw('Deleting it', () =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })),
      );
    }
  }

  /** A backup's object, as a stream (for a restore). */
  async download(name: string): Promise<NodeJS.ReadableStream> {
    const got = await this.call('Downloading', () =>
      this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(name) }),
      ),
    );
    return got.Body as NodeJS.ReadableStream;
  }
}

/** `BackupTargets` over the backup volume (`CCMS_BACKUP_DIR`) and S3. */
export class FsAndS3BackupTargets extends BackupTargets {
  constructor(
    private readonly volume: string,
    private readonly connections: { readonly allowPrivate: boolean } = {
      allowPrivate: false,
    },
  ) {
    super();
  }

  open(location: BackupLocation, s3Secret: string | undefined): BackupTarget {
    if (location.kind === 'local')
      return new LocalBackupTarget(this.volume, location.subfolder);
    return new S3BackupTarget(location, s3Secret, this.connections);
  }
}
