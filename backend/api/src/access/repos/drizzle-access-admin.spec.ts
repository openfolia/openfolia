import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import type { RoleDefinition } from '../core/access-admin.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';

const author: RoleDefinition = {
  id: 'author',
  name: 'Author',
  description: 'Writes modules',
  permissions: ['content.read', 'content.edit'],
  scope: { languages: ['de'], facets: { region: ['eu'] } },
};

describe('DrizzleAccessAdmin', () => {
  let database: PgliteDatabase;
  let admin: DrizzleAccessAdmin;
  let unit: DrizzleUnitOfWork;

  beforeEach(async () => {
    database = await createTestDatabase();
    admin = new DrizzleAccessAdmin(database);
    unit = new DrizzleUnitOfWork(database);
    await database.db
      .insert(roles)
      .values([{ id: 'admin', name: 'Admin', permissions: ['admin.roles'] }]);
    await database.db
      .insert(users)
      .values([{ id: 'root', name: 'Root', email: 'root@example.org' }]);
    await database.db
      .insert(roleAssignments)
      .values({ userId: 'root', roleId: 'admin' });
  });

  afterEach(() => database?.close());

  it('creates, changes, lists and deletes roles', async () => {
    await unit.run(async (tx) => {
      await admin.lock(tx);
      expect(await admin.insertRole(tx, author)).toBe(true);
      expect(await admin.insertRole(tx, author)).toBe(false);
    });
    expect(await admin.findRole('author')).toEqual({ ...author, holders: 0 });
    await unit.run((tx) =>
      admin.updateRole(tx, {
        ...author,
        description: null,
        scope: { maxAudience: 'customer' },
      }),
    );
    expect(await admin.findRole('author')).toMatchObject({
      description: null,
      scope: { maxAudience: 'customer' },
    });
    const page = await admin.listRoles({ number: 1, size: 10 });
    expect(page.items.map((r) => [r.id, r.holders])).toEqual([
      ['admin', 1],
      ['author', 0],
    ]);
    await unit.run(async (tx) => {
      expect(await admin.missingRoles(tx, ['author', 'nope'])).toEqual([
        'nope',
      ]);
      await admin.deleteRole(tx, 'author');
    });
    expect(await admin.findRole('author')).toBeUndefined();
  });

  it('creates users, finds a taken email ignoring case, assigns roles', async () => {
    await unit.run(async (tx) => {
      expect(await admin.emailTaken(tx, 'ROOT@example.org')).toBe(true);
      expect(await admin.emailTaken(tx, 'root@example.org', 'root')).toBe(
        false,
      );
      expect(
        await admin.insertUser(tx, {
          id: 'bob',
          name: 'Bob',
          email: 'bob@example.org',
        }),
      ).toBe(true);
      expect(
        await admin.insertUser(tx, { id: 'bob', name: 'B', email: null }),
      ).toBe(false);
      expect(await admin.assign(tx, 'bob', 'admin')).toBe(true);
      expect(await admin.assign(tx, 'bob', 'admin')).toBe(false);
      await admin.updateUser(tx, 'bob', { name: 'Robert', email: null });
    });
    await unit.run(async (tx) => {
      expect(await admin.findUser(tx, 'bob')).toEqual({
        id: 'bob',
        name: 'Robert',
        email: null,
        deactivatedAt: null,
        roleIds: ['admin'],
        groupRoleIds: [],
        permissions: ['admin.roles'],
        signIn: { password: false, provider: false, inviteExpiresAt: null },
      });
      expect([...(await admin.heldPermissions(tx, 'bob'))]).toEqual([
        'admin.roles',
      ]);
    });
  });

  it('counts active admins only', async () => {
    await unit.run(async (tx) => {
      expect(await admin.countActiveAdmins(tx)).toBe(1);
      const at = await admin.setDeactivated(tx, 'root', true);
      expect(at).toBeInstanceOf(Date);
      expect(await admin.countActiveAdmins(tx)).toBe(0);
      expect(await admin.setDeactivated(tx, 'root', false)).toBeNull();
      expect(await admin.unassign(tx, 'root', 'admin')).toBe(true);
      expect(await admin.unassign(tx, 'root', 'admin')).toBe(false);
      expect(await admin.countActiveAdmins(tx)).toBe(0);
    });
  });

  it('refuses a second user with the same email in any case', async () => {
    await expect(
      database.db
        .insert(users)
        .values({ id: 'copy', name: 'Copy', email: 'Root@Example.org' }),
    ).rejects.toThrow();
  });
});
