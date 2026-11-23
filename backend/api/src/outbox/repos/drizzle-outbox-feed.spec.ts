import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { BLOCKED, START } from '../core/outbox-feed.js';
import { DrizzleOutboxFeed } from './drizzle-outbox-feed.js';

let database: PgliteDatabase;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(() => database?.close());

/** Writes an outbox row, as its own transaction or with the transaction ID given. */
async function row(key: string, tx?: string) {
  await database.db.execute(
    tx === undefined
      ? sql`insert into outbox (topic, key, payload) values ('change-set.submit', ${key}, '{}')`
      : sql`insert into outbox (topic, key, payload, tx_id) values ('change-set.submit', ${key}, '{}', ${tx}::xid8)`,
  );
}

/** A read that is not `BLOCKED`. */
function opened<T>(read: T | typeof BLOCKED): T {
  if (read === BLOCKED) throw new Error('blocked');
  return read;
}

describe('DrizzleOutboxFeed', () => {
  it('reads from the start, in transaction order, and moves the cursor by compare-and-swap', async () => {
    const feed = new DrizzleOutboxFeed(database);
    const unit = new DrizzleUnitOfWork(database);
    await row('a');
    await row('b');
    const first = opened(await feed.read('notifications', 10));
    expect(first.from).toEqual(START);
    expect(first.events.map((e) => e.key)).toEqual(['a', 'b']);
    const last = first.events[1]?.position;
    if (!last) throw new Error('no rows');
    expect(
      await unit.run((tx) => feed.advance(tx, 'notifications', START, last)),
    ).toBe(true);
    // Moved already: a second server's move from the same place fails.
    expect(
      await unit.run((tx) => feed.advance(tx, 'notifications', START, last)),
    ).toBe(false);
    await row('c');
    const next = opened(await feed.read('notifications', 10));
    expect(next.from).toEqual(last);
    expect(next.events.map((e) => e.key)).toEqual(['c']);
    // Another consumer has its own cursor.
    expect(
      opened(await feed.read('webhooks', 10)).events.map((e) => e.key),
    ).toEqual(['a', 'b', 'c']);
  });

  it('orders by transaction, not by ID, and holds a consumer at a transaction ID past every one handed out', async () => {
    const feed = new DrizzleOutboxFeed(database);
    const [{ now } = { now: '0' }] = (
      await database.db.execute<{ now: string }>(
        sql`select pg_current_xact_id()::text as now`,
      )
    ).rows;
    const older = String(BigInt(now) - 5n);
    // A row inserted first by a later transaction, then one by an earlier
    // transaction (it committed after): the earlier transaction's comes first.
    await row('later', String(BigInt(now) - 2n));
    await row('earlier', older);
    const read = opened(await feed.read('notifications', 10));
    expect(read.events.map((e) => e.key)).toEqual(['earlier', 'later']);
    expect(read.events[0]?.position.tx).toBe(older);
    expect(opened(await feed.read('notifications', 1)).events).toHaveLength(1);
    // A transaction ID past every one handed out is no transaction still
    // running here but another server's (a restore, #619): the consumer is
    // held (outbox-restore.spec.ts), never read past it.
    await row('ahead', String(BigInt(now) + 1_000_000n));
    expect(await feed.read('notifications', 10)).toBe(BLOCKED);
  });

  it('refuses a consumer name that is no key', async () => {
    const feed = new DrizzleOutboxFeed(database);
    await expect(feed.read('No Name', 1)).rejects.toThrow('no outbox consumer');
  });
});
