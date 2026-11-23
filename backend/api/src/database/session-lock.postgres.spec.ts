import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from './postgres.database.js';

/**
 * `PostgresDatabase.withSessionLock` (#527) on a real Postgres server: two databases (two
 * pools, as two processes have) take turns. PGlite has one session, where an advisory lock
 * never waits, so this needs a server: it runs only when `CCMS_TEST_PG_URL` names one (the
 * compose Postgres), in a database of its own (`ccms_zz_lock_<random>`) that it creates and
 * drops; without it, it is skipped.
 */
const url = process.env['CCMS_TEST_PG_URL'];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!url)('withSessionLock (Postgres)', () => {
  const name = `ccms_zz_lock_${randomBytes(6).toString('hex')}`;
  let one: PostgresDatabase;
  let two: PostgresDatabase;

  const admin = async <T>(work: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin((c) => c.query(`create database ${name}`));
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    one = await PostgresDatabase.connect(target.toString(), { poolMax: 2 });
    two = await PostgresDatabase.connect(target.toString(), { poolMax: 2 });
  });

  afterAll(async () => {
    await one?.close();
    await two?.close();
    await admin((c) => c.query(`drop database if exists ${name} with (force)`));
  });

  it('runs one work per key and name at a time across databases, others at once', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = one.withSessionLock(527, 'north', async () => {
      order.push('first start');
      await held;
      order.push('first end');
      return 1;
    });
    // Until the first holds the lock.
    await vi.waitFor(() => expect(order).toEqual(['first start']));
    const second = two.withSessionLock(527, 'north', async () => {
      order.push('second');
      return 2;
    });
    // Another name is not held up.
    await expect(
      two.withSessionLock(527, 'south', async () => 'other'),
    ).resolves.toBe('other');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(order).toEqual(['first start']);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first start', 'first end', 'second']);
    // Released, and no connection left holding it.
    const held2 = await admin(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where l.locktype = 'advisory' and d.datname = $1`,
            [name],
          )
        ).rows[0]?.n,
    );
    expect(held2).toBe(0);
  });

  it('hands the turn to the waiters in the order they asked, first come, first served (#527)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = one.withSessionLock(527, 'queue', async () => {
      order.push('holder');
      await held;
    });
    await vi.waitFor(() => expect(order).toEqual(['holder']));
    const waiters: Promise<void>[] = [];
    const queued = async (db: typeof one) => {
      // Waiting in Postgres's queue before the next one asks.
      const before = await admin(
        async (c) =>
          (
            await c.query<{ n: number }>(
              `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where l.locktype = 'advisory' and not l.granted and d.datname = $1`,
              [name],
            )
          ).rows[0]?.n ?? 0,
      );
      const n = waiters.length;
      waiters.push(
        db.withSessionLock(527, 'queue', async () => {
          order.push(`waiter ${n}`);
        }),
      );
      await vi.waitFor(async () =>
        expect(
          await admin(
            async (c) =>
              (
                await c.query<{ n: number }>(
                  `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where l.locktype = 'advisory' and not l.granted and d.datname = $1`,
                  [name],
                )
              ).rows[0]?.n,
          ),
        ).toBe(before + 1),
      );
    };
    // From both databases, alternately: the order is the asking order, not the pool's.
    await queued(two);
    await queued(one);
    await queued(two);
    release();
    await first;
    await Promise.all(waiters);
    expect(order).toEqual(['holder', 'waiter 0', 'waiter 1', 'waiter 2']);
  });

  it("waits past the server's statement and lock timeouts (#527)", async () => {
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    await admin((c) =>
      c.query(
        `alter database ${name} set statement_timeout = '300ms'; alter database ${name} set lock_timeout = '300ms'`,
      ),
    );
    const three = await PostgresDatabase.connect(target.toString(), {
      poolMax: 2,
    });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let started = false;
      const first = one.withSessionLock(527, 'timeouts', async () => {
        started = true;
        await held;
      });
      await vi.waitFor(() => expect(started).toBe(true));
      const waiting = three.withSessionLock(527, 'timeouts', async () => 'ran');
      await new Promise((r) => setTimeout(r, 1_000));
      release();
      await first;
      await expect(waiting).resolves.toBe('ran');
    } finally {
      await three.close();
      await admin((c) =>
        c.query(
          `alter database ${name} reset statement_timeout; alter database ${name} reset lock_timeout`,
        ),
      );
    }
  });

  it('stops waiting when the signal aborts, and releases the lock after a failing work', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const first = one.withSessionLock(527, 'abort', async () => {
      started = true;
      await held;
      throw new Error('work failed');
    });
    await vi.waitFor(() => expect(started).toBe(true));
    const controller = new AbortController();
    const waiting = two.withSessionLock(
      527,
      'abort',
      async () => 'ran',
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('attempt cut off')), 300);
    await expect(waiting).rejects.toThrow('attempt cut off');
    release();
    await expect(first).rejects.toThrow('work failed');
    await expect(
      two.withSessionLock(527, 'abort', async () => 'next'),
    ).resolves.toBe('next');
  });
});
