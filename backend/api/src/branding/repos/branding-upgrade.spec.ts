import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
} from '../../database/database.js';
import { PGLITE_EXTENSIONS } from '../../../tests/database.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Applies the migrations of `folder` to `client`, as the API does at start. */
const migrateWith = (client: PGlite, folder: string) =>
  migrate(drizzle({ client }), {
    migrationsFolder: folder,
    migrationsSchema: MIGRATIONS_TABLE.schema,
    migrationsTable: MIGRATIONS_TABLE.table,
  });

// An installation upgraded to the branding (#169): its roles were made before
// `admin.branding` existed. The migration grants it to every role holding
// `admin.roles`, so someone can open Branding without editing a role first.
describe('the branding migration on an existing installation', () => {
  let client: PGlite;
  let before: string;
  let through: string;

  beforeAll(async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const index = journal.entries.findIndex((e) => e.tag.endsWith('_branding'));
    expect(index).toBeGreaterThan(0);
    // The migrations as they were before this one: the same folder, a journal ending before it.
    before = await mkdtemp(join(tmpdir(), 'openfolia-migrations-'));
    await cp(MIGRATIONS_FOLDER, before, { recursive: true });
    await writeFile(
      join(before, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }),
    );
    // And up to this one, not past it: a later migration's grants are its own test's.
    through = await mkdtemp(join(tmpdir(), 'openfolia-migrations-'));
    await cp(MIGRATIONS_FOLDER, through, { recursive: true });
    await writeFile(
      join(through, 'meta', '_journal.json'),
      JSON.stringify({
        ...journal,
        entries: journal.entries.slice(0, index + 1),
      }),
    );
    // The extensions of every test database: later migrations create them (#54).
    client = new PGlite({ extensions: PGLITE_EXTENSIONS });
    await migrateWith(client, before);
  });

  afterAll(async () => {
    await client?.close();
    if (before) await rm(before, { recursive: true, force: true });
    if (through) await rm(through, { recursive: true, force: true });
  });

  it('grants admin.branding to the roles holding admin.roles, once, and audits it', async () => {
    const db = drizzle({ client });
    await db.execute(sql`
      insert into roles (id, name, permissions) values
        ('admin', 'Admin', array['content.read', 'webhook.manage', 'admin.roles']),
        ('access-admin', 'Access admin', array['admin.roles']),
        ('author', 'Author', array['content.read', 'content.edit']),
        ('hooks', 'Webhooks', array['webhook.manage'])
    `);

    await migrateWith(client, through);

    const roles = await db.execute<{ id: string; permissions: string[] }>(
      sql`select id, permissions from roles order by id`,
    );
    expect(roles.rows).toEqual([
      { id: 'access-admin', permissions: ['admin.roles', 'admin.branding'] },
      {
        id: 'admin',
        permissions: [
          'content.read',
          'webhook.manage',
          'admin.roles',
          'admin.branding',
        ],
      },
      { id: 'author', permissions: ['content.read', 'content.edit'] },
      { id: 'hooks', permissions: ['webhook.manage'] },
    ]);
    const events = await db.execute<{
      actor_kind: string;
      actor_id: string;
      action: string;
      subject_id: string;
      data: Record<string, unknown>;
    }>(
      sql`select actor_kind, actor_id, action, subject_id, data from audit_events order by subject_id`,
    );
    expect(events.rows).toEqual([
      expect.objectContaining({
        actor_kind: 'service',
        actor_id: 'service:migration',
        action: 'role.update',
        subject_id: 'access-admin',
        data: expect.objectContaining({ added: ['admin.branding'] }),
      }),
      expect.objectContaining({ action: 'role.update', subject_id: 'admin' }),
    ]);

    // Applied once: migrating again changes nothing.
    await migrateWith(client, through);
    const again = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from audit_events`,
    );
    expect(again.rows[0]?.count).toBe(2);
  });
});
