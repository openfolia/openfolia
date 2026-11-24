import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { type Database, startDatabase } from '../src/database.js';

const started: Database[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const database of started.splice(0)) await database.stop();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const start = async (dataDir?: string) => {
  const database = await startDatabase(dataDir ? { dataDir } : {});
  started.push(database);
  return database;
};

describe('the embedded database', () => {
  it('listens on the loopback only, with pg_trgm, as Postgres', async () => {
    const database = await start();
    expect(database.url).toBe(
      `postgres://postgres@127.0.0.1:${database.port}/postgres`,
    );
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query('CREATE EXTENSION pg_trgm');
    const { rows } = await client.query<{ s: number }>(
      "SELECT similarity('wheel', 'wheels') > 0.5 AS s",
    );
    expect(rows[0]?.s).toBe(true);
    await client.end();
  });

  it("keeps each connection's extended queries and transactions together", async () => {
    const database = await start();
    const pool = new pg.Pool({ connectionString: database.url, max: 8 });
    await pool.query('CREATE TABLE t (n integer)');
    // A transaction on one connection while the others run parameterised queries: every
    // answer is its own query's, and the transaction's rows appear only once it commits.
    const tx = await pool.connect();
    await tx.query('BEGIN');
    await tx.query('INSERT INTO t VALUES ($1)', [1]);
    const reads = Array.from({ length: 40 }, (_, i) =>
      pool
        .query<{ n: number }>('SELECT $1::integer AS n', [i])
        .then(({ rows }) => rows[0]?.n),
    );
    await tx.query('INSERT INTO t VALUES ($1)', [2]);
    await tx.query('COMMIT');
    tx.release();
    expect(await Promise.all(reads)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
    const { rows } = await pool.query<{ c: string }>(
      'SELECT count(*) AS c FROM t',
    );
    expect(rows[0]?.c).toBe('2');
    await pool.end();
  });

  it('keeps a data folder: what was written is there after a restart', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sandbox-db-'));
    folders.push(folder);
    const dataDir = join(folder, 'pgdata');
    const first = await startDatabase({ dataDir });
    const writer = new pg.Client({ connectionString: first.url });
    await writer.connect();
    await writer.query("CREATE TABLE kept AS SELECT 'baked' AS v");
    await writer.end();
    await first.stop();

    const second = await start(dataDir);
    const reader = new pg.Client({ connectionString: second.url });
    await reader.connect();
    const { rows } = await reader.query<{ v: string }>('SELECT v FROM kept');
    expect(rows).toEqual([{ v: 'baked' }]);
    await reader.end();
  });

  it('stops once, however often it is asked', async () => {
    const database = await startDatabase();
    await Promise.all([database.stop(), database.stop()]);
    await expect(
      new pg.Client({ connectionString: database.url }).connect(),
    ).rejects.toThrow();
  });
});
