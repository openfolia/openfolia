import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  FakeSnapshot,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { PGLITE_EXTENSIONS, PgliteDatabase } from '../../../tests/database.js';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
} from '../../database/database.js';
import { NoEmbedder } from './no-embedder.js';
import { PostgresContentSearch } from './postgres-content-search.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const migrateWith = (client: PGlite, folder: string) =>
  migrate(drizzle({ client }), {
    migrationsFolder: folder,
    migrationsSchema: MIGRATIONS_TABLE.schema,
    migrationsTable: MIGRATIONS_TABLE.table,
  });

// A database searched before #643: scopes stored one row per document. The
// migration drops them (a rebuildable index), keeps the documents and
// numbers them, and the next search writes the scope again as member sets.
describe('the member sets migration on a database holding scopes', () => {
  let client: PGlite;
  let before: string;

  beforeAll(async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const index = journal.entries.findIndex((e) =>
      e.tag.endsWith('_search_scope_sets'),
    );
    expect(index).toBeGreaterThan(0);
    before = await mkdtemp(join(tmpdir(), 'openfolia-migrations-'));
    await cp(MIGRATIONS_FOLDER, before, { recursive: true });
    await writeFile(
      join(before, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }),
    );
    client = new PGlite({ extensions: PGLITE_EXTENSIONS });
    await migrateWith(client, before);
  });

  afterAll(async () => {
    await client?.close();
    if (before) await rm(before, { recursive: true, force: true });
  });

  it('drops the stored scopes, keeps and numbers the documents, and searches again', async () => {
    const db = drizzle({ client });
    const documents = ['1:english:aaa', '1:english:bbb'];
    for (const key of documents) {
      await db.execute(sql`
        insert into search_documents (key, config, kind, keyword_set, title_folded,
          keywords_folded, title_tsv, head_tsv)
        values (${key}, 'english', 'module', '{}', 'old', '', '', '')`);
    }
    await db.execute(
      sql`insert into search_scopes (digest) values (${'a'.repeat(64)})`,
    );
    for (const key of documents) {
      await db.execute(sql`
        insert into search_scope_members (scope, doc_key) values (${'a'.repeat(64)}, ${key})`);
    }

    await migrateWith(client, MIGRATIONS_FOLDER);

    const { rows: scopes } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from search_scopes`,
    );
    expect(scopes[0]?.n).toBe(0);
    const { rows: numbered } = await db.execute<{ key: string; id: string }>(
      sql`select key, id::text as id from search_documents order by key`,
    );
    expect(numbered.map((row) => row.key)).toEqual(documents);
    expect(new Set(numbered.map((row) => row.id)).size).toBe(2);
    const { rows: old } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_class where relname = 'search_scope_members'`,
    );
    expect(old[0]?.n).toBe(0);

    const search = new PostgresContentSearch(
      new PgliteDatabase(client),
      new NoEmbedder(),
      undefined,
      {
        indexesKept: 2,
        minSimilarity: 0.5,
        timeoutMs: 5_000,
        concurrency: 1,
        now: () => 0,
      },
    );
    const content = readable(
      new FakeSnapshot({ modules: [module('pump', 'en', 'The pump starts.')] }),
    );
    const found = await search.search(
      content,
      'pump',
      {},
      { number: 1, size: 10 },
    );
    expect(found.items.map((hit) => hit.id)).toEqual(['en/pump']);
    const { rows: written } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from search_scopes where cardinality(sets) > 0`,
    );
    expect(written[0]?.n).toBe(1);
  });
});
