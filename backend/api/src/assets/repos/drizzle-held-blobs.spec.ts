import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { brandingImages } from '../../branding/repos/branding.tables.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { imports } from '../../imports/repos/imports.tables.js';
import { DrizzleHeldBlobs } from './drizzle-held-blobs.js';

const BUNDLE = 'a'.repeat(64);
const IMAGE = 'b'.repeat(64);
const BOTH = 'c'.repeat(64);
const NEITHER = 'd'.repeat(64);

describe('DrizzleHeldBlobs', () => {
  let database: PgliteDatabase;
  let held: DrizzleHeldBlobs;
  let unit: DrizzleUnitOfWork;

  beforeEach(async () => {
    database = await createTestDatabase();
    held = new DrizzleHeldBlobs(database);
    unit = new DrizzleUnitOfWork(database);
    const now = new Date();
    const anImport = (id: string, sha256: string) => ({
      id,
      importerId: 'bundle',
      options: {},
      updateExisting: false,
      baseRef: 'main',
      baseCommit: 'e'.repeat(40),
      createdByKind: 'user',
      createdById: 'sample-importer',
      fileName: 'bundle.zip',
      uploadSha256: sha256,
      uploadSize: 10,
      uploadCreated: true,
      state: 'validated',
      report: {},
      progress: {},
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    await database.db
      .insert(imports)
      .values([
        anImport('01900000-0000-7000-8000-000000000001', BUNDLE),
        anImport('01900000-0000-7000-8000-000000000002', BOTH),
      ]);
    const anImage = (sha256: string) => ({
      sha256,
      contentType: 'image/png',
      size: 10,
      width: 1,
      height: 1,
      uploadedByKind: 'user',
      uploadedById: 'sample-admin',
      uploadedAt: now,
    });
    await database.db
      .insert(brandingImages)
      .values([anImage(IMAGE), anImage(BOTH)]);
  });

  afterEach(async () => {
    await database.close();
  });

  it('names who holds a blob, the import first', async () => {
    await unit.run(async (tx) => {
      expect(await held.holds(tx, BUNDLE)).toBe('import');
      expect(await held.holds(tx, IMAGE)).toBe('branding');
      expect(await held.holds(tx, BOTH)).toBe('import');
      expect(await held.holds(tx, NEITHER)).toBeNull();
    });
  });

  it('answers for one holder only when asked (#602)', async () => {
    await unit.run(async (tx) => {
      expect(await held.holds(tx, BOTH, 'branding')).toBe('branding');
      expect(await held.holds(tx, BUNDLE, 'branding')).toBeNull();
      expect(await held.holds(tx, BOTH, 'import')).toBe('import');
      expect(await held.holds(tx, IMAGE, 'import')).toBeNull();
    });
  });
});
