import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { DrizzleOutboxFeed } from './drizzle-outbox-feed.js';

/**
 * The SQL block of backend/api/README.md, "Outbox", "After a restore", read
 * from the README itself, so the recipe an operator runs is the one tested.
 */
function restoreRecipe(): string {
  return recipeIn('../../../README.md')
    .split('\n')
    .filter((line) => !/^VACUUM\b/i.test(line))
    .join('\n');
}

/** The `-- outbox: after a restore` SQL block of a Markdown file, unindented. */
function recipeIn(path: string): string {
  const text = readFileSync(join(import.meta.dirname, path), 'utf8');
  const marker = '-- outbox: after a restore';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`No "${marker}" block in ${path}.`);
  const end = text.indexOf('```', at);
  return text
    .slice(at, end)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

let database: PgliteDatabase;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(() => database?.close());

/** Writes an outbox row in a transaction of its own (autocommit). */
async function row(key: string) {
  await database.db.execute(
    sql`insert into outbox (topic, key, payload) values ('change-set.submit', ${key}, '{}')`,
  );
}

/**
 * As a restore onto another server leaves the database: every row so far
 * carries the old server's transaction count (far past this one's), and
 * the cursors stand where they were there.
 */
async function restored(cursors: Record<string, string>) {
  await database.client.exec(
    `update outbox set tx_id = ('999999000' || id)::xid8;`,
  );
  for (const [name, key] of Object.entries(cursors)) {
    await database.client.query(
      `insert into outbox_consumers (name, last_tx_id, last_outbox_id)
       select $1, tx_id, id from outbox where key = $2`,
      [name, key],
    );
  }
}

/** Reads everything for `consumer`, moving its cursor batch by batch; the keys read. */
async function drain(feed: DrizzleOutboxFeed, consumer: string) {
  const unit = new DrizzleUnitOfWork(database);
  const keys: string[] = [];
  for (;;) {
    const read = await feed.read(consumer, 2);
    if (read === 'blocked') throw new Error(`${consumer} is blocked`);
    const last = read.events.at(-1);
    if (!last) return keys;
    keys.push(...read.events.map((e) => e.key));
    const moved = await unit.run((tx) =>
      feed.advance(tx, consumer, read.from, last.position),
    );
    if (!moved) throw new Error('the cursor moved meanwhile');
  }
}

describe('the outbox after a restore onto another server (#619)', () => {
  it('has the same recipe in the user guide as in the README, in both languages', () => {
    const readme = recipeIn('../../../README.md');
    for (const page of ['after-a-restore.mdx', 'after-a-restore.de.mdx']) {
      expect(
        recipeIn(
          `../../../../../frontend/docs/content/docs/guide/self-hosting/${page}`,
        ),
      ).toBe(readme);
    }
  });

  it('stops delivery when a cursor lies ahead of this database, latches it, and skips nothing', async () => {
    for (const key of ['r1', 'r2']) await row(key);
    await restored({ notifications: 'r2' });
    // Recorded on the restored stack: its transaction count is far lower.
    await row('new1');
    const feed = new DrizzleOutboxFeed(database);
    expect(await feed.read('notifications', 10)).toBe('blocked');
    expect(await feed.blocked()).toEqual(['notifications']);
    // The cursor did not move: nothing was stepped over.
    const [cursor] = (
      await database.client.query<{ tx: string; id: string }>(
        `select last_tx_id::text as tx, last_outbox_id::text as id from outbox_consumers where name = 'notifications'`,
      )
    ).rows;
    expect(cursor).toEqual({ tx: '9999990002', id: '2' });
  });

  it('stops a consumer at the start too when restored rows lie ahead', async () => {
    await row('r1');
    await restored({});
    await row('new1');
    expect(await new DrizzleOutboxFeed(database).read('webhooks', 10)).toBe(
      'blocked',
    );
  });

  it('stays blocked once found, even when nothing lies ahead any more, until the recipe clears it', async () => {
    await row('r1');
    await restored({ notifications: 'r1' });
    const feed = new DrizzleOutboxFeed(database);
    expect(await feed.read('notifications', 10)).toBe('blocked');
    // As if this server's count had caught up: the latch still holds.
    await database.client.exec(
      `update outbox set tx_id = '1'; update outbox_consumers set last_tx_id = '1';`,
    );
    expect(await feed.read('notifications', 10)).toBe('blocked');
    await database.client.exec(`update outbox_consumers set blocked = false;`);
    expect(await feed.read('notifications', 10)).not.toBe('blocked');
  });

  it('the recipe (backend/api/README.md, "Outbox", "After a restore") delivers every event once, in order, for every consumer', async () => {
    for (const key of ['r1', 'r2', 'r3', 'r4']) await row(key);
    // Notifications had handled r1 and r2, webhooks everything; a third never read.
    await restored({ notifications: 'r2', webhooks: 'r4' });
    await row('new1');
    await row('new2');
    const feed = new DrizzleOutboxFeed(database);
    expect(await feed.read('notifications', 10)).toBe('blocked');
    expect(await feed.read('webhooks', 10)).toBe('blocked');

    await database.client.exec(restoreRecipe());

    expect(await feed.blocked()).toEqual([]);
    expect(await drain(feed, 'notifications')).toEqual([
      'r3',
      'r4',
      'new1',
      'new2',
    ]);
    expect(await drain(feed, 'webhooks')).toEqual(['new1', 'new2']);
    expect(await drain(feed, 'reports')).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'new1',
      'new2',
    ]);
    // Recorded after the recipe: read next, once.
    await row('new3');
    expect(await drain(feed, 'notifications')).toEqual(['new3']);
    expect(await drain(feed, 'notifications')).toEqual([]);
  });

  it('the recipe never moves a cursor past an event it had not handled, whatever the old transaction order', async () => {
    for (const key of ['r1', 'r2', 'r3']) await row(key);
    await restored({});
    // On the old server r2's transaction got its ID before r1's: r2 came first.
    await database.client.exec(
      `update outbox set tx_id = '9999990005' where key = 'r1';
       update outbox set tx_id = '9999990001' where key = 'r2';
       update outbox set tx_id = '9999990009' where key = 'r3';
       insert into outbox_consumers (name, last_tx_id, last_outbox_id)
         select 'notifications', tx_id, id from outbox where key = 'r2';`,
    );
    await database.client.exec(restoreRecipe());
    // r1 was not handled, so it comes again; r2 with it (at least once).
    expect(
      await drain(new DrizzleOutboxFeed(database), 'notifications'),
    ).toEqual(['r1', 'r2', 'r3']);
  });
});
