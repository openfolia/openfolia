import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../core/change-set.js';
import type { NewCommitIntent } from '../core/commit-intents.js';
import type { LockSubject } from '../core/lock.js';
import { DrizzleChangeSetStore } from './drizzle-change-set-store.js';
import { DrizzleCommitIntents } from './drizzle-commit-intents.js';

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const operating: LockSubject = { type: 'manual', manualId: 'operating' };

describe('DrizzleCommitIntents', () => {
  let database: PgliteDatabase;
  let intents: DrizzleCommitIntents;
  let unit: DrizzleUnitOfWork;
  beforeEach(async () => {
    database = await createTestDatabase();
    intents = new DrizzleCommitIntents(database);
    unit = new DrizzleUnitOfWork(database, {
      lockTimeoutMs: 1234,
      statementTimeoutMs: 5678,
    });
  });
  afterEach(() => database?.close());

  async function changeSet(): Promise<ChangeSet> {
    const id = newChangeSetId();
    const now = new Date();
    const made: ChangeSet = {
      id,
      title: 'x',
      description: null,
      author: { kind: 'user', id: 'sample-author' },
      baseRef: 'main',
      baseCommit: 'c'.repeat(40),
      baseReleased: true,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await unit.run((tx) =>
      new DrizzleChangeSetStore(database).insert(tx, made),
    );
    return made;
  }

  const intent = (changeSetId: string): NewCommitIntent => ({
    changeSetId,
    actor: { kind: 'user', id: 'sample-author' },
    parent: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    written: [charging],
    deleted: [operating],
    consumes: [
      {
        subject: charging,
        version: 3,
        createdAt: new Date('2026-11-17T10:00:00.123Z'),
      },
      {
        subject: operating,
        version: 1,
        createdAt: new Date('2026-11-17T10:00:01.456Z'),
      },
    ],
    message: 'Edit',
  });

  it('stores, reads back, finds pending and removes intents', async () => {
    const cs = await changeSet();
    const other = await changeSet();
    const added = await unit.run((tx) => intents.add(tx, intent(cs.id)));
    expect(added).toMatchObject({ ...intent(cs.id), id: expect.any(Number) });
    expect(await unit.run((tx) => intents.of(tx, cs.id))).toEqual([added]);
    expect(await intents.pendingFor([cs.id, other.id, 'not-an-id'])).toEqual(
      new Set([cs.id]),
    );
    expect(await unit.run((tx) => intents.remove(tx, added.id))).toBe(true);
    expect(await unit.run((tx) => intents.remove(tx, added.id))).toBe(false);
    expect(await intents.pendingFor([cs.id])).toEqual(new Set());
  });

  it('expires intents by the database clock', async () => {
    const cs = await changeSet();
    await unit.run((tx) => intents.add(tx, intent(cs.id)));
    expect(await intents.expiredChangeSets(60_000, 10)).toEqual([]);
    await database.db.execute(
      sql`update commit_intents set created_at = now() - interval '2 hours'`,
    );
    await unit.run((tx) => intents.add(tx, intent(cs.id)));
    expect(await intents.expiredChangeSets(60 * 60_000, 10)).toEqual([cs.id]);
    expect(
      await unit.run((tx) => intents.removeExpired(tx, cs.id, 60 * 60_000)),
    ).toBe(1);
    expect(await unit.run((tx) => intents.of(tx, cs.id))).toHaveLength(1);
  });

  it('refuses malformed rows in the database too', async () => {
    const cs = await changeSet();
    await expect(
      unit.run((tx) => intents.add(tx, { ...intent(cs.id), tree: 'HEAD' })),
    ).rejects.toThrow();
    await expect(
      unit.run((tx) =>
        intents.add(tx, { ...intent(newChangeSetId()), tree: 'b'.repeat(40) }),
      ),
    ).rejects.toThrow();
  });
});

describe('DrizzleUnitOfWork, bounded', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(() => database?.close());

  it('sets the write timeouts for that transaction only', async () => {
    const unit = new DrizzleUnitOfWork(database, {
      lockTimeoutMs: 1234,
      statementTimeoutMs: 5678,
    });
    const settings = async (db: Pick<typeof database.db, 'execute'>) =>
      (
        await db.execute<{ lock: string; statement: string }>(
          sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`,
        )
      ).rows[0];
    const inside = await unit.run((tx) => settings(drizzleOf(tx)), {
      bounded: true,
    });
    expect(inside).toEqual({ lock: '1234ms', statement: '5678ms' });
    // SET LOCAL: gone with the transaction.
    expect(await settings(database.db)).toEqual({ lock: '0', statement: '0' });
    expect(await unit.run((tx) => settings(drizzleOf(tx)))).toEqual({
      lock: '0',
      statement: '0',
    });
  });
});
