import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import type pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { sql } from 'drizzle-orm';
import { StartupError } from '../config/startup-error.js';
import { openDatabase } from './open-database.js';
import { MIGRATIONS_FOLDER } from './database.js';
import { PGLITE_EXTENSIONS } from '../../tests/database.js';
import { describeTarget, PostgresDatabase } from './postgres.database.js';
import {
  isLockTimeout,
  lockRetryDelayMs,
  retryOnLockTimeout,
} from './database.js';

/**
 * The production adapter (node-postgres) against a fresh PGlite served on a
 * loopback socket in this process: the real driver, no Docker.
 */
let blank: Blob;
beforeAll(async () => {
  // Starting from a dump is much faster than creating each database.
  const pglite = await PGlite.create({ extensions: PGLITE_EXTENSIONS });
  blank = await pglite.dumpDataDir('none');
  await pglite.close();
}, 60_000);

async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
  const pglite = await PGlite.create({
    loadDataDir: blank,
    extensions: PGLITE_EXTENSIONS,
  });
  const server = new PGLiteSocketServer({
    db: pglite,
    host: '127.0.0.1',
    port: 0,
    // Several connections, as a pool opens; with one, a reconnect fails.
    maxConnections: 10,
  });
  await server.start();
  return {
    url: `postgres://postgres:secret@${server.getServerConn()}/postgres`,
    stop: async () => {
      await server.stop();
      await pglite.close();
    },
  };
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as { entries: { tag: string }[] };

async function appliedMigrations(database: PostgresDatabase) {
  const rows = await database.db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return rows.rows[0]?.count;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  return address.port;
}

describe('PostgresDatabase', () => {
  it('connects, migrates once however often it runs, and closes', async () => {
    const { url, stop } = await serve();
    const database = await PostgresDatabase.connect(url);
    try {
      await database.ping(5_000);
      await database.migrate();
      await database.migrate();
      expect(await appliedMigrations(database)).toBe(journal.entries.length);
    } finally {
      await database.close();
      await stop();
    }
  });

  it('fails start-up with a clear message, without the password', async () => {
    const port = await closedPort();
    const attempt = PostgresDatabase.connect(
      `postgres://ccms:hunter2-secret@127.0.0.1:${port}/ccms`,
    );
    await expect(attempt).rejects.toBeInstanceOf(StartupError);
    const error = (await attempt.catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(
      new RegExp(
        `^Cannot use the database 127\\.0\\.0\\.1:${port}/ccms \\(CCMS_DATABASE_URL\\): .*ECONNREFUSED`,
      ),
    );
    expect(error.message).not.toContain('hunter2');
  });
});

/** A server that accepts connections and never answers: a hung database. */
async function hangingServer(): Promise<{ url: string; stop: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://u:p@127.0.0.1:${port}/db`,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe('PostgresDatabase under load', () => {
  it('ping gives up on a hung server within its deadline', async () => {
    const hung = await hangingServer();
    try {
      // connect() would not get past its own startup ping, so build it
      // against a working server first and point the ping elsewhere.
      const { url, stop } = await serve();
      const database = await PostgresDatabase.connect(url);
      try {
        const hungDatabase = Object.create(database, {
          config: { value: { connectionString: hung.url } },
        }) as PostgresDatabase;
        const started = Date.now();
        await expect(hungDatabase.ping(300)).rejects.toThrow(
          /no answer within 300 ms/,
        );
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await database.close();
        await stop();
      }
    } finally {
      hung.stop();
    }
  });

  it('reports saturation while queries wait for a connection, and the ping still answers', async () => {
    const { url, stop } = await serve();
    const database = await PostgresDatabase.connect(url, { poolMax: 1 });
    try {
      expect(database.saturated()).toBe(false);
      // Take the only connection (idle: PGlite serves one session at a time,
      // so an open transaction would block the ping too).
      const held = await (
        database as unknown as { pool: pg.Pool }
      ).pool.connect();
      // A second query queues behind the held connection.
      // Drizzle runs a query when it is awaited, not when it is built.
      const queued = (async () => database.db.execute(sql`select 1`))();
      await vi.waitFor(() => expect(database.saturated()).toBe(true));
      // The ping has a connection of its own.
      await expect(database.ping(5_000)).resolves.toBeUndefined();
      held.release();
      await queued;
      await vi.waitFor(() => expect(database.saturated()).toBe(false));
    } finally {
      await database.close();
      await stop();
    }
  });
});

describe('retryOnLockTimeout', () => {
  const lockTimeout = () =>
    Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });

  it('recognises a lock timeout wherever the chain holds it', () => {
    expect(isLockTimeout(lockTimeout())).toBe(true);
    expect(isLockTimeout(new Error('wrapped', { cause: lockTimeout() }))).toBe(
      true,
    );
    expect(isLockTimeout(new Error('relation already exists'))).toBe(false);
    expect(isLockTimeout('55P03')).toBe(false);
  });

  it('tries again with a growing pause until it works', async () => {
    const sleeps: number[] = [];
    let runs = 0;
    await retryOnLockTimeout(
      3,
      async () => {
        if (++runs < 3) throw lockTimeout();
      },
      undefined,
      async (ms) => void sleeps.push(ms),
    );
    expect(runs).toBe(3);
    expect(sleeps).toEqual([lockRetryDelayMs(1), lockRetryDelayMs(2)]);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('gives up after the last attempt, and never repeats another failure', async () => {
    let runs = 0;
    const sleep = async () => undefined;
    await expect(
      retryOnLockTimeout(
        2,
        async () => {
          runs++;
          throw lockTimeout();
        },
        undefined,
        sleep,
      ),
    ).rejects.toThrow(/lock timeout/);
    expect(runs).toBe(2);
    runs = 0;
    await expect(
      retryOnLockTimeout(
        5,
        async () => {
          runs++;
          throw new Error('syntax error');
        },
        undefined,
        sleep,
      ),
    ).rejects.toThrow('syntax error');
    expect(runs).toBe(1);
  });

  it('caps the pause', () => {
    expect(lockRetryDelayMs(10)).toBe(15_000);
  });
});

describe('openDatabase', () => {
  it('leaves the database alone when told not to migrate', async () => {
    const { url, stop } = await serve();
    try {
      const database = await openDatabase({
        CCMS_DATABASE_URL: url,
        CCMS_DATABASE_MIGRATE: false,
      });
      const table = await database.db.execute<{ name: string | null }>(
        sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`,
      );
      expect(table.rows[0]?.name).toBeNull();
      await database.close();
    } finally {
      await stop();
    }
  });

  it('applies the migrations by default', async () => {
    const { url, stop } = await serve();
    try {
      const database = (await openDatabase({
        CCMS_DATABASE_URL: url,
        CCMS_DATABASE_MIGRATE: true,
      })) as PostgresDatabase;
      expect(await appliedMigrations(database)).toBe(journal.entries.length);
      await database.close();
    } finally {
      await stop();
    }
  });

  it('a worker waits for the migrations instead of applying them (#527)', async () => {
    const { url, stop } = await serve();
    try {
      // Nothing applied: it waits, then stops start-up saying why.
      await expect(
        openDatabase({
          CCMS_DATABASE_URL: url,
          CCMS_DATABASE_MIGRATE: true,
          waitForMigrationsMs: 50,
        }),
      ).rejects.toThrow(/not migrated to this version.*CCMS_ROLE=worker/);
      // Applied (by the API) while it waits: it goes on.
      const api = (await openDatabase({
        CCMS_DATABASE_URL: url,
        CCMS_DATABASE_MIGRATE: true,
      })) as PostgresDatabase;
      expect(await api.migrationsPending()).toBe(false);
      const worker = await openDatabase({
        CCMS_DATABASE_URL: url,
        CCMS_DATABASE_MIGRATE: true,
        waitForMigrationsMs: 50,
      });
      // One missing (an older API's): pending again.
      await api.db.execute(
        sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`,
      );
      expect(await worker.migrationsPending()).toBe(true);
      expect(await appliedMigrations(api)).toBe(journal.entries.length - 1);
      await worker.close();
      await api.close();
    } finally {
      await stop();
    }
  });

  it('closes the connection and stops start-up when migrating fails', async () => {
    const close = vi.fn(async () => undefined);
    const broken = {
      target: 'db.example:5432/ccms',
      migrate: async () => {
        throw new Error('relation already exists');
      },
      close,
    };
    await expect(
      openDatabase(
        {
          CCMS_DATABASE_URL: 'postgres://x@db.example/ccms',
          CCMS_DATABASE_MIGRATE: true,
        },
        async () => broken as never,
      ),
    ).rejects.toThrow(
      new StartupError(
        'Cannot migrate the database db.example:5432/ccms: relation already exists',
      ),
    );
    expect(close).toHaveBeenCalled();
  });
});

describe('describeTarget', () => {
  it('names server, port and database, never the credentials', () => {
    expect(describeTarget('postgres://u:p@db.internal:6543/ccms')).toBe(
      'db.internal:6543/ccms',
    );
    expect(describeTarget('postgresql://u:p@localhost/ccms')).toBe(
      'localhost:5432/ccms',
    );
    expect(describeTarget('postgres:///ccms?host=/run/pg&user=u')).toBe(
      '/run/pg:5432/ccms',
    );
    expect(describeTarget('postgres:///ccms?host=/run/pg&port=5433')).toBe(
      '/run/pg:5433/ccms',
    );
    // The driver lets query parameters win; so does the message.
    expect(describeTarget('postgres://db:5432/ccms?port=6543')).toBe(
      'db:6543/ccms',
    );
  });

  it('names nothing when an unescaped password would leak into the label', () => {
    // `/` in the password: the parser reads `u` as host and `12` as port.
    expect(describeTarget('postgres://u:12/secret@db/ccms')).toBe(
      'at CCMS_DATABASE_URL',
    );
    // `#` in the password: the rest becomes the fragment.
    expect(describeTarget('postgres://u:12#secret@db/ccms')).toBe(
      'at CCMS_DATABASE_URL',
    );
    // `?` in the password: the rest becomes the query.
    expect(describeTarget('postgres://u:12?secret@db/ccms')).toBe(
      'at CCMS_DATABASE_URL',
    );
    // An `@` in the database name or a query value never shows either.
    expect(describeTarget('postgres://db/a%40b')).toBe('at CCMS_DATABASE_URL');
  });
});
