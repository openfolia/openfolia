import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { START } from '../../outbox/core/outbox-feed.js';
import { DrizzleChangeFeedSource } from './drizzle-change-feed-source.js';
import { DrizzleFeedScopes } from './drizzle-feed-scopes.js';

let database: PgliteDatabase;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(() => database?.close());

const r1 = '0190f4e2-7c1a-7b3e-9a4d-000000000001';
const r2 = '0190f4e2-7c1a-7b3e-9a4d-000000000002';

/** Writes an outbox row, as its own transaction or with the transaction ID given. */
async function row(topic: string, key: string, tx?: string) {
  const payload = JSON.stringify({ releaseId: key });
  await database.db.execute(
    tx === undefined
      ? sql`insert into outbox (topic, key, payload) values (${topic}, ${key}, ${payload}::jsonb)`
      : sql`insert into outbox (topic, key, payload, tx_id) values (${topic}, ${key}, ${payload}::jsonb, ${tx}::xid8)`,
  );
}

describe('DrizzleChangeFeedSource', () => {
  it('reads only the feed’s topics, in order, after a position', async () => {
    const source = new DrizzleChangeFeedSource(database);
    expect(await source.horizon()).toEqual(START);
    await row('release.published', r1);
    await row('change-set.submit', 'not-ours');
    await row('module.deprecated', 'm');
    const all = await source.after(START, 10);
    expect(all.map((r) => r.topic)).toEqual([
      'release.published',
      'module.deprecated',
    ]);
    expect(await source.horizon()).toEqual(all[1]?.position);
    const first = all[0]?.position;
    if (!first) throw new Error('no rows');
    expect((await source.after(first, 10)).map((r) => r.key)).toEqual(['m']);
    expect(await source.after(START, 1)).toHaveLength(1);
  });

  it('leaves a transaction not settled for later, and orders by transaction', async () => {
    const source = new DrizzleChangeFeedSource(database);
    const [{ now } = { now: '0' }] = (
      await database.db.execute<{ now: string }>(
        sql`select pg_current_xact_id()::text as now`,
      )
    ).rows;
    await row('release.published', r2, String(BigInt(now) - 2n));
    await row('release.published', r1, String(BigInt(now) - 5n));
    await row('module.deprecated', 'running', String(BigInt(now) + 1_000_000n));
    expect((await source.after(START, 10)).map((r) => r.key)).toEqual([r1, r2]);
    expect((await source.horizon()).tx).toBe(String(BigInt(now) - 2n));
  });

  it('is held once an outbox row lies past every transaction (a restore, #619), latched until cleared', async () => {
    const source = new DrizzleChangeFeedSource(database);
    await row('release.published', r1);
    expect(await source.blocked()).toBe(false);
    await database.client.exec(`update outbox set tx_id = '999999999999'`);
    expect(await source.blocked()).toBe(true);
    // The restore recipe's renumbering alone does not clear it.
    await database.client.exec(`update outbox set tx_id = '1'`);
    expect(await source.blocked()).toBe(true);
    await database.client.exec(
      `update outbox_consumers set blocked = false where name = 'change-feed'`,
    );
    expect(await source.blocked()).toBe(false);
  });

  it('tells whether a position still stands on its row', async () => {
    const source = new DrizzleChangeFeedSource(database);
    await row('release.published', r1);
    const [at] = await source.after(START, 1);
    if (!at) throw new Error('no rows');
    expect(await source.holds(START)).toBe(true);
    expect(await source.holds(at.position)).toBe(true);
    await database.client.exec(`update outbox set tx_id = '1'`);
    expect(await source.holds(at.position)).toBe(false);
    expect(await source.holds({ tx: '1', id: at.position.id })).toBe(true);
    expect(await source.holds({ tx: '1', id: at.position.id + 1 })).toBe(false);
  });

  it('tells the release standing at a position, withdrawals up to it counted', async () => {
    const source = new DrizzleChangeFeedSource(database);
    await row('release.published', r1);
    await row('release.published', r2);
    await row('release.withdrawn', r2);
    const [p1, p2, w2] = (await source.after(START, 10)).map((r) => r.position);
    if (!p1 || !p2 || !w2) throw new Error('no rows');
    expect(await source.standingAt(START)).toBeUndefined();
    expect(await source.standingAt(p1)).toBe(r1);
    // Withdrawn later: it stood at its own row.
    expect(await source.standingAt(p2)).toBe(r2);
    expect(await source.standingAt(w2)).toBe(r1);
  });
});

describe('DrizzleFeedScopes', () => {
  it('keeps scopes by digest, the first ones when saved twice', async () => {
    const scopes = new DrizzleFeedScopes(database);
    const digest = 'a'.repeat(64);
    expect(await scopes.find(digest)).toBeUndefined();
    await scopes.save(digest, ['{"languages":["en"]}']);
    await scopes.save(digest, ['{}']);
    expect(await scopes.find(digest)).toEqual(['{"languages":["en"]}']);
  });
});
