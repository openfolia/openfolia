import { randomBytes } from 'node:crypto';
import { DrizzleChangeSetEvents } from './drizzle-change-set-events.js';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { actorWith } from '../../../tests/fakes/actors.js';
import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import { ContendedError, DomainError } from '../../base/core/errors.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { PostgresDatabase } from '../../database/postgres.database.js';
import { AbandonChangeSetAction } from '../core/actions/abandon-change-set.action.js';
import { BreakLocksAction } from '../core/actions/break-locks.action.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../core/change-set.js';
import { type LockSubject, newLockId } from '../core/lock.js';
import { DrizzleChangeSetStore } from './drizzle-change-set-store.js';
import { DrizzleLockStore } from './drizzle-lock-store.js';
import { DrizzleWorkingCopyStore } from './drizzle-working-copy-store.js';

/**
 * Concurrent multi-row lock removals on a real Postgres server (#149).
 * PGlite runs one transaction at a time, so it can never show two of them
 * taking row locks in opposite order; this needs a server. It runs only
 * when `CCMS_TEST_PG_URL` names one (the compose Postgres:
 * `postgres://ccms:ccms@127.0.0.1:5432/ccms`), in a database of its own
 * that it creates and drops; without it, it is skipped.
 */
const url = process.env['CCMS_TEST_PG_URL'];

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const ROUNDS = 40;
const LOCKS_PER_CHANGE_SET = 12;

const author = { kind: 'user', id: 'sample-author' } as const;
const editor = { ...actorWith(['content.edit']), id: author.id };
const admin = actorWith(['admin.roles']);

describe.skipIf(!url)('lock removal under contention (Postgres)', () => {
  const name = `ccms_test_locks_${randomBytes(6).toString('hex')}`;
  let database: PostgresDatabase;
  let changeSets: DrizzleChangeSetStore;
  let locks: DrizzleLockStore;
  let unit: DrizzleUnitOfWork;
  let abandon: AbandonChangeSetAction;
  let breakLocks: BreakLocksAction;

  const admin_ = () => new pg.Client({ connectionString: url });

  beforeAll(async () => {
    const client = admin_();
    await client.connect();
    try {
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    database = await PostgresDatabase.connect(target.toString(), {
      poolMax: 20,
    });
    await database.migrate();
    changeSets = new DrizzleChangeSetStore(database);
    locks = new DrizzleLockStore(database);
    unit = new DrizzleUnitOfWork(database);
    const auditLog = new DrizzleAuditLog(database);
    abandon = new AbandonChangeSetAction(
      changeSets,
      locks,
      new DrizzleWorkingCopyStore(database),
      auditLog,
      new DrizzleChangeSetEvents(),
      unit,
    );
    breakLocks = new BreakLocksAction(
      changeSets,
      locks,
      auditLog,
      new DrizzleChangeSetEvents(),
      unit,
    );
  });

  afterAll(async () => {
    await database?.close();
    const client = admin_();
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
    } finally {
      await client.end();
    }
  });

  /** A draft change set of `author`, recorded. */
  async function draft(): Promise<ChangeSet> {
    const id = newChangeSetId();
    const now = new Date();
    const changeSet: ChangeSet = {
      id,
      title: 'Contended',
      description: null,
      author,
      baseRef: 'main',
      baseCommit: 'c'.repeat(40),
      baseReleased: true,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await unit.run((tx) => changeSets.insert(tx, changeSet));
    return changeSet;
  }

  /**
   * Locks for both change sets, interleaved, inserted in random order and
   * with `since` running against the ID order: the plans by change set
   * (`locks_change_set_idx`), by holder (`locks_holder_idx`) and a plain
   * scan each meet the rows in a different order.
   */
  async function lockAll(round: number, ...of: ChangeSet[]): Promise<void> {
    const rows = of.flatMap((cs, c) =>
      Array.from({ length: LOCKS_PER_CHANGE_SET }, (_, i) => ({
        id: newLockId(),
        subjectId: `en/r${round}-c${c}-m${i}`,
        changeSetId: cs.id,
      })),
    );
    const byId = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const since = new Map(
      byId.map((row, i) => [row.id, new Date(Date.now() - i * 1_000)]),
    );
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [
        rows[j] as (typeof rows)[0],
        rows[i] as (typeof rows)[0],
      ];
    }
    for (const row of rows) {
      await database.db.execute(
        sql`insert into locks (id, subject_type, subject_id, change_set_id, holder_kind, holder_id, since)
            values (${row.id}, 'module', ${row.subjectId}, ${row.changeSetId}, ${author.kind}, ${author.id}, ${since.get(row.id)})`,
      );
    }
  }

  /** Locks left on any of `of`. */
  async function left(...of: ChangeSet[]): Promise<number> {
    const result = await database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from locks where change_set_id in (${sql.join(
        of.map((cs) => sql`${cs.id}`),
        sql`, `,
      )})`,
    );
    return result.rows[0]?.n ?? -1;
  }

  it('bulk breaks, abandons and save points never deadlock into a 500, and leave no lock', async () => {
    const outcomes = new Map<string, number>();
    const count = (key: string) =>
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    for (let round = 0; round < ROUNDS; round++) {
      const [one, two] = [await draft(), await draft()];
      await lockAll(round, one, two);
      const subjectsOf = async (cs: ChangeSet): Promise<LockSubject[]> =>
        (await locks.all({ changeSetId: cs.id })).map((l) => l.subject);
      const twoSubjects = await subjectsOf(two);
      const settled = await Promise.allSettled([
        abandon.handle({ actor: editor, id: one.id }),
        breakLocks.handle({ actor: admin, comment: 'Left.', holder: author }),
        breakLocks.handle({
          actor: admin,
          comment: 'Stuck.',
          changeSetId: two.id,
        }),
        abandon.handle({ actor: editor, id: two.id }),
        breakLocks.handle({
          actor: admin,
          comment: 'Stuck.',
          changeSetId: one.id,
        }),
        // What a save point holds: the change set's row, then its locks.
        unit.run(async (tx) => {
          await changeSets.lock(tx, two.id);
          return locks.holdAll(tx, twoSubjects);
        }),
      ]);
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          count('ok');
          continue;
        }
        const error: unknown = result.reason;
        // A domain error is an answer (409, 404); anything else is a 500.
        if (!(error instanceof DomainError)) throw error;
        count((error as { code?: string }).code ?? error.constructor.name);
      }
      expect(await left(one, two)).toBe(0);
    }
    console.info(
      `${ROUNDS} rounds against Postgres:`,
      Object.fromEntries(outcomes),
    );
  });
  it('turns a deadlock the database breaks off into ContendedError (409 lock-contended)', async () => {
    const [one, two] = [await draft(), await draft()];
    // Two transactions locking the same two rows in opposite order.
    let both!: () => void;
    const met = new Promise<void>((resolve) => {
      let waiting = 2;
      both = () => {
        if (--waiting === 0) resolve();
      };
    });
    const opposite = (first: ChangeSet, second: ChangeSet) =>
      unit.run(async (tx) => {
        await changeSets.lock(tx, first.id);
        both();
        await met;
        await changeSets.lock(tx, second.id);
      });
    const settled = await Promise.allSettled([
      opposite(one, two),
      opposite(two, one),
    ]);
    const failed = settled.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as unknown] : [],
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(ContendedError);
    expect(failed[0]).toMatchObject({ code: 'lock-contended' });
  });
});
