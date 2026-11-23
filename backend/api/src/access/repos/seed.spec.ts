import { asc } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { allows, moduleTarget } from '../core/allows.js';
import { PERMISSIONS } from '../core/permissions.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleUserDirectory } from './drizzle-user-directory.js';
import { emailSignInCodes } from './email-codes.tables.js';
import { exampleSeed } from './example-seed.js';
import { signInLinks } from './passwords.tables.js';
import { Seed, seedAccess } from './seed.js';

/** Everything the seed touches, without timestamps. */
async function contents(database: PgliteDatabase) {
  const { db } = database;
  const strip = <T extends { createdAt: Date }>({ createdAt, ...rest }: T) =>
    rest;
  return {
    roles: (await db.select().from(roles).orderBy(asc(roles.id))).map(strip),
    users: (await db.select().from(users).orderBy(asc(users.id))).map(strip),
    assignments: (
      await db
        .select()
        .from(roleAssignments)
        .orderBy(asc(roleAssignments.userId), asc(roleAssignments.roleId))
    ).map(strip),
  };
}

describe('seedAccess', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(() => database?.close());

  it('writes the example roles and users, each user with its roles', async () => {
    const seed = Seed.parse(exampleSeed);
    await seedAccess(database, seed);
    const directory = new DrizzleUserDirectory(database);
    for (const user of seed.users) {
      const actor = await directory.findActor(user.id);
      expect(actor?.roles.map((r) => r.id).sort()).toEqual(
        [...user.roles].sort(),
      );
    }
    // Translating means reading the source language too.
    const translator = await directory.findActor('sample-translator');
    const module = (lang: string) =>
      moduleTarget(
        { lang, type: 'procedure', audience: 'public', facets: {} },
        { audiences: [{ id: 'public', label: 'Public' }], facets: [] },
      );
    expect(translator && allows(translator, 'content.read', module('en'))).toBe(
      true,
    );
    expect(
      translator && allows(translator, 'translation.manage', module('de')),
    ).toBe(true);
    expect(
      translator && allows(translator, 'translation.manage', module('en')),
    ).toBe(false);
    const approver = await directory.findActor('sample-approver');
    expect(approver?.roles.find((r) => r.id === 'restricted-approver')).toEqual(
      expect.objectContaining({ scope: { moduleTypes: ['safety'] } }),
    );
  });

  it('is idempotent', async () => {
    const seed = Seed.parse(exampleSeed);
    await seedAccess(database, seed);
    const first = await contents(database);
    await seedAccess(database, seed);
    expect(await contents(database)).toEqual(first);
  });

  it('brings seeded roles and users back to the seed, leaving others alone', async () => {
    const seed = Seed.parse(exampleSeed);
    await seedAccess(database, seed);
    const first = await contents(database);
    // Changed by hand since, plus things the seed does not know.
    await database.db
      .update(roles)
      .set({ permissions: ['content.read'], languages: ['en'] });
    await database.db.delete(roleAssignments);
    await database.db
      .insert(roles)
      .values({ id: 'custom', name: 'Custom', permissions: ['content.read'] });
    await database.db.insert(users).values({ id: 'someone', name: 'Someone' });
    await database.db.insert(roleAssignments).values([
      { userId: 'someone', roleId: 'custom' },
      { userId: 'sample-reader', roleId: 'custom' },
    ]);

    await seedAccess(database, seed);

    const after = await contents(database);
    expect(after.roles.filter((r) => r.id !== 'custom')).toEqual(first.roles);
    expect(after.users.filter((u) => u.id !== 'someone')).toEqual(first.users);
    const key = (a: { userId: string; roleId: string }) =>
      `${a.userId} ${a.roleId}`;
    expect(after.assignments.map(key).sort()).toEqual(
      [...first.assignments, { userId: 'someone', roleId: 'custom' }]
        .map(key)
        .sort(),
    );
  });

  it('writes a user without roles and removes the roles it held', async () => {
    await seedAccess(database, {
      roles: [{ id: 'r', name: 'R', permissions: ['content.read'], scope: {} }],
      users: [{ id: 'u', name: 'U', roles: ['r'] }],
    });
    await seedAccess(database, {
      roles: [],
      users: [{ id: 'u', name: 'U', roles: [] }],
    });
    expect((await contents(database)).assignments).toEqual([]);
  });

  it('ends what was emailed to an address it replaces: the open code and the links (#646)', async () => {
    const later = new Date(Date.now() + 10 * 60_000);
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    const seedWith = (email?: string) =>
      seedAccess(database, {
        roles: [],
        users: [{ id: 'u', name: 'U', ...(email && { email }), roles: [] }],
      });
    /** A code and an invite for `u`, as if both had been emailed just now. */
    const open = async (n: number) => {
      const [user] = await database.db.select().from(users);
      await database.db.insert(emailSignInCodes).values({
        userId: 'u',
        codeHash: hex(n),
        linkHash: hex(n + 1),
        sentTo: user!.email!,
        expiresAt: later,
      });
      await database.db.insert(signInLinks).values({
        tokenHash: hex(n + 2),
        userId: 'u',
        kind: 'invite',
        expiresAt: later,
      });
    };
    const left = async () => ({
      codes: (await database.db.select().from(emailSignInCodes)).length,
      links: (await database.db.select().from(signInLinks)).length,
    });

    await seedWith('u@example.org');
    await open(10);
    // The same address (ignoring case), or none in the seed: what was emailed stays.
    await seedWith('U@Example.org');
    await seedWith();
    expect(await left()).toEqual({ codes: 1, links: 1 });
    // Another address: both end, in the seed's transaction.
    await seedWith('u.new@example.org');
    expect(await left()).toEqual({ codes: 0, links: 0 });
  });

  it('writes nothing when any part fails', async () => {
    await expect(
      seedAccess(database, {
        roles: [
          { id: 'r', name: 'R', permissions: ['content.read'], scope: {} },
        ],
        // Not in the database: the foreign key refuses it.
        users: [{ id: 'u', name: 'U', roles: ['missing'] }],
      }),
    ).rejects.toThrow();
    expect(await contents(database)).toEqual({
      roles: [],
      users: [],
      assignments: [],
    });
  });
});

describe('Seed', () => {
  it('accepts the example, whose admin holds every permission', () => {
    const seed = Seed.parse(exampleSeed);
    expect(seed.roles.find((r) => r.id === 'admin')?.permissions).toEqual([
      ...PERMISSIONS,
    ]);
  });

  it('names only sample users', () => {
    for (const user of Seed.parse(exampleSeed).users) {
      expect(user.id).toMatch(/^sample-/);
      expect(user.name).toMatch(/^Sample /);
    }
  });

  const role = { id: 'r', name: 'R', permissions: ['content.read'], scope: {} };
  it.each([
    [
      'an unknown permission',
      { roles: [{ ...role, permissions: ['x.y'] }], users: [] },
    ],
    [
      'an empty permission list',
      { roles: [{ ...role, permissions: [] }], users: [] },
    ],
    [
      'an unknown scope dimension',
      { roles: [{ ...role, scope: { serials: ['1'] } }], users: [] },
    ],
    [
      'an empty scope list',
      { roles: [{ ...role, scope: { languages: [] } }], users: [] },
    ],
    ['a duplicate role', { roles: [role, role], users: [] }],
    [
      'a duplicate user',
      {
        roles: [role],
        users: [
          { id: 'u', name: 'U', roles: [] },
          { id: 'u', name: 'U', roles: [] },
        ],
      },
    ],
    [
      'a role not in the seed',
      { roles: [], users: [{ id: 'u', name: 'U', roles: ['r'] }] },
    ],
    [
      'an empty facet map',
      { roles: [{ ...role, scope: { facets: {} } }], users: [] },
    ],
    [
      'a "__proto__" facet',
      {
        roles: [
          {
            ...role,
            scope: JSON.parse('{"facets":{"__proto__":["x"],"region":["eu"]}}'),
          },
        ],
        users: [],
      },
    ],
    [
      'a malformed user ID',
      { roles: [], users: [{ id: 'U 1', name: 'U', roles: [] }] },
    ],
  ])('refuses %s', (_, seed) => {
    expect(Seed.safeParse(seed).success).toBe(false);
  });
});
