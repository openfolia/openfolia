import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { auditEvents } from '../../audit/repos/audit.tables.js';
import { users } from './access.tables.js';
import { resetSecondFactorLocally } from './reset-second-factor-locally.js';
import { pendingSignIns, secondFactors } from './second-factors.tables.js';

describe('resetSecondFactorLocally (#611)', () => {
  let database: PgliteDatabase;
  const at = new Date();
  beforeEach(async () => {
    database = await createTestDatabase();
    await database.db.insert(users).values([
      { id: 'pat', name: 'Pat', email: 'pat@example.org' },
      { id: 'lee', name: 'Lee', email: 'lee@example.org' },
    ]);
    await database.db.insert(secondFactors).values([
      {
        userId: 'pat',
        sealedSecret: 'v1.x',
        begunAt: at,
        confirmedAt: at,
        lastStep: 1,
      },
      { userId: 'lee', sealedSecret: 'v1.x', begunAt: at },
    ]);
    await database.db.insert(pendingSignIns).values({
      tokenHash: 'a'.repeat(64),
      userId: 'pat',
      step: 'verify',
      provider: 'password',
      createdAt: at,
      expiresAt: new Date(at.getTime() + 60_000),
    });
  });

  it('removes it, ends open second steps, and is audited as the command line’s', async () => {
    expect(await resetSecondFactorLocally(database, ' PAT@example.org ')).toBe(
      'pat',
    );
    expect(
      (await database.db.select().from(secondFactors)).map((f) => f.userId),
    ).toEqual(['lee']);
    expect(await database.db.select().from(pendingSignIns)).toEqual([]);
    expect(await database.db.select().from(auditEvents)).toMatchObject([
      {
        action: 'user.second-factor-reset',
        subjectId: 'pat',
        actorId: 'service:cli',
        data: { via: 'cli' },
      },
    ]);
  });

  it('says when there is nobody, or nothing on', async () => {
    await expect(
      resetSecondFactorLocally(database, 'nobody@example.org'),
    ).rejects.toThrow('No user has this address.');
    await expect(
      resetSecondFactorLocally(database, 'lee@example.org'),
    ).rejects.toThrow('"lee" has no second factor on');
    // One only begun stays as it was: the refusal rolls back.
    expect(await database.db.select().from(secondFactors)).toHaveLength(2);
  });
});
