import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { actorWith } from '../../../tests/fakes/actors.js';
import { createTestApp, type TestApp } from '../../../tests/test-app.js';
import type { Actor } from '../../access/core/actor.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { PostgresDatabase } from '../../database/postgres.database.js';
import { ChangeSetReconciler } from '../api/change-set-reconciler.js';
import { ChangeSetDocument } from '../api/change-set.resources.js';
import { CommitDocument } from '../api/commit.resources.js';
import { ModuleWorkingCopyDocument } from '../api/working-copy.resources.js';
import { MAX_COMMIT_CHANGES } from '../core/commit.js';
import { newLockId } from '../core/lock.js';

/**
 * Save points on a real Postgres server (#155): how long a commit of the
 * maximum size holds the change set's row, measured from another
 * connection, and what the write timeouts answer. PGlite runs one
 * transaction at a time and ignores `statement_timeout`, so this needs a
 * server. It runs only when `CCMS_TEST_PG_URL` names one (the compose
 * Postgres: `postgres://ccms:ccms@127.0.0.1:5432/ccms`), in a database of
 * its own that it creates and drops; without it, it is skipped.
 */
const url = process.env['CCMS_TEST_PG_URL'];

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const LOCK_TIMEOUT_MS = 300;
const STATEMENT_TIMEOUT_MS = 1_000;

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const admin = actorWith(['admin.roles']);

describe.skipIf(!url)('save points (Postgres)', () => {
  const name = `ccms_test_saves_${randomBytes(6).toString('hex')}`;
  const target = () => {
    const at = new URL(url as string);
    at.pathname = `/${name}`;
    return at.toString();
  };
  let t: TestApp;
  /** A second connection: holds rows, probes them, injects failures. */
  let other: pg.Client;

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    const database = await PostgresDatabase.connect(target(), { poolMax: 10 });
    await database.migrate();
    t = await createTestApp(
      {
        CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS: String(LOCK_TIMEOUT_MS),
        CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: String(STATEMENT_TIMEOUT_MS),
      },
      { database },
    );
    other = new pg.Client({ connectionString: target() });
    await other.connect();
  });

  // Locks are per subject across change sets: each test starts with none.
  afterEach(async () => {
    t.actAs(undefined);
    await other.query('delete from working_copies');
    await other.query('delete from locks');
  });

  afterAll(async () => {
    await other?.end();
    await t?.close();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
    } finally {
      await client.end();
    }
  });

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', process.env['CCMS_CONTENT_DIR'] as string, ...args],
      { encoding: 'utf8' },
    ).trim();
  const errors = (body: unknown) => ErrorDocument.parse(body).errors;

  async function changeSet(): Promise<{ id: string; branch: string }> {
    t.actAs(author);
    const res = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Save points' } },
      }),
    );
    expect(res.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(res.body).data;
    return { id, branch: attributes.branch };
  }

  /** The module `charging` as the author reads it, as a template. */
  async function template(cs: string): Promise<Module> {
    const res = await t.get(
      `/change-sets/${cs}/modules/en/charging/working-copy`,
    );
    expect(res.status).toBe(200);
    return ModuleWorkingCopyDocument.parse(res.body).data.attributes
      .content as Module;
  }

  /**
   * `count` new modules `bulk-<n>`, each locked and with a working copy,
   * written straight to the database (the HTTP way would take minutes).
   */
  async function bulk(cs: string, count: number, base: string) {
    const module = await template(cs);
    const now = new Date().toISOString();
    for (let from = 0; from < count; from += 200) {
      const ids = Array.from(
        { length: Math.min(200, count - from) },
        (_, i) => `bulk-${from + i}`,
      );
      for (const id of ids) {
        const content: Module = {
          ...module,
          id,
          blocks: [
            {
              type: 'paragraph',
              id: 'typed',
              content: [{ type: 'text', text: `Module ${id}.` }],
            },
          ],
        };
        await other.query(
          `insert into locks (id, subject_type, subject_id, change_set_id, holder_kind, holder_id, since)
           values ($1, 'module', $2, $3, 'user', $4, $5)`,
          [newLockId(), `en/${id}`, cs, author.id, now],
        );
        await other.query(
          `insert into working_copies (change_set_id, subject_type, subject_id, schema_version, content, base_commit, version, updated_by_kind, updated_by_id, created_at, updated_at)
           values ($1, 'module', $2, $3, $4, $5, 1, 'user', $6, $7, $7)`,
          [
            cs,
            `en/${id}`,
            content.schemaVersion,
            JSON.stringify(content),
            base,
            author.id,
            now,
          ],
        );
      }
    }
  }

  /**
   * Polls the change set's row from the other connection every few
   * milliseconds (`FOR UPDATE NOWAIT`) and adds up how long it was held.
   */
  function probe(cs: string) {
    let running = true;
    let heldMs = 0;
    let polls = 0;
    const done = (async () => {
      let last = performance.now();
      while (running) {
        const at = performance.now();
        let held = false;
        try {
          await other.query('begin');
          await other.query(
            'select 1 from change_sets where id = $1 for update nowait',
            [cs],
          );
        } catch {
          held = true;
        } finally {
          await other.query('rollback');
        }
        polls++;
        const now = performance.now();
        if (held) heldMs += now - last;
        last = at;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    return {
      stop: async () => {
        running = false;
        await done;
        return { heldMs, polls };
      },
    };
  }

  it(`holds the row only for the write step of a commit of ${MAX_COMMIT_CHANGES} files`, async () => {
    const cs = await changeSet();
    await bulk(cs.id, MAX_COMMIT_CHANGES, t.commits.main);
    const watch = probe(cs.id);
    const started = performance.now();
    const res = await t.post(`/change-sets/${cs.id}/commits`);
    const totalMs = performance.now() - started;
    const { heldMs, polls } = await watch.stop();
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(201);
    const made = CommitDocument.parse(res.body).data;
    expect(made.attributes.written).toHaveLength(MAX_COMMIT_CHANGES);
    console.log(
      `${MAX_COMMIT_CHANGES} files: the save point took ${Math.round(totalMs)} ms, the change set's row was held for about ${Math.round(heldMs)} ms (${polls} polls)`,
    );
    expect(polls).toBeGreaterThan(10);
    // The preflight (reading, validating, printing, the tree) is most of it.
    expect(heldMs).toBeLessThan(totalMs * 0.5);
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(made.id);
    const left = await t.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from commit_intents`,
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it('answers 503 database-timeout when the row is held past the lock timeout, writing nothing', async () => {
    const cs = await changeSet();
    t.actAs(author);
    expect(
      (
        await t.post(`/change-sets/${cs.id}/locks`).send(
          JSON.stringify({
            data: {
              type: 'Lock',
              attributes: {
                subject: { type: 'module', lang: 'en', moduleId: 'charging' },
              },
            },
          }),
        )
      ).status,
    ).toBe(201);
    const module = await template(cs.id);
    const saved = await t
      .put(`/change-sets/${cs.id}/modules/en/charging/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                ...module,
                blocks: [
                  {
                    type: 'paragraph',
                    id: 'typed',
                    content: [{ type: 'text', text: 'Held.' }],
                  },
                ],
              },
            },
          },
          meta: { version: 0, baseCommit: t.commits.main },
        }),
      );
    expect(saved.status).toBe(200);

    await other.query('begin');
    await other.query('select 1 from change_sets where id = $1 for update', [
      cs.id,
    ]);
    try {
      const answers: Record<
        string,
        { status: number; code?: string; retry?: string; ms: number }
      > = {};
      const time = async (
        key: string,
        run: () => Promise<{
          status: number;
          body: unknown;
          headers: Record<string, string>;
        }>,
      ) => {
        const at = performance.now();
        const res = await run();
        answers[key] = {
          status: res.status,
          ...(res.status >= 400 && { code: errors(res.body)[0]?.code }),
          ...(res.headers['retry-after'] !== undefined && {
            retry: res.headers['retry-after'],
          }),
          ms: Math.round(performance.now() - at),
        };
      };
      t.actAs(author);
      await time('commit', () => t.post(`/change-sets/${cs.id}/commits`));
      await time('abandon', () =>
        t.post(`/change-sets/${cs.id}/abandon`).send(JSON.stringify({})),
      );
      t.actAs(admin);
      await time('break locks', () =>
        t
          .post('/locks/break')
          .send(
            JSON.stringify({ meta: { changeSet: cs.id, comment: 'Away.' } }),
          ),
      );
      console.log('while another transaction holds the row:', answers);
      for (const answer of Object.values(answers)) {
        expect(answer).toMatchObject({
          status: 503,
          code: 'database-timeout',
          retry: '1',
        });
        expect(answer.ms).toBeLessThan(LOCK_TIMEOUT_MS * 10);
      }
    } finally {
      await other.query('rollback');
    }
    // Nothing landed, nothing was left behind.
    expect(git('rev-parse', `refs/heads/${cs.branch}`)).toBe(t.commits.main);
    const intents = await t.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from commit_intents where change_set_id = ${cs.id}`,
    );
    expect(intents.rows[0]?.n).toBe(0);
    t.actAs(author);
    expect((await t.post(`/change-sets/${cs.id}/commits`)).status).toBe(201);
  });

  it('answers 503 database-timeout for a statement past the statement timeout, and recovers a commit that landed', async () => {
    const cs = await changeSet();
    await bulk(cs.id, 1, t.commits.main);
    await other.query(`create or replace function slow_outbox() returns trigger language plpgsql as $$
      begin perform pg_sleep(${(STATEMENT_TIMEOUT_MS * 2) / 1000}); return new; end $$`);
    await other.query(
      'create trigger slow_outbox before insert on outbox for each row execute function slow_outbox()',
    );
    let landed: string;
    try {
      t.actAs(author);
      const res = await t.post(`/change-sets/${cs.id}/commits`);
      console.log(
        'a statement past the statement timeout:',
        res.status,
        errors(res.body)[0],
      );
      expect(res.status).toBe(503);
      expect(errors(res.body)[0]?.code).toBe('database-timeout');
      landed = git('rev-parse', `refs/heads/${cs.branch}`);
      expect(landed).not.toBe(t.commits.main);
    } finally {
      await other.query('drop trigger slow_outbox on outbox');
      await other.query('drop function slow_outbox()');
    }
    // In Git, unrecorded; its intent stays, and recovery records it.
    await t.app.get(ChangeSetReconciler).runOnce();
    const recorded = await t.database.db.execute<{ key: string }>(
      sql`select key from outbox where payload->>'changeSetId' = ${cs.id}`,
    );
    expect(recorded.rows.map((r) => r.key)).toEqual([landed]);
    const intents = await t.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from commit_intents where change_set_id = ${cs.id}`,
    );
    expect(intents.rows[0]?.n).toBe(0);
    const copies = await t.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from working_copies where change_set_id = ${cs.id}`,
    );
    expect(copies.rows[0]?.n).toBe(0);
  });
});
