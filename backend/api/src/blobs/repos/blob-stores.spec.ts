import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { blobStoreContract } from '../../../tests/blob-store-contract.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { UnavailableError } from '../../base/core/errors.js';
import { FsBlobStore } from './fs-blob-store.js';
import { S3BlobStore, type S3Settings } from './s3-blob-store.js';

const PNG = { contentType: 'image/png', maxBytes: 1_000_000 };

describe('FakeBlobStore', () => {
  blobStoreContract(() => new FakeBlobStore());
});

describe('FsBlobStore', () => {
  const roots: string[] = [];
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'openfolia-blobs-'));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  blobStoreContract(() => new FsBlobStore(fresh()));

  it('leaves nothing behind in tmp/, whether a put succeeds or fails', async () => {
    const root = fresh();
    const store = new FsBlobStore(root);
    await store.put(Readable.from([randomBytes(10)]), PNG);
    await store
      .put(Readable.from([randomBytes(10)]), { ...PNG, maxBytes: 5 })
      .catch(() => undefined);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('replaces a damaged copy instead of keeping it as a no-op', async () => {
    const root = fresh();
    const store = new FsBlobStore(root);
    const data = randomBytes(1_000);
    const { sha256 } = await store.put(Readable.from([data]), PNG);
    truncateSync(join(root, sha256.slice(0, 2), sha256), 10);
    const repaired = await store.put(Readable.from([data]), PNG);
    // Not new: content may refer to the hash, so no clean-up may remove it.
    expect(repaired.created).toBe(false);
    expect(await buffer((await store.get(sha256))!.stream)).toEqual(data);
  });

  it('needs an absolute root', () => {
    expect(() => new FsBlobStore('relative/blobs')).toThrow(TypeError);
  });

  it('is unavailable, not empty, when its folder cannot be used', async () => {
    const root = fresh();
    // A file where the folder should be: every operation fails.
    writeFileSync(join(root, 'file'), 'x');
    const store = new FsBlobStore(join(root, 'file', 'blobs'));
    await expect(store.ping()).rejects.toBeInstanceOf(UnavailableError);
    await expect(
      store.put(Readable.from([Buffer.from('x')]), PNG),
    ).rejects.toMatchObject({ code: 'blob-store-unavailable' });
  });
});

describe('S3BlobStore', () => {
  it('is unavailable, never "missing", when the service does not answer', async () => {
    const store = new S3BlobStore({
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      bucket: 'unreachable',
      forcePathStyle: true,
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    const hash = 'a'.repeat(64);
    await expect(store.head(hash)).rejects.toBeInstanceOf(UnavailableError);
    await expect(store.get(hash)).rejects.toBeInstanceOf(UnavailableError);
    await expect(store.ping()).rejects.toMatchObject({
      code: 'blob-store-unavailable',
    });
  });

  /**
   * Against a real S3-compatible service when `CCMS_TEST_S3_ENDPOINT` is
   * set (the compose one: http://127.0.0.1:8333), in a bucket of its own
   * that is removed afterwards.
   */
  const endpoint = process.env['CCMS_TEST_S3_ENDPOINT'];
  describe.runIf(endpoint)(`against ${endpoint ?? 'a service'}`, () => {
    const settings: S3Settings = {
      endpoint: endpoint ?? '',
      region: process.env['CCMS_TEST_S3_REGION'] || 'us-east-1',
      bucket: `openfolia-test-${randomBytes(6).toString('hex')}`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['CCMS_TEST_S3_ACCESS_KEY_ID'] || 'ccms',
        secretAccessKey:
          process.env['CCMS_TEST_S3_SECRET_ACCESS_KEY'] || 'ccms-local-secret',
      },
    };
    const admin = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: settings.credentials,
    });
    beforeAll(async () => {
      await admin.send(new CreateBucketCommand({ Bucket: settings.bucket }));
    });
    afterAll(async () => {
      for (;;) {
        const listed = await admin.send(
          new ListObjectsV2Command({ Bucket: settings.bucket }),
        );
        const keys = (listed.Contents ?? []).map(({ Key }) => ({ Key }));
        if (keys.length === 0) break;
        await admin.send(
          new DeleteObjectsCommand({
            Bucket: settings.bucket,
            Delete: { Objects: keys },
          }),
        );
      }
      await admin.send(new DeleteBucketCommand({ Bucket: settings.bucket }));
      admin.destroy();
    });

    blobStoreContract(() => new S3BlobStore(settings));

    it('is unavailable, not empty, for a bucket that does not exist', async () => {
      const store = new S3BlobStore({
        ...settings,
        bucket: 'openfolia-test-none',
      });
      await expect(store.ping()).rejects.toBeInstanceOf(UnavailableError);
    });
  });
});
