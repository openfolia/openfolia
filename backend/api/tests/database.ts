import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fromPglite } from 'pg-boss';
import { inject } from 'vitest';
import {
  Database,
  type Drizzle,
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
} from '../src/database/database.js';
import * as schema from '../src/database/schema.js';
import { installJobQueue } from '../src/jobs/repos/pg-boss-jobs.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The migrated template's data directory (`tests/global-setup.ts`). */
    pgliteTemplate?: string;
  }
}

/**
 * The extensions a test database can create: `pg_trgm` (the migrations
 * create it, #54) and pgvector (the Postgres search creates it when an
 * embedder is configured).
 */
export const PGLITE_EXTENSIONS = { pg_trgm, vector };

/** `Database` over an in-memory PGlite: Postgres in the test process. */
export class PgliteDatabase extends Database {
  readonly db: Drizzle;
  readonly target = 'in-memory PGlite';

  /** Without a client: an empty database, no migrations applied. */
  constructor(
    readonly client: PGlite = new PGlite({ extensions: PGLITE_EXTENSIONS }),
  ) {
    super();
    this.db = drizzle({ client, schema });
  }

  async migrate(): Promise<void> {
    await migrate(drizzle({ client: this.client }), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_TABLE.schema,
      migrationsTable: MIGRATIONS_TABLE.table,
    });
  }

  async close(): Promise<void> {
    if (!this.client.closed) await this.client.close();
  }
}

/**
 * An empty database with every migration applied and the job queue's
 * schema installed (pg-boss, as `db-migrate` does), as a data directory dump.
 */
export async function migratedDataDir(): Promise<Blob> {
  const database = new PgliteDatabase();
  try {
    await database.migrate();
    await installJobQueue({
      db: fromPglite(database.client),
      backend: 'pglite',
    });
    return await database.client.dumpDataDir('none');
  } finally {
    await database.close();
  }
}

let template: Promise<Blob> | undefined;

/**
 * Starting PGlite from a dump takes a fraction of creating and migrating a
 * database, so every test database is a copy of one template: the one the
 * global setup made for this run, or (without it) one made here.
 */
function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const file = inject('pgliteTemplate');
    return file ? new Blob([await readFile(file)]) : migratedDataDir();
  })();
  return template;
}

/**
 * A fresh database with every migration applied, for one test file (or one
 * test): nothing is shared, so tests may run in any order. Close it in
 * `afterAll`/`afterEach` (`createTestApp` closes the one it uses). No
 * Docker, no network.
 */
export async function createTestDatabase(): Promise<PgliteDatabase> {
  return new PgliteDatabase(
    await PGlite.create({
      loadDataDir: await migratedTemplate(),
      extensions: PGLITE_EXTENSIONS,
    }),
  );
}
