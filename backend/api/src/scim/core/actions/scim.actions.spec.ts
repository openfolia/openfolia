import {
  directory,
  scimRole,
  scimSetUp as setUp,
} from '../../../../tests/fakes/scim-set-up.js';
import type { Actor } from '../../../access/core/actor.js';
import { UpdateRoleAction } from '../../../access/core/actions/update-role.action.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import {
  ScimInvalidFilterError,
  ScimInvalidValueError,
} from '../scim-errors.js';
const jane = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: 'jane.doe@example.org',
  externalId: 'E-1',
  name: { givenName: 'Jane', familyName: 'Doe' },
  emails: [{ value: 'jane.doe@example.org', type: 'work', primary: true }],
  password: 'never kept',
  active: true,
};

describe('provisioning users', () => {
  it('makes a user, its ID from userName, its name and address from the resource, audited', async () => {
    const s = setUp();
    const user = await s.createUser.handle({ actor: directory, body: jane });
    expect(user).toMatchObject({
      userId: 'jane.doe',
      userName: 'jane.doe@example.org',
      externalId: 'E-1',
      deactivatedAt: null,
    });
    expect(user.attributes).not.toHaveProperty('password');
    expect(s.admin.user('jane.doe')).toMatchObject({
      name: 'Jane Doe',
      email: 'jane.doe@example.org',
    });
    expect(s.actions()).toEqual(['user.create']);
    expect(s.audit.events[0]?.data).toMatchObject({ via: 'scim' });
    await expect(
      s.createUser.handle({ actor: directory, body: { ...jane, emails: [] } }),
    ).rejects.toMatchObject({ code: 'scim-user-name-taken' });
  });

  it('links an existing user by address only as the link-by-email setting allows, never an admin', async () => {
    const s = setUp();
    s.admin.putUser({ id: 'jd', name: 'J', email: 'jane.doe@example.org' });
    const linked = await s.createUser.handle({ actor: directory, body: jane });
    expect(linked.userId).toBe('jd');
    expect(s.actions()).toEqual(['user.identity-link', 'user.update']);
    expect(s.admin.user('jd')?.name).toBe('Jane Doe');

    // A user who signed in already is not taken over in `pending` mode; with `any` they are.
    const t = setUp();
    t.admin.putUser({ id: 'jd', name: 'J', email: 'jane.doe@example.org' });
    t.identities.withPassword.add('jd');
    await expect(
      t.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({
      code: 'email-taken',
    });
    t.policy.linking = 'any';
    expect(
      (await t.createUser.handle({ actor: directory, body: jane })).userId,
    ).toBe('jd');

    const u = setUp();
    u.policy.linking = 'any';
    await expect(
      u.createUser.handle({
        actor: directory,
        body: { ...jane, emails: [{ value: 'root@example.org' }] },
      }),
    ).rejects.toMatchObject({ code: 'email-taken' });
    u.policy.linking = 'off';
    u.admin.putUser({ id: 'jd', name: 'J', email: 'jane.doe@example.org' });
    await expect(
      u.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({
      code: 'email-taken',
    });
  });

  it('deactivates at once on active false: sessions end, locks go, work stays; and reactivates', async () => {
    const s = setUp();
    await s.createUser.handle({ actor: directory, body: jane });
    s.locks.locks.push({
      id: '0190a000-0000-7000-8000-000000000001',
      subject: { type: 'module', lang: 'en', moduleId: 'battery' },
      changeSetId: '0190a000-0000-7000-8000-0000000000aa',
      holder: { kind: 'user', id: 'jane.doe' },
      since: new Date(),
    });
    await s.unit.run((tx) =>
      s.sessions.create(tx, {
        hash: 'a'.repeat(64),
        userId: 'jane.doe',
        provider: 'oidc',
        endedBefore: new Date(0),
      }),
    );
    const patched = await s.patchUser.handle({
      actor: directory,
      userId: 'jane.doe',
      operations: [{ op: 'replace', path: 'active', value: 'False' }],
    });
    expect(patched.deactivatedAt).toBeInstanceOf(Date);
    expect(s.locks.locks).toHaveLength(0);
    expect(s.sessions.sessions.get('a'.repeat(64))?.revokedAt).toBeInstanceOf(
      Date,
    );
    expect(s.actions().slice(1)).toEqual(['user.deactivate', 'lock.release']);
    expect(s.audit.events[1]?.data).toMatchObject({
      via: 'scim',
      sessionsEnded: 1,
    });

    await s.replaceUser.handle({
      actor: directory,
      userId: 'jane.doe',
      body: jane,
    });
    expect(s.admin.user('jane.doe')?.deactivatedAt).toBeNull();
    expect(s.actions().at(-1)).toBe('user.reactivate');
  });

  it('writes nothing for a replace that changes nothing, and audits what changed', async () => {
    const s = setUp();
    await s.createUser.handle({ actor: directory, body: jane });
    await s.replaceUser.handle({
      actor: directory,
      userId: 'jane.doe',
      body: jane,
    });
    expect(s.actions()).toEqual(['user.create']);
    await s.replaceUser.handle({
      actor: directory,
      userId: 'jane.doe',
      body: { ...jane, displayName: 'Jane D.', title: 'Writer' },
    });
    expect(s.admin.user('jane.doe')?.name).toBe('Jane D.');
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'user.update',
      data: { via: 'scim', changed: ['name', 'attributes'] },
    });
  });

  it('fails closed on addresses: never links a privileged user, changes only the address of a plain user it made', async () => {
    const s = setUp();
    s.policy.linking = 'any';
    s.admin.putRole({
      id: 'publisher',
      name: 'Publisher',
      description: null,
      permissions: ['content.read', 'release.publish'],
      scope: {},
    });
    // Any permission beyond reading and writing content keeps a user from being taken over.
    s.admin.putUser({
      id: 'pub',
      name: 'P',
      email: 'jane.doe@example.org',
      roleIds: ['publisher'],
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({ code: 'email-taken' });

    // A user it linked keeps their address: a reset mailed to the directory's would take it.
    s.admin.putUser({
      id: 'pub',
      name: 'P',
      email: 'jane.doe@example.org',
      roleIds: ['author'],
    });
    const linked = await s.createUser.handle({ actor: directory, body: jane });
    expect(linked).toMatchObject({ userId: 'pub', createdByScim: false });
    const moved = { ...jane, emails: [{ value: 'someone@else.example' }] };
    await expect(
      s.replaceUser.handle({ actor: directory, userId: 'pub', body: moved }),
    ).rejects.toMatchObject({ code: 'scim-address-locked' });
    expect(s.admin.user('pub')?.email).toBe('jane.doe@example.org');

    // A user it made: its address follows the directory, until it holds more than content work.
    const made = {
      ...jane,
      userName: 'made',
      emails: [{ value: 'm@example.org' }],
    };
    await s.createUser.handle({ actor: directory, body: made });
    const again = { ...made, emails: [{ value: 'm2@example.org' }] };
    await s.replaceUser.handle({
      actor: directory,
      userId: 'made',
      body: again,
    });
    expect(s.admin.user('made')?.email).toBe('m2@example.org');
    s.admin.putUser({
      id: 'made',
      name: 'Jane Doe',
      email: 'm2@example.org',
      roleIds: ['publisher'],
    });
    await expect(
      s.replaceUser.handle({ actor: directory, userId: 'made', body: made }),
    ).rejects.toMatchObject({ code: 'scim-address-locked' });
  });

  it('never links, nor reactivates, a user an admin deactivated', async () => {
    const s = setUp();
    s.policy.linking = 'any';
    s.admin.putUser({
      id: 'gone',
      name: 'G',
      email: 'jane.doe@example.org',
      deactivatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({ code: 'email-taken' });

    // Provisioned, then deactivated by an admin: `active: true` leaves it deactivated.
    const { userId } = await s.createUser.handle({
      actor: directory,
      body: { ...jane, emails: [{ value: 'jd@example.org' }] },
    });
    s.admin.putUser({
      id: userId,
      name: 'Jane Doe',
      email: 'jd@example.org',
      deactivatedAt: new Date('2026-02-01T00:00:00Z'),
    });
    const body = { ...jane, emails: [{ value: 'jd@example.org' }] };
    const kept = await s.replaceUser.handle({
      actor: directory,
      userId,
      body,
    });
    expect(kept.deactivatedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(s.actions()).not.toContain('user.reactivate');

    // Its own deactivation it may undo, but not once an admin deactivated the user again.
    s.admin.putUser({ id: userId, name: 'Jane Doe', email: 'jd@example.org' });
    await s.replaceUser.handle({
      actor: directory,
      userId,
      body: { ...body, active: false },
    });
    const own = (await s.scim.findUser(userId))?.scimDeactivatedAt;
    expect(own).toBeInstanceOf(Date);
    s.admin.putUser({
      id: userId,
      name: 'Jane Doe',
      email: 'jd@example.org',
      deactivatedAt: new Date(own!.getTime() + 1000),
    });
    await s.replaceUser.handle({ actor: directory, userId, body });
    expect(s.admin.user(userId)?.deactivatedAt).not.toBeNull();
  });

  it('deprovisions a user whose address it may not change: the address stays, the user goes', async () => {
    const s = setUp();
    s.policy.linking = 'any';
    s.admin.putUser({ id: 'jd', name: 'J', email: 'jane.doe@example.org' });
    await s.createUser.handle({ actor: directory, body: jane });
    const moved = { ...jane, emails: [{ value: 'someone@else.example' }] };
    await s.replaceUser.handle({
      actor: directory,
      userId: 'jd',
      body: { ...moved, active: false },
    });
    expect(s.admin.user('jd')).toMatchObject({
      email: 'jane.doe@example.org',
    });
    expect(s.admin.user('jd')?.deactivatedAt).toBeInstanceOf(Date);
  });

  it('provisions a user it let go again: the same user, reactivated, unless an admin deactivated them', async () => {
    const s = setUp();
    const { userId } = await s.createUser.handle({
      actor: directory,
      body: jane,
    });
    // Signed in since: the default link-by-email setting would not take them over.
    s.identities.withPassword.add(userId);
    await s.deleteUser.handle({ actor: directory, userId });
    const again = await s.createUser.handle({ actor: directory, body: jane });
    expect(again).toMatchObject({
      userId,
      createdByScim: true,
      deactivatedAt: null,
    });

    await s.deleteUser.handle({ actor: directory, userId });
    s.admin.putUser({
      id: userId,
      name: 'Jane Doe',
      email: 'jane.doe@example.org',
      deactivatedAt: new Date('2027-01-01T00:00:00Z'),
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({ code: 'email-taken' });
  });

  it('takes a let-go user up again only while its own deactivation stands, and never with linking off', async () => {
    const s = setUp();
    const { userId } = await s.createUser.handle({
      actor: directory,
      body: jane,
    });
    await s.deleteUser.handle({ actor: directory, userId });
    s.policy.linking = 'off';
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({ code: 'email-taken' });
    s.policy.linking = 'pending';
    // Reactivated by an admin since: the editor's user now.
    s.admin.putUser({
      id: userId,
      name: 'Jane Doe',
      email: 'jane.doe@example.org',
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toMatchObject({ code: 'email-taken' });
  });

  it('ends a half-finished second step (#611) on active false and on DELETE, and reactivating brings none back', async () => {
    const s = setUp();
    await s.createUser.handle({ actor: directory, body: jane });
    const open = async () => {
      await s.unit.run((tx) =>
        s.pending.create(
          tx,
          {
            hash: 'b'.repeat(64),
            userId: 'jane.doe',
            step: 'verify',
            provider: 'password',
            via: null,
            expiresAt: new Date(Date.now() + 60_000),
          },
          new Date(),
        ),
      );
      expect(s.pending.open.size).toBe(1);
    };
    await open();
    await s.patchUser.handle({
      actor: directory,
      userId: 'jane.doe',
      operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(s.pending.open.size).toBe(0);
    await s.replaceUser.handle({
      actor: directory,
      userId: 'jane.doe',
      body: jane,
    });
    expect(s.admin.user('jane.doe')?.deactivatedAt).toBeNull();
    expect(s.pending.open.size).toBe(0);
    await open();
    await s.deleteUser.handle({ actor: directory, userId: 'jane.doe' });
    expect(s.pending.open.size).toBe(0);
  });

  it('lets a user go on DELETE: deactivated, unlinked, out of its groups, the user kept', async () => {
    const s = setUp();
    await s.createUser.handle({ actor: directory, body: jane });
    await s.deleteUser.handle({ actor: directory, userId: 'jane.doe' });
    expect(s.admin.user('jane.doe')?.deactivatedAt).toBeInstanceOf(Date);
    expect(await s.scim.findUser('jane.doe')).toBeUndefined();
    expect(s.actions().slice(1)).toEqual([
      'user.deactivate',
      'user.identity-unlink',
    ]);
    await expect(
      s.getUser.handle({ actor: directory, userId: 'jane.doe' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      s.deleteUser.handle({ actor: directory, userId: 'jane.doe' }),
    ).rejects.toThrow(NotFoundError);
    // Only provisioned users are reached: an admin's own user is not found.
    await expect(
      s.patchUser.handle({
        actor: directory,
        userId: 'root',
        operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('keeps an admin: deactivating the last active one is refused and rolled back', async () => {
    const s = setUp();
    s.policy.linking = 'any';
    s.admin.putUser({ id: 'root', name: 'Root', email: 'root@example.org' });
    s.admin.putUser({ id: 'boss', name: 'Boss', email: 'boss@example.org' });
    await s.createUser.handle({
      actor: directory,
      body: { userName: 'boss', emails: [{ value: 'boss@example.org' }] },
    });
    s.admin.putUser({
      id: 'boss',
      name: 'boss',
      email: 'boss@example.org',
      roleIds: ['admin'],
    });
    await expect(
      s.deleteUser.handle({ actor: directory, userId: 'boss' }),
    ).rejects.toMatchObject({ code: 'last-admin' });
    expect(s.admin.user('boss')?.deactivatedAt).toBeNull();
  });

  it('lists the provisioned users, filtered and paged', async () => {
    const s = setUp();
    for (const n of ['ann', 'bob', 'cid']) {
      await s.createUser.handle({ actor: directory, body: { userName: n } });
    }
    const all = await s.listUsers.handle({
      actor: directory,
      page: { startIndex: 2, count: 1 },
    });
    expect(all.total).toBe(3);
    expect(all.items.map((u) => u.userId)).toEqual(['bob']);
    const one = await s.listUsers.handle({
      actor: directory,
      filter: 'userName eq "CID"',
      page: { startIndex: 1, count: 100 },
    });
    expect(one.items.map((u) => u.userId)).toEqual(['cid']);
    await expect(
      s.listUsers.handle({
        actor: directory,
        filter: 'userName',
        page: { startIndex: 1, count: 1 },
      }),
    ).rejects.toThrow(ScimInvalidFilterError);
  });

  it('refuses anyone but an active service account holding scim.provision now', async () => {
    const s = setUp();
    const person: Actor = { kind: 'user', id: 'root', roles: [scimRole] };
    await expect(
      s.createUser.handle({ actor: person, body: jane }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      s.listUsers.handle({ actor: person, page: { startIndex: 1, count: 1 } }),
    ).rejects.toThrow(ForbiddenError);
    // The request's roles held it, the account's roles no longer do.
    s.accounts.putAccount({
      id: 'directory-sync',
      name: 'Directory',
      description: null,
      roleIds: [],
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toThrow(ForbiddenError);
    s.accounts.putAccount({
      id: 'directory-sync',
      name: 'Directory',
      description: null,
      roleIds: ['directory'],
      deactivatedAt: new Date(),
    });
    await expect(
      s.createUser.handle({ actor: directory, body: jane }),
    ).rejects.toThrow(ForbiddenError);
    expect(s.audit.events).toHaveLength(0);
  });
});

describe('provisioning groups', () => {
  async function withUsers() {
    const s = setUp();
    for (const n of ['ann', 'bob']) {
      await s.createUser.handle({ actor: directory, body: { userName: n } });
    }
    await s.unit.run((tx) => s.mappings.insert(tx, 'Writers', 'author'));
    return s;
  }

  it('never gives a role with a global permission through a SCIM group: its token makes no admin', async () => {
    const s = await withUsers();
    await s.unit.run((tx) => s.mappings.insert(tx, 'Admins', 'admin'));
    await s.createGroup.handle({
      actor: directory,
      body: { displayName: 'Admins', members: [{ value: 'ann' }] },
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual([]);
  });

  it('takes a role from a SCIM group’s members once it gains a global permission', async () => {
    const s = await withUsers();
    await s.createGroup.handle({
      actor: directory,
      body: { displayName: 'Writers', members: [{ value: 'ann' }] },
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual(['author']);
    const updateRole = new UpdateRoleAction(
      s.admin,
      s.audit,
      s.unit,
      s.mappings,
    );
    const root: Actor = {
      kind: 'user',
      id: 'root',
      roles: [
        {
          id: 'admin',
          name: 'Admin',
          permissions: ['admin.roles'],
          scope: {},
        },
      ],
    };
    await updateRole.handle({
      actor: root,
      roleId: 'author',
      changes: { permissions: ['content.read', 'content.edit', 'admin.roles'] },
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual([]);
    expect(s.actions().slice(-2)).toEqual(['role.update', 'role.unassign']);
    // Narrowed again: given again.
    await updateRole.handle({
      actor: root,
      roleId: 'author',
      changes: { permissions: ['content.read', 'content.edit'] },
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual(['author']);
  });

  it('gives a group’s members what its mappings give, as they join and leave', async () => {
    const s = await withUsers();
    const group = await s.createGroup.handle({
      actor: directory,
      body: { displayName: 'Writers', members: [{ value: 'ann' }] },
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual(['author']);
    expect(s.actions().slice(2)).toEqual(['scim-group.create', 'role.assign']);

    await s.patchGroup.handle({
      actor: directory,
      groupId: group.id,
      operations: [
        { op: 'add', path: 'members', value: [{ value: 'bob' }] },
        { op: 'remove', path: 'members[value eq "ann"]' },
      ],
    });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual([]);
    expect(s.admin.user('bob')?.groupRoleIds).toEqual(['author']);
    expect(
      s.audit.events.find((e) => e.action === 'scim-group.update')?.data,
    ).toEqual({
      changed: [],
      membersAdded: ['bob'],
      membersRemoved: ['ann'],
    });

    // Renamed to a name no mapping has: its members lose the role.
    await s.replaceGroup.handle({
      actor: directory,
      groupId: group.id,
      body: { displayName: 'Former writers', members: [{ value: 'bob' }] },
    });
    expect(s.admin.user('bob')?.groupRoleIds).toEqual([]);

    await s.replaceGroup.handle({
      actor: directory,
      groupId: group.id,
      body: { displayName: 'Writers', members: [{ value: 'bob' }] },
    });
    await s.deleteGroup.handle({ actor: directory, groupId: group.id });
    expect(s.admin.user('bob')?.groupRoleIds).toEqual([]);
    expect(s.actions().at(-2)).toBe('scim-group.delete');
    const listed = await s.listGroups.handle({
      actor: directory,
      page: { startIndex: 1, count: 10 },
    });
    expect(listed.total).toBe(0);
  });

  it('refuses a member that is no provisioned user, a group as a member, and a name taken', async () => {
    const s = await withUsers();
    await expect(
      s.createGroup.handle({
        actor: directory,
        body: { displayName: 'Writers', members: [{ value: 'root' }] },
      }),
    ).rejects.toThrow(ScimInvalidValueError);
    await expect(
      s.createGroup.handle({
        actor: directory,
        body: {
          displayName: 'Writers',
          members: [{ value: 'x', type: 'Group' }],
        },
      }),
    ).rejects.toThrow(ScimInvalidValueError);
    await s.createGroup.handle({
      actor: directory,
      body: { displayName: 'Writers' },
    });
    await expect(
      s.createGroup.handle({
        actor: directory,
        body: { displayName: 'Writers' },
      }),
    ).rejects.toMatchObject({ code: 'scim-group-name-taken' });
  });

  it('takes users out of their groups when they are let go', async () => {
    const s = await withUsers();
    const group = await s.createGroup.handle({
      actor: directory,
      body: {
        displayName: 'Writers',
        members: [{ value: 'ann' }, { value: 'bob' }],
      },
    });
    await s.deleteUser.handle({ actor: directory, userId: 'ann' });
    expect(s.admin.user('ann')?.groupRoleIds).toEqual([]);
    expect(
      (await s.scim.findGroup(group.id))?.members.map((m) => m.userId),
    ).toEqual(['bob']);
  });
});
