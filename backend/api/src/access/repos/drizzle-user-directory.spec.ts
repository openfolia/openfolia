import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { RoleId, UserId } from '../core/actor.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { signInLinks, userPasswords } from './passwords.tables.js';
import { secondFactors } from './second-factors.tables.js';
import { userIdentities } from './sign-in.tables.js';
import {
  DrizzleUserDirectory,
  InvalidStoredDataError,
  toRole,
} from './drizzle-user-directory.js';

/** What the seeded roles hold, together, in `PERMISSIONS` order. */
const HELD: Record<string, string[]> = {
  editor: ['content.read', 'content.edit'],
  reader: ['content.read'],
};

/** A user as listed, active and without email, with what its roles hold. */
const listed = (id: string, name: string, roleIds: string[] = []) => ({
  id,
  name,
  email: null,
  deactivatedAt: null,
  roleIds,
  groupRoleIds: [],
  permissions: ['content.read', 'content.read.draft', 'content.edit'].filter(
    (p) => roleIds.some((r) => HELD[r]?.includes(p)),
  ),
  signIn: {
    password: false,
    provider: false,
    inviteExpiresAt: null,
    secondFactor: false,
  },
});

describe('DrizzleUserDirectory', () => {
  let database: PgliteDatabase;
  let directory: DrizzleUserDirectory;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = new DrizzleUserDirectory(database);
    await database.db.insert(roles).values([
      {
        id: 'editor',
        name: 'Editor',
        permissions: ['content.read', 'content.edit'],
        languages: ['de'],
        maxAudience: 'customer',
        facets: { region: ['eu'] },
      },
      { id: 'reader', name: 'Reader', permissions: ['content.read'] },
    ]);
    await database.db.insert(users).values([
      { id: 'one', name: 'One' },
      { id: 'none', name: 'No roles' },
    ]);
    await database.db.insert(roleAssignments).values([
      { userId: 'one', roleId: 'reader' },
      { userId: 'one', roleId: 'editor' },
    ]);
  });

  afterEach(() => database?.close());

  it('gives a user with its roles and their scopes', async () => {
    expect(await directory.findActor('one')).toEqual({
      kind: 'user',
      id: 'one',
      roles: [
        {
          id: 'editor',
          name: 'Editor',
          permissions: ['content.read', 'content.edit'],
          scope: {
            languages: ['de'],
            maxAudience: 'customer',
            facets: { region: ['eu'] },
          },
        },
        {
          id: 'reader',
          name: 'Reader',
          permissions: ['content.read'],
          scope: {},
        },
      ],
    });
  });

  it('gives a user without roles an empty list', async () => {
    expect(await directory.findActor('none')).toEqual({
      kind: 'user',
      id: 'none',
      roles: [],
    });
  });

  it('gives undefined for an unknown user or a malformed ID', async () => {
    expect(await directory.findActor('nobody')).toBeUndefined();
    expect(await directory.findActor("one' or '1'='1")).toBeUndefined();
    expect(await directory.findActor('')).toBeUndefined();
  });

  it('gives a user with its name and role IDs', async () => {
    expect(await directory.findUser('one')).toEqual(
      listed('one', 'One', ['editor', 'reader']),
    );
    expect(await directory.findUser('none')).toEqual(
      listed('none', 'No roles'),
    );
    expect(await directory.findUser('nobody')).toBeUndefined();
    expect(await directory.findUser('Not An ID')).toBeUndefined();
  });

  it('lists users by ID, one page at a time', async () => {
    await database.db.insert(users).values({ id: 'a', name: 'A' });
    expect(await directory.listUsers({ number: 1, size: 2 })).toEqual({
      items: [listed('a', 'A'), listed('none', 'No roles')],
      total: 3,
    });
    expect(await directory.listUsers({ number: 2, size: 2 })).toEqual({
      items: [listed('one', 'One', ['editor', 'reader'])],
      total: 3,
    });
    expect(await directory.listUsers({ number: 9, size: 2 })).toEqual({
      items: [],
      total: 3,
    });
  });

  it('filters users by role, status and text', async () => {
    await database.db.insert(users).values({
      id: 'gone',
      name: 'Gone Person',
      email: 'Gone@Example.org',
      deactivatedAt: new Date(),
    });
    const ids = async (filter: Parameters<typeof directory.listUsers>[1]) =>
      (await directory.listUsers({ number: 1, size: 10 }, filter)).items.map(
        (u) => u.id,
      );
    expect(await ids({ role: 'editor' })).toEqual(['one']);
    expect(await ids({ active: true })).toEqual(['none', 'one']);
    expect(await ids({ active: false })).toEqual(['gone']);
    expect(await ids({ q: 'example.ORG' })).toEqual(['gone']);
    expect(await ids({ q: 'ROLES' })).toEqual(['none']);
    // LIKE wildcards are taken literally.
    expect(await ids({ q: '%' })).toEqual([]);
    expect(
      (await directory.listUsers({ number: 1, size: 1 }, { active: true }))
        .total,
    ).toBe(2);
  });

  it('gives no actor for a deactivated user, but the user', async () => {
    await database.db
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(sql`${users.id} = 'one'`);
    expect(await directory.findActor('one')).toBeUndefined();
    expect((await directory.findUser('one'))?.deactivatedAt).toBeInstanceOf(
      Date,
    );
  });

  it('fails loudly on an unknown permission in a stored role', async () => {
    await database.db
      .update(roles)
      .set({ permissions: ['content.read', 'content.delete-everything'] })
      .where(sql`${roles.id} = 'reader'`);
    const lookup = directory.findActor('one');
    await expect(lookup).rejects.toThrow(InvalidStoredDataError);
    await expect(lookup).rejects.toThrow(
      'Role "reader" in the database is invalid (unknown permissions: "content.delete-everything")',
    );
  });

  it('fails loudly on a malformed stored scope', async () => {
    await database.db
      .update(roles)
      .set({ facets: { region: 'eu' } as unknown as Record<string, string[]> })
      .where(sql`${roles.id} = 'editor'`);
    await expect(directory.findActor('one')).rejects.toThrow(
      InvalidStoredDataError,
    );
  });

  it('refuses empty permission and scope lists in the database itself', async () => {
    const insert = (row: Partial<typeof roles.$inferInsert>) =>
      database.db.insert(roles).values({
        id: 'bad',
        name: 'Bad',
        permissions: ['content.read'],
        ...row,
      });
    await expect(insert({ permissions: [] })).rejects.toThrow();
    await expect(insert({ languages: [] })).rejects.toThrow();
    await expect(insert({ moduleTypes: [] })).rejects.toThrow();
    await expect(
      insert({ facets: ['eu'] as unknown as Record<string, string[]> }),
    ).rejects.toThrow();
    await expect(insert({ facets: {} })).rejects.toThrow();
    await expect(insert({ id: 'Bad_Role' })).rejects.toThrow();
    await expect(insert({ id: 'x'.repeat(65) })).rejects.toThrow();
  });

  it('holds the same ID formats as the model', async () => {
    const ids = [
      'a',
      'ab',
      'a.b',
      'a_b',
      'a-b',
      'A',
      'a\n',
      '\na',
      'a b',
      '-a',
      'a-',
      '.a',
      'a.',
      '1',
      'é',
      'x'.repeat(64),
      'x'.repeat(65),
    ];
    for (const id of ids) {
      const user = UserId.safeParse(id).success;
      const stored = await database.db
        .insert(users)
        .values({ id, name: 'X' })
        .then(
          () => true,
          () => false,
        );
      expect([id, stored]).toEqual([id, user]);
      const role = RoleId.safeParse(id).success;
      const storedRole = await database.db
        .insert(roles)
        .values({ id, name: 'X', permissions: ['content.read'] })
        .then(
          () => true,
          () => false,
        );
      expect([id, storedRole]).toEqual([id, role]);
    }
  });

  it('refuses user IDs findActor could not look up', async () => {
    for (const id of ['Alice', 'a b', '-a', 'a-', 'x'.repeat(65), '']) {
      await expect(
        database.db.insert(users).values({ id, name: 'X' }),
      ).rejects.toThrow();
    }
    await database.db.insert(users).values({ id: 'a.b_c-1', name: 'X' });
    expect(await directory.findActor('a.b_c-1')).toEqual({
      kind: 'user',
      id: 'a.b_c-1',
      roles: [],
    });
  });

  it('says how a user signs in: a password, a provider, an open invite (#610)', async () => {
    const expiresAt = new Date('2026-12-01T00:00:00Z');
    await database.db.insert(userPasswords).values({
      userId: 'one',
      hash: '$argon2id$v=19$m=64,t=1,p=1$x$y',
    });
    await database.db.insert(userIdentities).values({
      issuer: 'https://idp.example.com',
      subject: 'one',
      userId: 'one',
    });
    await database.db.insert(signInLinks).values({
      tokenHash: 'a'.repeat(64),
      userId: 'none',
      kind: 'invite',
      expiresAt,
    });
    const at = new Date();
    await database.db.insert(secondFactors).values([
      {
        userId: 'one',
        sealedSecret: 'v1.x',
        begunAt: at,
        confirmedAt: at,
        lastStep: 1,
      },
      { userId: 'none', sealedSecret: 'v1.x', begunAt: at },
    ]);
    expect((await directory.findUser('one'))?.signIn).toEqual({
      password: true,
      provider: true,
      inviteExpiresAt: null,
      secondFactor: true,
    });
    expect((await directory.findUser('none'))?.signIn).toEqual({
      password: false,
      provider: false,
      inviteExpiresAt: expiresAt,
      // Begun is not on.
      secondFactor: false,
    });
  });

  it('keeps a role from being deleted while it is assigned', async () => {
    await expect(
      database.db.delete(roles).where(sql`${roles.id} = 'reader'`),
    ).rejects.toThrow();
    await database.db.delete(users).where(sql`${users.id} = 'one'`);
    expect(await database.db.select().from(roleAssignments)).toEqual([]);
  });
});

describe('toRole', () => {
  const row = {
    id: 'r',
    name: 'R',
    description: null,
    permissions: ['content.read'],
    languages: null,
    moduleTypes: null,
    maxAudience: null,
    facets: null,
    createdAt: new Date(),
  };

  it('names the role and the unknown permission', () => {
    expect(() =>
      toRole({ ...row, permissions: ['content.read', 'nope'] }),
    ).toThrow(
      'Role "r" in the database is invalid (unknown permissions: "nope")',
    );
  });

  it('refuses duplicate permissions and malformed scope values', () => {
    expect(() =>
      toRole({ ...row, permissions: ['content.read', 'content.read'] }),
    ).toThrow(InvalidStoredDataError);
    expect(() => toRole({ ...row, maxAudience: 'Not A Key' })).toThrow(
      InvalidStoredDataError,
    );
    expect(() => toRole({ ...row, languages: ['not a tag'] })).toThrow(
      InvalidStoredDataError,
    );
  });
});
