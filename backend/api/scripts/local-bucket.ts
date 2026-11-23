/**
 * The local blob store's buckets on the compose S3 service (`compose.yaml`,
 * service `s3`): one per checkout, like the databases. `ccms` for the main
 * checkout (created when the service starts), `ccms-<slot>` for an agent
 * slot (`.claude/worktrees/<slot>`), so a branch's test uploads never reach
 * another checkout.
 *
 * `setup-local` creates the checkout's bucket. `pnpm slot remove` deletes a
 * slot's bucket and everything in it:
 *
 *   node backend/api/scripts/local-bucket.ts drop <the slot's worktree>
 *
 * Only ever against the local service (127.0.0.1) with its local
 * credentials, and never the main checkout's bucket.
 */
import { basename, dirname, resolve } from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/** The compose service's address and local-only credentials (compose.yaml). */
export const LOCAL_S3 = {
  endpoint: 'http://127.0.0.1:8333',
  region: 'us-east-1',
  accessKeyId: 'ccms',
  secretAccessKey: 'ccms-local-secret',
};

/**
 * The bucket of the checkout at `root`: `ccms`, or `ccms-<slot>` for a slot's worktree.
 * Compatibility: keeps the working name from before the product was named OpenFolia, as the
 * compose stack's (`compose.yaml`): buckets already made stay in use.
 */
export function localBucket(root: string): string {
  const inSlot =
    basename(dirname(root)) === 'worktrees' &&
    basename(dirname(dirname(root))) === '.claude';
  if (!inSlot) return 'ccms';
  const slot = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slot ? `ccms-${slot}` : 'ccms';
}

export interface S3Target {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function client(target: S3Target): S3Client {
  return new S3Client({
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
  });
}

function isLocal(endpoint: string): boolean {
  return (
    URL.canParse(endpoint) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)
  );
}

/**
 * Creates `bucket` when the local service answers and it is missing; says
 * what to do when the service does not answer. Leaves a non-local endpoint
 * alone. Never prints the credentials.
 */
export async function ensureBucket(
  target: S3Target,
  bucket: string,
): Promise<string> {
  const where = `bucket ${bucket} on ${target.endpoint}`;
  if (!isLocal(target.endpoint)) return `${where} (not local: left as it is)`;
  const s3 = client(target);
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return where;
    } catch (error) {
      if (status(error) !== 404) throw error;
    }
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    return `${where} (created)`;
  } catch (error) {
    return `${where} not reachable or not created (${reason(error)}).
                 Start it with \`docker compose up -d\`, then run setup-local again.`;
  } finally {
    s3.destroy();
  }
}

/** Empties and deletes `bucket` on the local service; `false` when it was not there. */
export async function dropBucket(
  target: S3Target,
  bucket: string,
): Promise<boolean> {
  if (!isLocal(target.endpoint)) throw new Error('not the local S3 service');
  if (bucket === 'ccms') throw new Error("the main checkout's bucket stays");
  const s3 = client(target);
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (status(error) === 404) return false;
      throw error;
    }
    for (let round = 0; ; round++) {
      if (round >= 10_000) throw new Error('the bucket does not empty');
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }),
      );
      const objects = (listed.Contents ?? []).flatMap(({ Key }) =>
        Key === undefined ? [] : [{ Key }],
      );
      if (objects.length === 0) break;
      const deleted = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if (deleted.Errors?.length) {
        throw new Error(
          `${deleted.Errors.length} object(s) not deleted (${deleted.Errors[0]?.Code ?? 'unknown'})`,
        );
      }
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    return true;
  } finally {
    s3.destroy();
  }
}

function status(error: unknown): number | undefined {
  return error instanceof S3ServiceException
    ? error.$metadata.httpStatusCode
    : undefined;
}

function reason(error: unknown): string {
  return error instanceof Error
    ? error.message || (error as { code?: string }).code || error.name
    : String(error);
}

if (import.meta.main) {
  const [command, checkout] = process.argv.slice(2);
  if (command !== 'drop' || !checkout) {
    console.error('Usage: node local-bucket.ts drop <slot worktree>');
    process.exit(2);
  }
  const bucket = localBucket(resolve(checkout));
  try {
    const dropped = await dropBucket(LOCAL_S3, bucket);
    console.log(
      dropped
        ? `Deleted the bucket ${bucket} and its blobs.`
        : `No bucket ${bucket}.`,
    );
  } catch (error) {
    console.error(`Could not delete the bucket ${bucket}: ${reason(error)}`);
    process.exit(1);
  }
}
