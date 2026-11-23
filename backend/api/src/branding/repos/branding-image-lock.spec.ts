import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { actorWith } from '../../../tests/fakes/actors.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { DrizzleAssetUploads } from '../../assets/repos/drizzle-asset-uploads.js';
import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import { StorageQuota } from '../../storage-usage/core/storage-quota.js';
import { DrizzleStorageUsage } from '../../storage-usage/repos/drizzle-storage-usage.js';
import { UploadBrandingImageAction } from '../core/actions/upload-branding-image.action.js';
import { brandingImages } from './branding.tables.js';
import { DrizzleBrandingStore } from './drizzle-branding-store.js';

const brander = { ...actorWith(['admin.branding']), id: 'brander' };

async function* bytesOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** The advisory locks `tx` holds now, as their keys. */
async function advisoryLocks(tx: Transaction): Promise<string[]> {
  const result = await drizzleOf(tx).execute<{ key: string }>(
    sql`select ((classid::bigint << 32) | objid::bigint)::text as key from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted order by key`,
  );
  return result.rows.map((row) => row.key);
}

// A branding image is recorded under its file's hash lock, the one every
// blob delete takes while it checks what holds the bytes (#623).
describe('UploadBrandingImageAction on Postgres', () => {
  let database: PgliteDatabase;
  let unit: DrizzleUnitOfWork;
  let store: DrizzleBrandingStore;
  let uploads: DrizzleAssetUploads;
  let blobs: FakeBlobStore;
  let upload: UploadBrandingImageAction;

  beforeEach(async () => {
    database = await createTestDatabase();
    unit = new DrizzleUnitOfWork(database);
    store = new DrizzleBrandingStore(database);
    uploads = new DrizzleAssetUploads(database);
    blobs = new FakeBlobStore();
    upload = new UploadBrandingImageAction(
      store,
      blobs,
      new DrizzleAuditLog(database),
      unit,
      uploads,
      new StorageQuota(
        new DrizzleStorageUsage(database),
        { limitBytes: null, recountEveryMs: 24 * 3_600_000 },
        unit,
        new DrizzleAuditLog(database),
      ),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  const png = () =>
    sharp({
      create: { width: 8, height: 8, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

  it('records the image while holding its hash lock', async () => {
    const bytes = await png();
    const held: string[][] = [];
    const record = store.recordImage.bind(store);
    store.recordImage = async (tx, image) => {
      held.push(await advisoryLocks(tx));
      return record(tx, image);
    };
    const { image, created } = await upload.handle({
      actor: brander,
      file: () => bytesOf(bytes),
    });
    expect(created).toBe(true);
    const expected = await unit.run(async (tx) => {
      await uploads.lockHash(tx, image.sha256);
      return advisoryLocks(tx);
    });
    expect(expected).toHaveLength(1);
    expect(held).toEqual([expected]);
  });

  it('refuses an image whose blob a clean-up removed before the lock, and records nothing', async () => {
    const bytes = await png();
    const lock = uploads.lockHash.bind(uploads);
    uploads.lockHash = async (tx, hash) => {
      blobs.blobs.delete(hash);
      return lock(tx, hash);
    };
    await expect(
      upload.handle({ actor: brander, file: () => bytesOf(bytes) }),
    ).rejects.toMatchObject({ code: 'upload-interrupted' });
    expect(await database.db.select().from(brandingImages)).toEqual([]);
  });
});
