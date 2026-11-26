import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGLITE_EXTENSIONS } from '../../../tests/database.js';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
} from '../../database/database.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const migrateWith = (client: PGlite, folder: string) =>
  migrate(drizzle({ client }), {
    migrationsFolder: folder,
    migrationsSchema: MIGRATIONS_TABLE.schema,
    migrationsTable: MIGRATIONS_TABLE.table,
  });

// An installation upgraded to single sign-on and session limits (#378): nothing about signing in
// changes until an administrator says so, whatever its settings were.
describe('the single sign-on migration on an existing installation', () => {
  let client: PGlite;
  let before: string;
  let through: string;

  beforeAll(async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const index = journal.entries.findIndex((e) =>
      e.tag.endsWith('_enforced_sso'),
    );
    expect(index).toBeGreaterThan(0);
    const upTo = async (count: number) => {
      const folder = await mkdtemp(join(tmpdir(), 'openfolia-migrations-'));
      await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
      await writeFile(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({
          ...journal,
          entries: journal.entries.slice(0, count),
        }),
      );
      return folder;
    };
    before = await upTo(index);
    through = await upTo(index + 1);
    client = new PGlite({ extensions: PGLITE_EXTENSIONS });
    await migrateWith(client, before);
  });

  afterAll(async () => {
    await client?.close();
    for (const folder of [before, through]) {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  });

  it('keeps the settings as they were, and the new ones unset', async () => {
    const db = drizzle({ client });
    await db.execute(sql`insert into users (id, name) values ('pat', 'Pat')`);
    await db.execute(
      sql`insert into installation_settings (id, version, self_approval, second_factor)
          values (1, 4, 'review', 'admins')`,
    );
    await db.execute(
      sql`insert into sessions (token_hash, user_id, provider)
          values (${'a'.repeat(64)}, 'pat', 'password')`,
    );
    await migrateWith(client, through);
    expect(
      (await db.execute(sql`select * from installation_settings`)).rows,
    ).toMatchObject([
      {
        version: 4,
        self_approval: 'review',
        second_factor: 'admins',
        single_sign_on: null,
        break_glass_user_id: null,
        session_idle_minutes: null,
        session_max_hours: null,
      },
    ]);
    expect(
      (await db.execute(sql`select revoked_at from sessions`)).rows,
    ).toEqual([{ revoked_at: null }]);
  });

  it('empties the break-glass account with its user, and holds the bounds', async () => {
    const db = drizzle({ client });
    await db.execute(
      sql`update installation_settings set break_glass_user_id = 'pat'`,
    );
    await db.execute(sql`delete from users where id = 'pat'`);
    expect(
      (
        await db.execute(
          sql`select break_glass_user_id as of_whom from installation_settings`,
        )
      ).rows,
    ).toEqual([{ of_whom: null }]);
    for (const set of [
      sql`single_sign_on = 'maybe'`,
      sql`session_idle_minutes = 4`,
      sql`session_max_hours = 8761`,
    ]) {
      await expect(
        db.execute(sql`update installation_settings set ${set}`),
      ).rejects.toThrow();
    }
  });
});
