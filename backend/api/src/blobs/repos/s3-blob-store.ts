import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import {
  assertSha256,
  blobStoreUnavailable,
  BlobStore,
  checkPutOptions,
  isMediaType,
  isSha256,
  type BlobEntry,
  type BlobInfo,
  type BlobPage,
  type BlobRef,
  type PutResult,
  type PutOptions,
  type StoredBlob,
} from '../core/blob-store.js';
import { digest } from '../core/digest.js';

export interface S3Settings {
  /** For an S3-compatible service; unset for AWS itself. */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`), which most self-hosted services need. */
  forcePathStyle: boolean;
  /** Unset: the SDK's default chain (environment, shared files, instance or task role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** Per request; a store slower than this counts as unavailable. */
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;
/** A readiness ping slower than this is aborted (the health check's deadline). */
const PING_TIMEOUT_MS = 2_000;
/** Tries of a put (each with a fresh stream of the spooled file). */
const PUT_ATTEMPTS = 3;

/**
 * `BlobStore` on S3 or any S3-compatible service, one object per blob,
 * keyed by its SHA-256 in `bucket`.
 *
 * A put first spools the bytes to a private temporary folder while hashing
 * them (the key is known only at the end), then uploads the file with its
 * length and `x-amz-checksum-sha256`, so the service itself refuses bytes
 * that do not match the hash. The upload is idempotent (same key, same
 * bytes), so it is tried again on a failure, each time from the start of
 * the file; the SDK's own retries are off for it, since they cannot rewind
 * a stream. Other calls use the SDK's retries.
 *
 * Only a 404 means "missing"; any other failure (network, credentials, a
 * 5xx) is logged and thrown as `blob-store-unavailable`, so an outage never
 * looks like a deleted blob.
 */
export class S3BlobStore extends BlobStore {
  private readonly logger = new Logger('BlobStore');
  private readonly client: S3Client;
  private readonly putClient: S3Client;
  private readonly bucket: string;

  constructor(settings: S3Settings) {
    super();
    const common = {
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.credentials ? { credentials: settings.credentials } : {}),
      // Only the checksums asked for: S3-compatible services differ in
      // which of the SDK's default ones (CRC32 trailers) they accept.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: {
        requestTimeout: REQUEST_TIMEOUT_MS,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
      },
    } as const;
    this.client = new S3Client({ ...common, maxAttempts: 3 });
    this.putClient = new S3Client({ ...common, maxAttempts: 1 });
    this.bucket = settings.bucket;
  }

  async put(
    data: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult> {
    checkPutOptions(options);
    const folder = await mkdtemp(join(tmpdir(), 'openfolia-blob-'));
    try {
      const path = join(folder, 'upload');
      const file = await open(path, 'wx', 0o600);
      let ref: BlobRef;
      try {
        ref = await digest(data, options.maxBytes, async (chunk) => {
          await file.write(chunk);
        });
      } finally {
        await file.close();
      }
      const existing = await this.head(ref.sha256);
      // A complete copy is there already: a no-op. One of another length
      // (a damaged object) is replaced by these verified bytes.
      if (existing?.size === ref.size) return { ...ref, created: false };
      const checksum = Buffer.from(ref.sha256, 'hex').toString('base64');
      for (let attempt = 1; ; attempt++) {
        const body = createReadStream(path);
        try {
          await this.putClient.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: ref.sha256,
              Body: body,
              ContentLength: ref.size,
              ContentType: options.contentType,
              ChecksumSHA256: checksum,
            }),
          );
          // A repaired copy is not new: content may refer to it already.
          return { ...ref, created: existing === undefined };
        } catch (error) {
          if (attempt >= PUT_ATTEMPTS || !retryable(error)) {
            throw this.#unavailable('put', error);
          }
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        } finally {
          body.destroy();
        }
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    assertSha256(sha256);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: sha256 }),
      );
      if (!(out.Body instanceof Readable)) {
        throw new Error('the response body is not a stream');
      }
      if (out.ContentLength === undefined) {
        out.Body.destroy();
        throw new Error('the response has no Content-Length');
      }
      return {
        sha256,
        size: out.ContentLength,
        contentType: storedType(out.ContentType),
        storedAt: storedAt(out.LastModified),
        stream: out.Body,
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw this.#unavailable('get', error);
    }
  }

  async head(sha256: string): Promise<BlobInfo | undefined> {
    assertSha256(sha256);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: sha256 }),
      );
      if (out.ContentLength === undefined) {
        throw new Error('the response has no Content-Length');
      }
      return {
        sha256,
        size: out.ContentLength,
        contentType: storedType(out.ContentType),
        storedAt: storedAt(out.LastModified),
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw this.#unavailable('head', error);
    }
  }

  /** At most 1,000 keys per page (S3's own page), in key order: the hash's. */
  async list(after?: string): Promise<BlobPage> {
    if (after !== undefined && (after.length === 0 || after.length > 1024)) {
      throw new TypeError('Not a cursor of this store.');
    }
    let out;
    try {
      out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          MaxKeys: 1000,
          ...(after !== undefined ? { StartAfter: after } : {}),
        }),
      );
    } catch (error) {
      throw this.#unavailable('list', error);
    }
    const contents = out.Contents ?? [];
    const blobs: BlobEntry[] = contents.flatMap((object) =>
      isSha256(object.Key) && object.Size !== undefined
        ? [
            {
              sha256: object.Key,
              size: object.Size,
              storedAt: storedAt(object.LastModified),
            },
          ]
        : [],
    );
    const last = contents.at(-1)?.Key;
    // The last key, a hash or not (another tool's object), is where the next page starts.
    return out.IsTruncated && last !== undefined
      ? { blobs, next: last }
      : { blobs };
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: sha256 }),
      );
    } catch (error) {
      if (missing(error)) return;
      throw this.#unavailable('delete', error);
    }
  }

  async ping(): Promise<void> {
    try {
      // One attempt, aborted at the deadline, so a stalled service never
      // piles up pings from the (public) health check.
      await this.putClient.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS) },
      );
    } catch (error) {
      throw this.#unavailable('ping', error);
    }
  }

  /** Logs why (the SDK's messages carry no credentials) and answers with the domain error. */
  #unavailable(operation: string, error: unknown): Error {
    const status =
      error instanceof S3ServiceException
        ? ` (${error.name}, ${error.$metadata.httpStatusCode ?? 'no status'})`
        : '';
    this.logger.error(
      `S3 ${operation} in bucket ${this.bucket} failed${status}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return blobStoreUnavailable();
  }
}

/** A 404 for the object; a missing bucket is a misconfiguration, never "missing". */
function missing(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404 &&
    error.name !== 'NoSuchBucket'
  );
}

/** Network failures, throttling and 5xx; never a refusal (4xx). */
function retryable(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return true;
  const status = error.$metadata.httpStatusCode ?? 0;
  return status === 429 || status >= 500;
}

/** A time the service did not send counts as now: such a blob is never taken for old. */
function storedAt(value: Date | undefined): Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value
    : new Date();
}

function storedType(value: string | undefined): string {
  const type = value?.toLowerCase();
  return isMediaType(type) ? type : 'application/octet-stream';
}
