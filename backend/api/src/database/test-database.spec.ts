import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../../tests/database.js';
import { MIGRATIONS_FOLDER } from './database.js';

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as { entries: { idx: number; when: number; tag: string }[] };

describe('the migrations', () => {
  // Drizzle applies a migration only when its `when` is later than the last
  // one applied, so an entry out of order would be skipped on every
  // existing database (and still pass on fresh test databases).
  it('are journalled in order, with strictly increasing timestamps', () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(entry.tag.startsWith(String(index).padStart(4, '0') + '_')).toBe(
        true,
      );
      const previous = journal.entries[index - 1];
      if (previous) expect(entry.when).toBeGreaterThan(previous.when);
    });
  });
});

describe('createTestDatabase', () => {
  it('gives a database with every committed migration applied', async () => {
    const database = await createTestDatabase();
    try {
      const rows = await database.db.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(rows.rows[0]?.count).toBe(journal.entries.length);
      expect(journal.entries[0]?.tag).toBe('0000_init');
    } finally {
      await database.close();
    }
  });

  it('gives each caller its own database', async () => {
    const [a, b] = await Promise.all([
      createTestDatabase(),
      createTestDatabase(),
    ]);
    try {
      await a.db.execute(sql`create table only_in_a (id int)`);
      const inB = await b.db.execute<{ name: string | null }>(
        sql`select to_regclass('only_in_a')::text as name`,
      );
      expect(inB.rows[0]?.name).toBeNull();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe('withSessionLock in one process (#527)', () => {
  it('runs one work per key and name at a time, in the order asked, a failure not stopping the next', async () => {
    const database = await createTestDatabase();
    try {
      const order: string[] = [];
      const step =
        (label: string, fail = false) =>
        async () => {
          order.push(`${label} start`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`${label} end`);
          if (fail) throw new Error(label);
          return label;
        };
      const results = await Promise.allSettled([
        database.withSessionLock(1, 'a', step('one', true)),
        database.withSessionLock(1, 'a', step('two')),
        database.withSessionLock(1, 'b', step('other')),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      expect(order.indexOf('one end')).toBeLessThan(order.indexOf('two start'));
      expect(order.indexOf('other start')).toBeLessThan(
        order.indexOf('one end'),
      );
      const aborted = new AbortController();
      aborted.abort(new Error('cut off'));
      await expect(
        database.withSessionLock(1, 'a', step('never'), aborted.signal),
      ).rejects.toThrow('cut off');
      expect(order).not.toContain('never start');
    } finally {
      await database.close();
    }
  });
});
