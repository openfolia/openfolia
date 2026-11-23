import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeEmailCodes } from '../../../../tests/fakes/fake-email-codes.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeSignInLinks } from '../../../../tests/fakes/fake-passwords.js';
import {
  FakeGroupMappings,
  FakeSessionStore,
} from '../../../../tests/fakes/fake-sign-in.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { RoleDefinition } from '../access-admin.js';
import type { Actor } from '../actor.js';
import { WaysIn } from '../ways-in.js';
import { CreateRoleAction } from './create-role.action.js';
import { CreateUserAction } from './create-user.action.js';
import {
  DeactivateUserAction,
  ReactivateUserAction,
} from './deactivate-user.action.js';
import { DeleteRoleAction } from './delete-role.action.js';
import { GetRoleAction, ListRolesAction } from './list-roles.action.js';
import { ResolveActorAction } from './resolve-actor.action.js';
import { UpdateRoleAction } from './update-role.action.js';
import { UpdateUserAction } from './update-user.action.js';

const adminRole: RoleDefinition = {
  id: 'admin',
  name: 'Admin',
  description: null,
  permissions: ['admin.roles'],
  scope: {},
};
const authorRole: RoleDefinition = {
  id: 'author',
  name: 'Author',
  description: 'Writes modules',
  permissions: ['content.read', 'content.edit'],
  scope: { languages: ['de'] },
};
const root: Actor = {
  kind: 'user',
  id: 'root',
  roles: [{ ...adminRole }],
};

function setUp() {
  const admin = new FakeAccessAdmin();
  admin.putRole(adminRole);
  admin.putRole(authorRole);
  admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: ['admin'] });
  admin.putUser({
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.org',
    roleIds: ['author'],
  });
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const locks = new FakeLockStore();
  const sessions = new FakeSessionStore();
  const links = new FakeSignInLinks();
  const codes = new FakeEmailCodes(admin);
  const waysIn = new WaysIn(sessions, links, codes);
  /** An open code by email and an open link for `userId`, as "Email me a code" and an invite leave them. */
  const openWaysIn = async (userId: string) => {
    await unit.run(async (tx) => {
      // A code goes only to an address (#646): none for someone without one.
      const sentTo = admin.user(userId)?.email;
      if (sentTo) {
        const stored = await codes.replace(tx, {
          userId,
          codeHash: '0'.repeat(64),
          linkHash: '1'.repeat(64),
          sentTo,
          expiresAt: new Date(Date.now() + 600_000),
        });
        expect(stored).toBe(true);
      }
      await links.replace(tx, {
        hash: '2'.repeat(64),
        userId,
        kind: 'invite',
        expiresAt: new Date(Date.now() + 600_000),
      });
    });
  };
  /** What still lets `userId` in by email: their open code, their link. */
  const mailedWaysIn = (userId: string) => ({
    code: codes.codes.has(userId),
    link: [...links.links.values()].some((l) => l.userId === userId),
  });
  return {
    admin,
    audit,
    unit,
    locks,
    openWaysIn,
    mailedWaysIn,
    createRole: new CreateRoleAction(admin, audit, unit),
    updateRole: new UpdateRoleAction(admin, audit, unit),
    deleteRole: new DeleteRoleAction(
      admin,
      new FakeGroupMappings(admin),
      audit,
      unit,
    ),
    createUser: new CreateUserAction(admin, audit, unit),
    updateUser: new UpdateUserAction(admin, waysIn, audit, unit),
    deactivate: new DeactivateUserAction(admin, locks, waysIn, audit, unit),
    reactivate: new ReactivateUserAction(admin, audit, unit),
    actions: () => audit.events.map((e) => e.action),
  };
}

describe('roles', () => {
  it('lists them by name with their holders, and reads one', async () => {
    const s = setUp();
    const page = await new ListRolesAction(s.admin).handle({
      actor: root,
      page: { number: 1, size: 10 },
    });
    expect(page.items.map((r) => [r.id, r.holders])).toEqual([
      ['admin', 1],
      ['author', 1],
    ]);
    const get = new GetRoleAction(s.admin);
    await expect(get.handle({ actor: root, roleId: 'nope' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('creates one, audited, and refuses a taken ID', async () => {
    const s = setUp();
    const role = await s.createRole.handle({
      actor: root,
      role: { ...authorRole, id: 'reviewer', name: 'Reviewer' },
    });
    expect(role.holders).toBe(0);
    expect(s.admin.role('reviewer')?.name).toBe('Reviewer');
    expect(s.audit.events[0]).toMatchObject({
      action: 'role.create',
      subject: { type: 'role', id: 'reviewer' },
      data: { permissions: ['content.read', 'content.edit'] },
    });
    await expect(
      s.createRole.handle({ actor: root, role: authorRole }),
    ).rejects.toMatchObject({ code: 'role-exists' });
  });

  it('changes one, recording only the fields that changed', async () => {
    const s = setUp();
    const role = await s.updateRole.handle({
      actor: root,
      roleId: 'author',
      changes: { name: 'Writer', scope: { languages: ['de'] } },
    });
    expect(role).toMatchObject({ name: 'Writer', holders: 1 });
    expect(s.audit.events[0]?.data).toMatchObject({ changed: ['name'] });
    // Nothing changed: nothing recorded.
    await s.updateRole.handle({
      actor: root,
      roleId: 'author',
      changes: { name: 'Writer' },
    });
    expect(s.audit.events).toHaveLength(1);
  });

  it('refuses to take admin.roles from the last admin', async () => {
    const s = setUp();
    await expect(
      s.updateRole.handle({
        actor: root,
        roleId: 'admin',
        changes: { permissions: ['content.read'] },
      }),
    ).rejects.toMatchObject({ code: 'last-admin' });
    expect(s.admin.role('admin')?.permissions).toEqual(['admin.roles']);
    expect(s.audit.events).toHaveLength(0);
  });

  it('deletes only a role nobody holds', async () => {
    const s = setUp();
    await expect(
      s.deleteRole.handle({ actor: root, roleId: 'author' }),
    ).rejects.toMatchObject({ code: 'role-in-use', meta: { holders: 1 } });
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { roles: { remove: ['author'] } },
    });
    await s.deleteRole.handle({ actor: root, roleId: 'author' });
    expect(s.admin.role('author')).toBeUndefined();
    expect(s.actions()).toEqual(['role.unassign', 'role.delete']);
  });
});

describe('users', () => {
  it('adds one with roles, auditing IDs only', async () => {
    const s = setUp();
    const user = await s.createUser.handle({
      actor: root,
      user: { id: 'bob', name: 'Bob', email: 'bob@example.org' },
      roleIds: ['author'],
    });
    expect(user).toMatchObject({ id: 'bob', roleIds: ['author'] });
    expect(s.admin.user('bob')?.roleIds).toEqual(['author']);
    expect(s.actions()).toEqual(['user.create', 'role.assign']);
    expect(JSON.stringify(s.audit.events)).not.toContain('example.org');
    expect(JSON.stringify(s.audit.events)).not.toContain('Bob');
  });

  it('refuses a taken ID, a taken email (any case) and an unknown role', async () => {
    const s = setUp();
    const add = (id: string, email: string, roleIds: string[] = []) =>
      s.createUser.handle({
        actor: root,
        user: { id, name: 'X', email },
        roleIds,
      });
    await expect(add('alice', 'x@example.org')).rejects.toMatchObject({
      code: 'user-exists',
    });
    // Sent again, with its own email address: the ID is what is taken.
    await expect(add('alice', 'ALICE@example.org')).rejects.toMatchObject({
      code: 'user-exists',
    });
    await expect(add('bob', 'ALICE@example.org')).rejects.toMatchObject({
      code: 'email-taken',
    });
    await expect(add('bob', 'b@example.org', ['nope'])).rejects.toThrow(
      UnprocessableError,
    );
    // Nothing of the refused ones was kept.
    expect(s.admin.user('bob')).toBeUndefined();
  });

  it('changes name, email and roles in one go', async () => {
    const s = setUp();
    const user = await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: {
        name: 'Alice B.',
        email: null,
        roles: { set: ['admin'] },
      },
    });
    expect(user).toMatchObject({
      name: 'Alice B.',
      email: null,
      roleIds: ['admin'],
    });
    expect(s.actions()).toEqual([
      'user.update',
      'role.unassign',
      'role.assign',
    ]);
    expect(s.audit.events[0]?.data).toEqual({ changed: ['name', 'email'] });
  });

  it('a new address ends the code and the link emailed to the old one; a name, the same address in other case or a first address does not (#645)', async () => {
    const s = setUp();
    await s.openWaysIn('alice');
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { name: 'Alice B.', email: 'ALICE@example.org' },
    });
    expect(s.mailedWaysIn('alice')).toEqual({ code: true, link: true });
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { email: 'alice.b@example.org' },
    });
    expect(s.mailedWaysIn('alice')).toEqual({ code: false, link: false });
    await s.openWaysIn('alice');
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { email: null },
    });
    expect(s.mailedWaysIn('alice')).toEqual({ code: false, link: false });
    // A first address replaces none: a link copied for someone without one keeps working.
    await s.openWaysIn('alice');
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { email: 'alice@example.org' },
    });
    expect(s.mailedWaysIn('alice').link).toBe(true);
  });

  it('refuses to take the last admin role, from oneself too', async () => {
    const s = setUp();
    await expect(
      s.updateUser.handle({
        actor: root,
        userId: 'root',
        changes: { roles: { set: [] } },
      }),
    ).rejects.toThrow(ConflictError);
    expect(s.admin.user('root')?.roleIds).toEqual(['admin']);
    // With a second admin it may go.
    await s.updateUser.handle({
      actor: root,
      userId: 'alice',
      changes: { roles: { add: ['admin'] } },
    });
    await s.updateUser.handle({
      actor: root,
      userId: 'root',
      changes: { roles: { remove: ['admin'] } },
    });
    expect(s.admin.user('root')?.roleIds).toEqual([]);
  });

  it('refuses an actor who lost admin.roles since the request was resolved', async () => {
    const s = setUp();
    s.admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: [] });
    await expect(
      s.createRole.handle({ actor: root, role: { ...authorRole, id: 'x' } }),
    ).rejects.toThrow(ForbiddenError);
    s.admin.putUser({
      id: 'root',
      name: 'Root',
      email: null,
      roleIds: ['admin'],
      deactivatedAt: new Date(),
    });
    await expect(
      s.createRole.handle({ actor: root, role: { ...authorRole, id: 'x' } }),
    ).rejects.toThrow(ForbiddenError);
    expect(s.admin.role('x')).toBeUndefined();
  });
});

describe('deactivation', () => {
  it('deactivates a user and releases its locks, audited', async () => {
    const s = setUp();
    s.locks.locks.push({
      id: '0190a000-0000-7000-8000-000000000001',
      subject: { type: 'module', lang: 'de', moduleId: 'battery' },
      changeSetId: '0190a000-0000-7000-8000-0000000000aa',
      holder: { kind: 'user', id: 'alice' },
      since: new Date(),
    });
    const { user, locksReleased } = await s.deactivate.handle({
      actor: root,
      userId: 'alice',
    });
    expect(user.deactivatedAt).toBeInstanceOf(Date);
    expect(locksReleased).toBe(1);
    expect(s.locks.locks).toHaveLength(0);
    expect(s.actions()).toEqual(['user.deactivate', 'lock.release']);
    expect(s.audit.events[1]?.data).toMatchObject({
      reason: 'user.deactivate',
    });
    await expect(
      s.deactivate.handle({ actor: root, userId: 'alice' }),
    ).rejects.toMatchObject({ code: 'already-deactivated' });

    await s.reactivate.handle({ actor: root, userId: 'alice' });
    expect(s.admin.user('alice')?.deactivatedAt).toBeNull();
    await expect(
      s.reactivate.handle({ actor: root, userId: 'alice' }),
    ).rejects.toMatchObject({ code: 'not-deactivated' });
    await expect(
      s.deactivate.handle({ actor: root, userId: 'nobody' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('ends the open code by email and the link of the user it deactivates (#645)', async () => {
    const s = setUp();
    await s.openWaysIn('alice');
    await s.deactivate.handle({ actor: root, userId: 'alice' });
    expect(s.mailedWaysIn('alice')).toEqual({ code: false, link: false });
  });

  it('refuses to deactivate the last admin', async () => {
    const s = setUp();
    await expect(
      s.deactivate.handle({ actor: root, userId: 'root' }),
    ).rejects.toMatchObject({ code: 'last-admin' });
    expect(s.admin.user('root')?.deactivatedAt).toBeNull();
  });

  it('makes a deactivated user unable to act, with its own code', async () => {
    const users = new FakeUserDirectory([
      { kind: 'user', id: 'alice', roles: [] },
    ]);
    users.deactivated.set('alice', new Date());
    const resolve = new ResolveActorAction(users);
    expect(
      await resolve.handle({ requestedUser: 'alice', demo: true }),
    ).toEqual({ refused: 'user-deactivated' });
    expect(await resolve.handle({ requestedUser: 'bob', demo: true })).toEqual({
      refused: 'unknown-user',
    });
  });
});
