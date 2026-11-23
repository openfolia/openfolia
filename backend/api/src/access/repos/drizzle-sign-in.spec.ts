import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { MAX_SESSIONS_PER_USER } from '../core/sessions.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { userPasswords } from './passwords.tables.js';
import {
  DrizzleGroupMappings,
  DrizzleSessionStore,
  DrizzleUserIdentities,
} from './drizzle-sign-in.js';
import { DrizzleUserDirectory } from './drizzle-user-directory.js';
import { Seed, seedAccess } from './seed.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');

describe('sign-in tables (#37)', () => {
  let database: PgliteDatabase;
  let unit: DrizzleUnitOfWork;
  let sessions: DrizzleSessionStore;
  let identities: DrizzleUserIdentities;
  let mappings: DrizzleGroupMappings;
  let admin: DrizzleAccessAdmin;
  let directory: DrizzleUserDirectory;

  beforeEach(async () => {
    database = await createTestDatabase();
    unit = new DrizzleUnitOfWork(database);
    sessions = new DrizzleSessionStore(database);
    identities = new DrizzleUserIdentities();
    mappings = new DrizzleGroupMappings(database);
    admin = new DrizzleAccessAdmin(database);
    directory = new DrizzleUserDirectory(database);
    await database.db.insert(roles).values([
      { id: 'admin', name: 'Admin', permissions: ['admin.roles'] },
      { id: 'author', name: 'Author', permissions: ['content.edit'] },
    ]);
    await database.db.insert(users).values([
      { id: 'pat', name: 'Pat', email: 'Pat@Example.org' },
      { id: 'lee', name: 'Lee' },
    ]);
  });

  afterEach(() => database?.close());

  it('keeps sessions by hash, ends them, and keeps a user’s few', async () => {
    await unit.run((tx) =>
      sessions.create(tx, {
        hash: hash(1),
        userId: 'pat',
        provider: 'oidc',
        endedBefore: new Date(0),
      }),
    );
    expect(await sessions.find(hash(1))).toMatchObject({
      hash: hash(1),
      userId: 'pat',
      provider: 'oidc',
      revokedAt: null,
    });
    const later = new Date(Date.now() + 60_000);
    await sessions.touch(hash(1), later);
    expect((await sessions.find(hash(1)))?.lastSeenAt).toEqual(later);
    expect(await sessions.revoke(hash(1))).toBe(true);
    expect(await sessions.revoke(hash(1))).toBe(false);
    expect((await sessions.find(hash(1)))?.revokedAt).not.toBeNull();

    // The next sign-in clears the ended one away; past the most, the oldest end.
    for (let n = 2; n <= MAX_SESSIONS_PER_USER + 3; n++) {
      await unit.run((tx) =>
        sessions.create(tx, {
          hash: hash(n),
          userId: 'pat',
          provider: 'oidc',
          endedBefore: new Date(0),
        }),
      );
    }
    expect(await sessions.find(hash(1))).toBeUndefined();
    const kept = await Promise.all(
      Array.from({ length: MAX_SESSIONS_PER_USER + 2 }, (_, i) =>
        sessions.find(hash(i + 2)),
      ),
    );
    expect(kept.filter(Boolean)).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(await sessions.find(hash(MAX_SESSIONS_PER_USER + 3))).toBeDefined();

    expect(await unit.run((tx) => sessions.revokeAllOf(tx, 'pat'))).toBe(
      MAX_SESSIONS_PER_USER,
    );
  });

  it('links identities, one per issuer and user, and finds users by email ignoring case', async () => {
    await unit.run(async (tx) => {
      expect(await identities.userWithEmail(tx, 'pat@example.ORG')).toBe('pat');
      await identities.link(tx, {
        issuer: 'https://idp.example.org',
        subject: 's1',
        userId: 'pat',
        groups: ['writers'],
      });
      expect(await identities.userOf(tx, 'https://idp.example.org', 's1')).toBe(
        'pat',
      );
      expect(
        await identities.hasIdentityAt(tx, 'pat', 'https://idp.example.org'),
      ).toBe(true);
      expect(
        await identities.hasIdentityAt(tx, 'lee', 'https://idp.example.org'),
      ).toBe(false);
      expect(await identities.hasAnyIdentity(tx, 'pat')).toBe(true);
      expect(await identities.hasAnyIdentity(tx, 'lee')).toBe(false);
    });
    // A password is a way to sign in of their own too (#610).
    await database.db
      .insert(userPasswords)
      .values({ userId: 'lee', hash: '$argon2id$v=19$m=8,t=1,p=1$x$y' });
    expect(await unit.run((tx) => identities.hasAnyIdentity(tx, 'lee'))).toBe(
      true,
    );
    // So is a sign-in with a code by email (#634), from the first one on, recorded once.
    await database.db
      .insert(users)
      .values({ id: 'kim', name: 'Kim', email: 'kim@example.org' });
    expect(await unit.run((tx) => identities.hasAnyIdentity(tx, 'kim'))).toBe(
      false,
    );
    await unit.run((tx) => identities.recordCodeSignIn(tx, 'kim'));
    await unit.run((tx) => identities.recordCodeSignIn(tx, 'kim'));
    expect(await unit.run((tx) => identities.hasAnyIdentity(tx, 'kim'))).toBe(
      true,
    );
    await expect(
      unit.run((tx) =>
        identities.link(tx, {
          issuer: 'https://idp.example.org',
          subject: 's2',
          userId: 'pat',
          groups: [],
        }),
      ),
    ).rejects.toThrow();
  });

  it('gives and takes roles through groups, never touching a direct assignment', async () => {
    await database.db
      .insert(roleAssignments)
      .values({ userId: 'pat', roleId: 'author' });
    const mapping = await unit.run(async (tx) => {
      await identities.link(tx, {
        issuer: 'https://idp.example.org',
        subject: 's1',
        userId: 'pat',
        groups: ['writers', 'admins'],
      });
      const writers = await mappings.insert(tx, 'writers', 'author');
      expect(await mappings.insert(tx, 'writers', 'author')).toBeUndefined();
      await mappings.insert(tx, 'admins', 'admin');
      expect(await mappings.usersInGroup(tx, 'admins')).toEqual(['pat']);
      expect(await mappings.countForRole(tx, 'author')).toBe(1);
      expect(await mappings.applyGroupRoles(tx, 'pat')).toEqual({
        assigned: ['admin', 'author'],
        unassigned: [],
      });
      return writers!;
    });
    expect(await directory.findUser('pat')).toMatchObject({
      roleIds: ['admin', 'author'],
      groupRoleIds: ['admin'],
    });
    expect(await mappings.find(mapping.id)).toEqual(mapping);
    expect(await mappings.find('not-a-uuid')).toBeUndefined();
    expect(
      (await mappings.list({ number: 1, size: 10 }, { group: 'writers' }))
        .items,
    ).toEqual([mapping]);

    // Taken directly: still held through the group.
    expect(await unit.run((tx) => admin.unassign(tx, 'pat', 'author'))).toBe(
      true,
    );
    expect((await directory.findUser('pat'))?.groupRoleIds).toEqual([
      'admin',
      'author',
    ]);
    // Given directly again: held both ways, so the group's going leaves it.
    expect(await unit.run((tx) => admin.assign(tx, 'pat', 'author'))).toBe(
      true,
    );
    expect(await unit.run((tx) => admin.assign(tx, 'pat', 'author'))).toBe(
      false,
    );

    await unit.run(async (tx) => {
      await identities.recordSignIn(tx, 'https://idp.example.org', 's1', []);
      expect(await mappings.applyGroupRoles(tx, 'pat')).toEqual({
        assigned: [],
        unassigned: ['admin', 'author'],
      });
    });
    expect(await directory.findUser('pat')).toMatchObject({
      roleIds: ['author'],
      groupRoleIds: [],
    });
    await unit.run(async (tx) => {
      expect(await mappings.delete(tx, mapping.id)).toEqual(mapping);
      expect(await mappings.delete(tx, mapping.id)).toBeUndefined();
    });
  });

  it('seeds group mappings and keeps group roles when reseeding direct ones', async () => {
    await unit.run(async (tx) => {
      await identities.link(tx, {
        issuer: 'https://idp.example.org',
        subject: 's1',
        userId: 'lee',
        groups: ['admins'],
      });
    });
    const seed = Seed.parse({
      roles: [
        { id: 'admin', name: 'Admin', permissions: ['admin.roles'], scope: {} },
      ],
      users: [{ id: 'lee', name: 'Lee', roles: [] }],
      groupMappings: [{ group: 'admins', role: 'admin' }],
    });
    await seedAccess(database, seed);
    await seedAccess(database, seed);
    expect(await directory.findUser('lee')).toMatchObject({
      roleIds: ['admin'],
      groupRoleIds: ['admin'],
    });
    expect(() =>
      Seed.parse({ ...seed, groupMappings: [{ group: 'x', role: 'nope' }] }),
    ).toThrow(/not in the seed's roles/);
  });
});
