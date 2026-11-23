import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { DrizzleStorageUsage } from './drizzle-storage-usage.js';

let database: PgliteDatabase;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(() => database?.close());

const EVERY = { everyMs: 3_600_000, claimMs: 3_600_000 };

describe('DrizzleStorageUsage', () => {
  it('starts at nothing, moves never below 0, and adds what came while a recount counted to what it found', async () => {
    const usage = new DrizzleStorageUsage(database);
    const unit = new DrizzleUnitOfWork(database);
    const now = new Date('2026-11-19T10:00:00Z');
    expect(await unit.run((tx) => usage.read(tx))).toMatchObject({
      media: { bytes: 0, files: 0 },
      pdfs: { bytes: 0, files: 0 },
      recountedAt: null,
    });
    await unit.run((tx) => usage.adjust(tx, 'media', { bytes: 100, files: 2 }));
    await unit.run((tx) =>
      usage.adjust(tx, 'media', { bytes: -500, files: -5 }),
    );
    expect((await unit.run((tx) => usage.read(tx))).media).toEqual({
      bytes: 0,
      files: 0,
    });

    expect(await unit.run((tx) => usage.claimRecount(tx, now, EVERY))).toBe(
      true,
    );
    // Once: another server's claim fails while this one holds.
    expect(await unit.run((tx) => usage.claimRecount(tx, now, EVERY))).toBe(
      false,
    );
    // While it counts: an upload and a delete; only the upload is kept apart.
    await unit.run((tx) => usage.adjust(tx, 'media', { bytes: 30, files: 1 }));
    await unit.run((tx) =>
      usage.adjust(tx, 'media', { bytes: -10, files: -1 }),
    );
    await unit.run((tx) => usage.adjust(tx, 'pdfs', { bytes: 7, files: 1 }));
    await unit.run((tx) =>
      usage.recounted(
        tx,
        {
          media: { bytes: 1_000, files: 10 },
          pdfs: { bytes: 50, files: 2 },
          gitBytes: 12,
          databaseBytes: 34,
        },
        now,
      ),
    );
    expect(await unit.run((tx) => usage.read(tx))).toEqual({
      media: { bytes: 1_030, files: 11 },
      pdfs: { bytes: 57, files: 3 },
      gitBytes: 12,
      databaseBytes: 34,
      recountedAt: now,
    });
    // Gathered only while claimed: after the recount nothing is kept apart.
    await unit.run((tx) => usage.adjust(tx, 'media', { bytes: 5, files: 1 }));
    const [row] = (
      await database.db.execute<{ added: string }>(
        sql`select media_added_bytes::text as added from storage_usage`,
      )
    ).rows;
    expect(row?.added).toBe('0');
  });

  it('writes a recount only while its claim holds', async () => {
    const usage = new DrizzleStorageUsage(database);
    const unit = new DrizzleUnitOfWork(database);
    const first = new Date('2026-11-19T10:00:00Z');
    const later = new Date('2026-11-19T12:00:00Z');
    expect(await unit.run((tx) => usage.claimRecount(tx, first, EVERY))).toBe(
      true,
    );
    // Taken over (the first claim looked stale to another server).
    expect(await unit.run((tx) => usage.claimRecount(tx, later, EVERY))).toBe(
      true,
    );
    const count = {
      media: { bytes: 9, files: 1 },
      pdfs: { bytes: 0, files: 0 },
      gitBytes: null,
      databaseBytes: null,
    };
    await unit.run((tx) => usage.recounted(tx, count, first));
    expect((await unit.run((tx) => usage.read(tx))).recountedAt).toBeNull();
    await unit.run((tx) => usage.recounted(tx, count, later));
    expect(await unit.run((tx) => usage.read(tx))).toMatchObject({
      media: { bytes: 9, files: 1 },
      recountedAt: later,
    });
  });

  it('says why a blob is not counted as media', async () => {
    const usage = new DrizzleStorageUsage(database);
    const unit = new DrizzleUnitOfWork(database);
    const source = 'a'.repeat(64);
    const small = 'b'.repeat(64);
    await database.db.execute(
      sql`insert into asset_renditions (source_sha256, width, sha256, size, created_at) values (${source}, 320, ${small}, 10, now())`,
    );
    expect(await unit.run((tx) => usage.apartFromMedia(tx, small))).toBe(
      'rendition',
    );
    expect(
      await unit.run((tx) => usage.apartFromMedia(tx, source)),
    ).toBeUndefined();
  });
});
