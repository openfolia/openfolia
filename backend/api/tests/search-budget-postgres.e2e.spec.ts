import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../src/database/postgres.database.js';
import { errors, q, reader } from './search-limits.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * On a real Postgres server, which (unlike PGlite) cuts a statement off at
 * `statement_timeout`: a search waiting on a table another connection
 * holds stops at the budget, not at the 5 s each statement may take. Runs
 * only when `CCMS_TEST_PG_URL` names a server (the compose Postgres:
 * `postgres://ccms:ccms@127.0.0.1:5432/ccms`), in a database of its own
 * that it creates and drops; without it, it is skipped.
 */
const url = process.env['CCMS_TEST_PG_URL'];

describe.skipIf(!url)('GET /search time budget (Postgres)', () => {
  const name = `ccms_test_search_${randomBytes(6).toString('hex')}`;
  const target = () => {
    const at = new URL(url as string);
    at.pathname = `/${name}`;
    return at.toString();
  };
  let t: TestApp;
  let other: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`create database ${name}`);
    } finally {
      await admin.end();
    }
    const database = await PostgresDatabase.connect(target(), { poolMax: 4 });
    await database.migrate();
    t = await createTestApp({ CCMS_SEARCH_TIMEOUT_MS: '300' }, { database });
    other = new pg.Client({ connectionString: target() });
    await other.connect();
  }, 120_000);

  afterAll(async () => {
    await other?.end();
    await t?.close();
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
    } finally {
      await admin.end();
    }
  });

  it('stops a statement at the budget: 503 database-timeout well before the statement timeout', async () => {
    t.actAs(reader('search-held'));
    expect((await t.get(q('charging'))).status).toBe(200);
    await other.query('begin');
    await other.query('lock table search_blocks in access exclusive mode');
    try {
      const started = performance.now();
      const res = await t.get(q('automatically charges'));
      const took = performance.now() - started;
      console.log(
        'a search held up by a lock:',
        res.status,
        Math.round(took),
        'ms',
      );
      expect(res.status).toBe(503);
      expect(errors(res.body)[0]?.code).toBe('database-timeout');
      // The budget is 300 ms; one statement alone would wait 5 s.
      expect(took).toBeLessThan(2_500);
    } finally {
      await other.query('rollback');
    }
    expect((await t.get(q('automatically charges'))).status).toBe(200);
  });
});
