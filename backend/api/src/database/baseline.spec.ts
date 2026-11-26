import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { PgliteDatabase } from '../../tests/database.js';
import { schemaCatalog } from '../../tests/schema-catalog.js';
import { DOMAIN_COMPONENTS, PLATFORM_FOLDERS } from '../components.js';
import {
  BASELINE_TAG,
  BaselineRefused,
  baselineMigration,
  componentsWithoutDomain,
  writeBaseline,
} from './baseline.js';
import { COMPONENT_SCHEMAS } from './component-schemas.js';
import { MIGRATIONS_FOLDER } from './database.js';
import * as schema from './schema.js';

const tablesOf = (exports: Readonly<Record<string, unknown>>) =>
  Object.values(exports).filter((value) => is(value, PgTable));

/** A fresh PGlite with the migrations of `folder` applied, as Drizzle's migrator applies them. */
async function migratedFrom(folder: string): Promise<PGlite> {
  const database = new PgliteDatabase();
  await database.migrate(folder);
  return database.client;
}

let scratch: string;
let committed: string[];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'openfolia-baseline-'));
  const database = new PgliteDatabase();
  try {
    await database.migrate();
    committed = await schemaCatalog(database.client);
  } finally {
    await database.close();
  }
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the schema, split by component', () => {
  it('generates no migration: the committed ones already make it (drizzle-kit)', async () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number }[] };
    const newest = String(journal.entries.at(-1)!.idx).padStart(4, '0');
    const snapshot = JSON.parse(
      readFileSync(
        join(MIGRATIONS_FOLDER, 'meta', `${newest}_snapshot.json`),
        'utf8',
      ),
    ) as Parameters<typeof generateMigration>[0];
    const now = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, now)).toEqual([]);
  });

  it('lists the same tables in schema.ts as in COMPONENT_SCHEMAS, each in one component folder', () => {
    const byComponent = Object.entries(COMPONENT_SCHEMAS).flatMap(
      ([name, part]) => {
        expect(readdirSync(join(import.meta.dirname, '..'))).toContain(name);
        return tablesOf(part.tables);
      },
    );
    expect(new Set(byComponent).size).toBe(byComponent.length);
    expect(new Set(byComponent)).toEqual(new Set(tablesOf(schema)));
  });
});

describe('a baseline migration', () => {
  it('of every component makes the database the committed migrations make', async () => {
    const out = join(scratch, 'all');
    await writeBaseline(
      out,
      await baselineMigration(Object.keys(COMPONENT_SCHEMAS)),
    );
    const client = await migratedFrom(out);
    try {
      expect(await schemaCatalog(client)).toEqual(committed);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('of the platform and the Git workflow (every component but the domain) migrates a fresh database to their part of it', async () => {
    const components = componentsWithoutDomain();
    // Every platform component that has tables (`config` has none).
    expect(components).toEqual(
      expect.arrayContaining(
        PLATFORM_FOLDERS.filter((name) => name in COMPONENT_SCHEMAS),
      ),
    );
    expect(components).toContain('access');
    expect(components).toContain('change-sets');
    expect(components.some((name) => DOMAIN_COMPONENTS.includes(name))).toBe(
      false,
    );
    const out = join(scratch, 'without-domain');
    const written = await writeBaseline(
      out,
      await baselineMigration(components),
    );
    expect(written.map((path) => path.slice(out.length + 1)).sort()).toEqual([
      `${BASELINE_TAG}.sql`,
      join('meta', '0000_snapshot.json'),
      join('meta', '_journal.json'),
    ]);

    const client = await migratedFrom(out);
    try {
      const catalog = await schemaCatalog(client);
      expect(catalog.filter((line) => !committed.includes(line))).toEqual([]);
      const tables = catalog
        .filter((line) => line.startsWith('table '))
        .map((line) => line.split(' ')[1]);
      const expected = components.flatMap((name) =>
        tablesOf(COMPONENT_SCHEMAS[name]!.tables).map((table) =>
          getTableName(table as PgTable),
        ),
      );
      expect(tables.sort()).toEqual(expected.sort());
      // The database's own guards came along: the audit log refuses an update.
      await expect(
        client.exec(`UPDATE "audit_events" SET "action" = 'x'`),
      ).rejects.toThrow('append-only');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('refuses a table whose foreign key points at a component not chosen, naming both', async () => {
    await expect(baselineMigration(['access', 'assets'])).rejects.toThrow(
      new BaselineRefused(
        'Table "asset_uploads" of assets has a foreign key to table "change_sets" of change-sets, which is not chosen: add change-sets or leave out assets.',
      ),
    );
  });

  it('refuses an unknown component, and none', async () => {
    await expect(baselineMigration(['access', 'nope'])).rejects.toThrow(
      /^Unknown component: nope\. Components with tables: access, /,
    );
    await expect(baselineMigration([])).rejects.toThrow(BaselineRefused);
  });

  describe('is written only to a new or empty folder outside the committed migrations', () => {
    let baseline: Awaited<ReturnType<typeof baselineMigration>>;
    beforeAll(async () => {
      baseline = await baselineMigration(['access']);
    });

    it('refuses the committed migrations, a folder in them and a link to them', async () => {
      const link = join(scratch, 'link');
      symlinkSync(MIGRATIONS_FOLDER, link);
      for (const out of [
        MIGRATIONS_FOLDER,
        join(MIGRATIONS_FOLDER, 'baseline'),
        join(MIGRATIONS_FOLDER, 'meta'),
        join(link, 'baseline'),
      ]) {
        await expect(writeBaseline(out, baseline)).rejects.toThrow(
          /is in the committed migrations/,
        );
      }
      expect(readdirSync(MIGRATIONS_FOLDER)).not.toContain('baseline');
    });

    it('refuses a folder with something in it, and a file', async () => {
      const full = join(scratch, 'full');
      mkdirSync(full);
      writeFileSync(join(full, 'keep.txt'), 'mine');
      await expect(writeBaseline(full, baseline)).rejects.toThrow(
        /is not empty/,
      );
      expect(readdirSync(full)).toEqual(['keep.txt']);
      await expect(
        writeBaseline(join(full, 'keep.txt'), baseline),
      ).rejects.toThrow(/is a file/);
    });

    it('makes a folder that is not there yet, parents included', async () => {
      const out = join(scratch, 'new', 'deeper');
      await writeBaseline(out, baseline);
      expect(readdirSync(out).sort()).toEqual([`${BASELINE_TAG}.sql`, 'meta']);
      const sql = readFileSync(join(out, `${BASELINE_TAG}.sql`), 'utf8');
      expect(sql).toMatch(/^-- A baseline migration for a fresh database/);
      expect(sql).not.toMatch(/"audit_events"/);
    });
  });
});
