import { FakeServiceAccountStore } from '../../../../tests/fakes/fake-service-accounts.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import type { Actor, Role } from '../actor.js';
import { API_TOKEN_ACTOR } from '../service-actor.js';
import { GetMeAction } from './get-me.action.js';
import { ListDemoUsersAction } from './list-demo-users.action.js';
import { ListUsersAction } from './list-users.action.js';
import { ResolveActorAction } from './resolve-actor.action.js';

const author: Role = {
  id: 'author',
  name: 'Author',
  permissions: ['content.read', 'content.edit'],
  scope: { languages: ['de'] },
};
const admin: Role = {
  id: 'admin',
  name: 'Admin',
  permissions: ['admin.roles'],
  scope: {},
};
const alice: Actor = { kind: 'user', id: 'alice', roles: [author] };
const root: Actor = { kind: 'user', id: 'root', roles: [admin, author] };

const directory = () =>
  new FakeUserDirectory([alice, root], { alice: 'Alice', root: 'Root' });

describe('ResolveActorAction', () => {
  it('is the read-only token service when no user is asked for', async () => {
    for (const demo of [false, true]) {
      expect(
        await new ResolveActorAction(directory()).handle({
          requestedUser: undefined,
          demo,
        }),
      ).toEqual({ actor: API_TOKEN_ACTOR });
    }
    expect(API_TOKEN_ACTOR.roles.flatMap((r) => r.permissions).sort()).toEqual([
      'content.read',
      'content.read.draft',
    ]);
  });

  it('refuses a requested user outside demo mode, even a known one', async () => {
    expect(
      await new ResolveActorAction(directory()).handle({
        requestedUser: 'alice',
        demo: false,
      }),
    ).toEqual({ refused: 'demo-mode-off' });
  });

  it('acts as the requested user in demo mode', async () => {
    const action = new ResolveActorAction(directory());
    expect(await action.handle({ requestedUser: 'alice', demo: true })).toEqual(
      { actor: alice },
    );
    for (const unknown of ['nobody', '', 'alice, root']) {
      expect(
        await action.handle({ requestedUser: unknown, demo: true }),
      ).toEqual({ refused: 'unknown-user' });
    }
  });

  it('rejects when the directory fails, instead of falling back', async () => {
    const failing = directory();
    failing.fail = new Error('database down');
    await expect(
      new ResolveActorAction(failing).handle({
        requestedUser: 'alice',
        demo: true,
      }),
    ).rejects.toThrow('database down');
  });
});

describe('GetMeAction', () => {
  it('gives a user with its name and effective permissions', async () => {
    expect(
      await new GetMeAction(directory(), new FakeServiceAccountStore()).handle({
        actor: root,
      }),
    ).toEqual({
      actor: root,
      name: 'Root',
      permissions: [
        { permission: 'content.read', scopes: [{ languages: ['de'] }] },
        { permission: 'content.edit', scopes: [{ languages: ['de'] }] },
        { permission: 'admin.roles', scopes: [{}] },
      ],
    });
  });

  it('names the token service without asking the directory', async () => {
    const failing = directory();
    failing.fail = new Error('unused');
    const me = await new GetMeAction(
      failing,
      new FakeServiceAccountStore(),
    ).handle({
      actor: API_TOKEN_ACTOR,
    });
    expect(me.name).toBe('API token');
    expect(me.permissions).toEqual([
      { permission: 'content.read', scopes: [{}] },
      { permission: 'content.read.draft', scopes: [{}] },
    ]);
  });
});

describe('ListUsersAction', () => {
  it('lists users for an actor holding admin.roles', async () => {
    expect(
      await new ListUsersAction(directory()).handle({
        actor: root,
        page: { number: 1, size: 1 },
      }),
    ).toEqual({
      items: [
        {
          id: 'alice',
          name: 'Alice',
          email: null,
          deactivatedAt: null,
          roleIds: ['author'],
          groupRoleIds: [],
          permissions: ['content.read', 'content.edit'],
        },
      ],
      total: 2,
    });
  });

  it('refuses everyone else', async () => {
    for (const actor of [alice, API_TOKEN_ACTOR]) {
      await expect(
        new ListUsersAction(directory()).handle({
          actor,
          page: { number: 1, size: 10 },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('ListDemoUsersAction', () => {
  const page = { number: 1, size: 10 };

  it('lists users in demo mode for any actor, even one holding no permission', async () => {
    for (const actor of [alice, API_TOKEN_ACTOR]) {
      expect(
        await new ListDemoUsersAction(directory()).handle({
          actor,
          page,
          demo: true,
        }),
      ).toMatchObject({ total: 2, items: [{ id: 'alice' }, { id: 'root' }] });
    }
  });

  it('is not found outside demo mode, before reading anything', async () => {
    const failing = directory();
    failing.fail = new Error('unused');
    await expect(
      new ListDemoUsersAction(failing).handle({
        actor: root,
        page,
        demo: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
