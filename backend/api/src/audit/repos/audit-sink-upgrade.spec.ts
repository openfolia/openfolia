import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PgliteDatabase, PGLITE_EXTENSIONS } from '../../../tests/database.js';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
} from '../../database/database.js';
import { type AuditPosition, SINK_START } from '../core/audit-sink.js';
import { DrizzleAuditLog } from './drizzle-audit-log.js';
import { DrizzleAuditSinkCursor } from './drizzle-audit-sink-cursor.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const migrateWith = (client: PGlite, folder: string) =>
  migrate(drizzle({ client }), {
    migrationsFolder: folder,
    migrationsSchema: MIGRATIONS_TABLE.schema,
    migrationsTable: MIGRATIONS_TABLE.table,
  });

// An installation upgraded to the sink and retention (#379): its audit log was
// recorded before `tx_id` existed. Its events all take the migration's own
// transaction, so the sink sends them first, in ID order, then the new ones.
describe('the audit sink migration on an existing installation', () => {
  let client: PGlite;
  let before: string;

  beforeAll(async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const index = journal.entries.findIndex((e) =>
      e.tag.endsWith('_audit_sink_retention'),
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

  it('gives the old events one transaction, sends them in ID order before the new ones, and prunes them', async () => {
    for (const [id, days] of [
      ['old-1', 60],
      ['old-2', 50],
      ['old-3', 0],
    ] as const) {
      await client.query(
        `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id, at)
         values ('user', 'ada', 'role.update', 'role', $1, now() - $2 * interval '1 day')`,
        [id, days],
      );
    }
    const file = await client.query<{ node: number }>(
      `select pg_relation_filenode('audit_events') as node`,
    );

    await migrateWith(client, MIGRATIONS_FOLDER);

    // Added without rewriting the table (a stable default, kept in the catalogue).
    const after = await client.query<{ node: number }>(
      `select pg_relation_filenode('audit_events') as node`,
    );
    expect(after.rows[0]!.node).toBe(file.rows[0]!.node);
    const txs = await client.query<{ n: number }>(
      `select count(distinct tx_id)::int as n from audit_events`,
    );
    expect(txs.rows[0]!.n).toBe(1);

    await client.query(
      `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id)
       values ('user', 'ada', 'role.update', 'role', 'new')`,
    );
    const database = new PgliteDatabase(client);
    const cursor = new DrizzleAuditSinkCursor(database);
    const from = await cursor.claim('one', 60_000);
    expect(from).toEqual(SINK_START);
    expect(
      (await cursor.read(from as AuditPosition, 10)).map(
        (e) => e.event.subject.id,
      ),
    ).toEqual(['old-1', 'old-2', 'old-3', 'new']);

    const log = new DrizzleAuditLog(database);
    expect(
      await log.prune(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 100),
    ).toBe(2);
    await expect(client.query(`delete from audit_events`)).rejects.toThrow(
      'DELETE is allowed only through audit_events_prune',
    );
  });
});
