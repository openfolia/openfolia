import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { newChangeSetId } from '../core/change-set.js';
import type { ChangeSetCommit } from '../core/commit.js';
import { DrizzleChangeSetCommits } from './drizzle-change-set-commits.js';

describe('DrizzleChangeSetCommits', () => {
  let database: PgliteDatabase;
  let commits: DrizzleChangeSetCommits;
  let unit: DrizzleUnitOfWork;
  beforeEach(async () => {
    database = await createTestDatabase();
    commits = new DrizzleChangeSetCommits(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  const commit = (id: string): ChangeSetCommit => {
    const changeSetId = newChangeSetId();
    return {
      changeSetId,
      branch: `change-sets/${changeSetId}`,
      commit: id,
      parent: 'a'.repeat(40),
      actor: { kind: 'user', id: 'sample-author' },
      written: [{ type: 'module', lang: 'en', moduleId: 'charging' }],
      deleted: [{ type: 'manual', manualId: 'old' }],
    };
  };

  it('records a commit once, with its outbox row', async () => {
    const first = commit('b'.repeat(40));
    expect(await unit.run((tx) => commits.record(tx, first))).toBe(true);
    expect(await unit.run((tx) => commits.record(tx, first))).toBe(false);
    expect(await commits.recorded(['b'.repeat(40), 'c'.repeat(40)])).toEqual(
      new Set(['b'.repeat(40)]),
    );
    expect(await commits.recorded([])).toEqual(new Set());
    const rows = await database.db.execute(
      sql`select topic, key, payload from outbox`,
    );
    expect(rows.rows).toEqual([
      {
        topic: 'change-set.commit',
        key: 'b'.repeat(40),
        payload: {
          changeSetId: first.changeSetId,
          branch: first.branch,
          commit: 'b'.repeat(40),
          parent: 'a'.repeat(40),
          actor: { kind: 'user', id: 'sample-author' },
          written: [{ type: 'module', id: 'en/charging' }],
          deleted: [{ type: 'manual', id: 'old' }],
        },
      },
    ]);
  });

  it('records nothing when the transaction rolls back', async () => {
    await expect(
      unit.run(async (tx) => {
        await commits.record(tx, commit('d'.repeat(40)));
        expect(await commits.recorded(['d'.repeat(40)], tx)).toEqual(
          new Set(['d'.repeat(40)]),
        );
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await commits.recorded(['d'.repeat(40)])).toEqual(new Set());
  });

  it('holds its formats in the database', async () => {
    for (const [topic, key, payload] of [
      ['Bad', 'k', '{}'],
      ['a.b', '', '{}'],
      ['a.b', 'k', '[1]'],
    ]) {
      await expect(
        database.db.execute(
          sql`insert into outbox (topic, key, payload) values (${topic}, ${key}, ${payload}::jsonb)`,
        ),
      ).rejects.toThrow();
    }
  });
});
