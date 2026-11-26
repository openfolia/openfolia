import { createTestDatabase } from '../../../tests/database.js';
import type { Database } from '../../database/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { installationSettings } from '../../settings/repos/installation-settings.tables.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleSignInRules } from './drizzle-sign-in-rules.js';
import { userPasswords } from './passwords.tables.js';

describe('DrizzleSignInRules (#378)', () => {
  let database: Database;
  let rules: DrizzleSignInRules;

  beforeAll(async () => {
    database = await createTestDatabase();
    rules = new DrizzleSignInRules(database, true);
    const { db } = database;
    await db.insert(users).values([
      { id: 'rescue', name: 'Rescue' },
      { id: 'pat', name: 'Pat' },
    ]);
    // `admin.roles` is global: its policy does not ask for the role's scope.
    await db.insert(roles).values({
      id: 'german-admin',
      name: 'German admin',
      permissions: ['admin.roles', 'content.edit'],
      languages: ['de'],
    });
    await db
      .insert(roleAssignments)
      .values({ userId: 'rescue', roleId: 'german-admin' });
    await db
      .insert(userPasswords)
      .values({ userId: 'rescue', hash: '$argon2id$test' });
    await db.insert(installationSettings).values({
      id: 1,
      version: 1,
      singleSignOn: 'required',
      breakGlassUserId: 'rescue',
    });
  });
  afterAll(() => database?.close());

  it('holds the rule in a sign-in’s transaction although nothing was ever set', async () => {
    const { db } = database;
    const [set] = await db.delete(installationSettings).returning();
    const unit = new DrizzleUnitOfWork(database);
    expect((await unit.run((tx) => rules.read(tx))).singleSignOn).toBe(
      'optional',
    );
    expect(await db.select().from(installationSettings)).toMatchObject([
      { id: 1, version: 0, updatedAt: null },
    ]);
    await db.update(installationSettings).set(set!);
  });

  it('takes admin.roles in a scoped role, as the policy of the settings does', async () => {
    expect(await rules.breakGlassProblem('rescue')).toBeNull();
    expect((await rules.read()).breakGlass).toEqual({
      userId: 'rescue',
      problem: null,
    });
  });

  it.each([
    ['rescue', 'password', 'required', { userId: 'rescue', problem: null }],
    ['rescue', 'oidc', 'required', null],
    ['pat', 'password', 'required', null],
    ['rescue', 'password', 'optional', null],
    ['rescue', 'password', null, null],
  ] as const)(
    'looks the break-glass account up for a session only when it decides: %s by %s, %s',
    async (userId, providerId, singleSignOn, breakGlass) => {
      await database.db.update(installationSettings).set({ singleSignOn });
      const asked = vi.spyOn(rules, 'breakGlassProblem');
      const rule = await rules.readFor({ userId, providerId });
      expect(rule.breakGlass).toEqual(breakGlass);
      expect(rule.singleSignOn).toBe(singleSignOn ?? 'optional');
      expect(asked).toHaveBeenCalledTimes(breakGlass ? 1 : 0);
      asked.mockRestore();
    },
  );
});
