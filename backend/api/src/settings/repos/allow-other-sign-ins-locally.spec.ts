import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { users } from '../../access/repos/access.tables.js';
import { signInLinks } from '../../access/repos/passwords.tables.js';
import { pendingSignIns } from '../../access/repos/second-factors.tables.js';
import { sessions } from '../../access/repos/sign-in.tables.js';
import { auditEvents } from '../../audit/repos/audit.tables.js';
import { allowOtherSignInsLocally } from './allow-other-sign-ins-locally.js';
import { installationSettings } from './installation-settings.tables.js';

describe('allowOtherSignInsLocally (#378)', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
    await database.db
      .insert(users)
      .values({ id: 'pat', name: 'Pat', email: 'pat@example.org' });
  });

  it('turns it off, ends whatever was begun, and is audited as the command line’s', async () => {
    const at = new Date();
    await database.db.insert(installationSettings).values({
      id: 1,
      version: 3,
      singleSignOn: 'required',
      breakGlassUserId: 'pat',
      sessionMaxHours: 12,
    });
    await database.db.insert(sessions).values([
      { tokenHash: 'a'.repeat(64), userId: 'pat', provider: 'password' },
      { tokenHash: 'b'.repeat(64), userId: 'pat', provider: 'oidc' },
    ]);
    await database.db.insert(pendingSignIns).values({
      tokenHash: 'c'.repeat(64),
      userId: 'pat',
      step: 'verify',
      provider: 'password',
      createdAt: at,
      expiresAt: new Date(at.getTime() + 60_000),
    });
    expect(await allowOtherSignInsLocally(database)).toBe(true);
    expect(await database.db.select().from(installationSettings)).toMatchObject(
      [
        {
          version: 4,
          singleSignOn: 'optional',
          breakGlassUserId: 'pat',
          sessionMaxHours: 12,
        },
      ],
    );
    const rows = await database.db.select().from(sessions);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(await database.db.select().from(pendingSignIns)).toEqual([]);
    expect(await database.db.select().from(signInLinks)).toEqual([]);
    expect(
      await database.db.select().from(auditEvents).orderBy(auditEvents.id),
    ).toMatchObject([
      {
        action: 'settings.sign-ins-ended',
        actorId: 'service:cli',
        data: { sessions: 2, secondSteps: 1, links: 0, emailCodes: 0 },
      },
      {
        action: 'settings.single-sign-on',
        actorId: 'service:cli',
        data: { from: 'required', to: 'optional', via: 'cli' },
      },
    ]);
  });

  it('changes nothing where it is not required', async () => {
    expect(await allowOtherSignInsLocally(database)).toBe(false);
    expect(await database.db.select().from(installationSettings)).toEqual([]);
    expect(await database.db.select().from(auditEvents)).toEqual([]);
  });
});
