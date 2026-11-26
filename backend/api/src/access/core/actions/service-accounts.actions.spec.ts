import { FakeGroupMappings } from '../../../../tests/fakes/fake-sign-in.js';
import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeServiceAccountStore } from '../../../../tests/fakes/fake-service-accounts.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { RoleDefinition } from '../access-admin.js';
import type { Actor } from '../actor.js';
import {
  MAX_ACTIVE_TOKENS,
  MAX_TOKEN_LIFETIME_MS,
  serviceAccountActor,
} from '../service-accounts.js';
import { hashServiceToken, SERVICE_TOKEN_PATTERN } from '../service-token.js';
import { AuthenticateServiceTokenAction } from './authenticate-service-token.action.js';
import { CreateServiceAccountAction } from './create-service-account.action.js';
import {
  DeactivateServiceAccountAction,
  ReactivateServiceAccountAction,
} from './deactivate-service-account.action.js';
import {
  GetServiceAccountAction,
  ListServiceAccountsAction,
} from './list-service-accounts.action.js';
import {
  IssueServiceTokenAction,
  ListServiceTokensAction,
  RevokeServiceTokenAction,
} from './service-tokens.action.js';
import { UpdateServiceAccountAction } from './update-service-account.action.js';
import { UpdateRoleAction } from './update-role.action.js';
import { ApproveChangeSetAction } from '../../../change-sets/core/actions/approve-change-set.action.js';
import { SignOffChangeSetAction } from '../../../change-sets/core/actions/sign-off-change-set.action.js';

const adminRole: RoleDefinition = {
  id: 'admin',
  name: 'Admin',
  description: null,
  permissions: ['admin.roles'],
  scope: {},
};
const publisherRole: RoleDefinition = {
  id: 'publisher',
  name: 'Publisher',
  description: null,
  permissions: ['content.read', 'release.publish'],
  scope: {},
};
const readerRole: RoleDefinition = {
  id: 'reader',
  name: 'Reader',
  description: null,
  permissions: ['content.read'],
  scope: { languages: ['de'] },
};
const root: Actor = { kind: 'user', id: 'root', roles: [{ ...adminRole }] };

function setUp() {
  const admin = new FakeAccessAdmin();
  for (const role of [adminRole, publisherRole, readerRole]) {
    admin.putRole(role);
  }
  admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: ['admin'] });
  const store = new FakeServiceAccountStore();
  for (const { description: _, ...role } of [
    adminRole,
    publisherRole,
    readerRole,
  ]) {
    store.roles.set(role.id, role);
  }
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const locks = new FakeLockStore();
  const authenticate = new AuthenticateServiceTokenAction(store);
  return {
    admin,
    store,
    audit,
    unit,
    locks,
    authenticate,
    create: new CreateServiceAccountAction(admin, store, audit, unit),
    update: new UpdateServiceAccountAction(admin, store, audit, unit),
    deactivate: new DeactivateServiceAccountAction(
      admin,
      store,
      locks,
      audit,
      unit,
    ),
    reactivate: new ReactivateServiceAccountAction(admin, store, audit, unit),
    issue: new IssueServiceTokenAction(admin, store, audit, unit),
    revoke: new RevokeServiceTokenAction(admin, store, audit, unit),
    listTokens: new ListServiceTokensAction(store),
    actions: () => audit.events.map((e) => e.action),
  };
}

async function withAccount(s: ReturnType<typeof setUp>) {
  await s.create.handle({
    actor: root,
    account: { id: 'portal', name: 'Portal build', description: null },
    roleIds: ['publisher'],
  });
}

describe('service accounts', () => {
  it('are created with roles, audited without names', async () => {
    const s = setUp();
    const account = await s.create.handle({
      actor: root,
      account: { id: 'portal', name: 'Portal build', description: 'CI' },
      roleIds: ['publisher'],
    });
    expect(account).toMatchObject({
      id: 'portal',
      name: 'Portal build',
      description: 'CI',
      deactivatedAt: null,
      roleIds: ['publisher'],
    });
    expect(s.actions()).toEqual(['service-account.create', 'role.assign']);
    expect(s.audit.events[1]?.data).toEqual({ serviceAccountId: 'portal' });
    expect(JSON.stringify(s.audit.events)).not.toContain('Portal build');

    await expect(
      s.create.handle({
        actor: root,
        account: { id: 'portal', name: 'Again', description: null },
        roleIds: [],
      }),
    ).rejects.toMatchObject({ code: 'service-account-exists' });
    await expect(
      s.create.handle({
        actor: root,
        account: { id: 'other', name: 'Other', description: null },
        roleIds: ['nope'],
      }),
    ).rejects.toThrow(UnprocessableError);
    // Rolled back whole: no account without its roles.
    expect(await s.store.find('other')).toBeUndefined();
  });

  it('are listed, filtered and read', async () => {
    const s = setUp();
    await withAccount(s);
    s.store.putAccount({ id: 'agent', name: 'Agent', description: null });
    const list = new ListServiceAccountsAction(s.store);
    const page = await list.handle({
      actor: root,
      page: { number: 1, size: 50 },
    });
    expect(page.items.map((a) => a.id)).toEqual(['agent', 'portal']);
    const holders = await list.handle({
      actor: root,
      page: { number: 1, size: 50 },
      filter: { role: 'publisher' },
    });
    expect(holders.items.map((a) => a.id)).toEqual(['portal']);
    const get = new GetServiceAccountAction(s.store);
    expect(
      (await get.handle({ actor: root, serviceAccountId: 'agent' })).name,
    ).toBe('Agent');
    await expect(
      get.handle({ actor: root, serviceAccountId: 'none' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('change name, description and roles, recording only what changed', async () => {
    const s = setUp();
    await withAccount(s);
    const updated = await s.update.handle({
      actor: root,
      serviceAccountId: 'portal',
      changes: { description: 'Nightly', roles: { set: ['reader'] } },
    });
    expect(updated).toMatchObject({
      description: 'Nightly',
      roleIds: ['reader'],
    });
    expect(s.actions().slice(2)).toEqual([
      'service-account.update',
      'role.unassign',
      'role.assign',
    ]);
    expect(s.audit.events[2]?.data).toEqual({ changed: ['description'] });
    await expect(
      s.update.handle({
        actor: root,
        serviceAccountId: 'none',
        changes: { name: 'x' },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('never hold a role with admin.roles', async () => {
    const s = setUp();
    await expect(
      s.create.handle({
        actor: root,
        account: { id: 'bot', name: 'Bot', description: null },
        roleIds: ['reader', 'admin'],
      }),
    ).rejects.toMatchObject({
      code: 'admin-role-for-service-account',
      meta: { roles: ['admin'] },
    });
    expect(await s.store.find('bot')).toBeUndefined();
    // Nor through the role they hold.
    await withAccount(s);
    s.admin.serviceAccountRoles.set('publisher', 1);
    const updateRole = new UpdateRoleAction(
      s.admin,
      s.audit,
      s.unit,
      new FakeGroupMappings(s.admin),
    );
    await expect(
      updateRole.handle({
        actor: root,
        roleId: 'publisher',
        changes: { permissions: ['content.read', 'admin.roles'] },
      }),
    ).rejects.toMatchObject({ code: 'role-held-by-service-account' });
  });

  it('never approve or sign off, whatever their roles', async () => {
    const machine = serviceAccountActor('bot', [
      {
        id: 'review',
        name: 'Review',
        permissions: ['content.review', 'content.approve'],
        scope: {},
      },
    ]);
    // Refused before any dependency is used.
    for (const Action of [ApproveChangeSetAction, SignOffChangeSetAction]) {
      const action = Reflect.construct(Action, []) as ApproveChangeSetAction;
      await expect(
        action.handle({ actor: machine, id: 'x' } as never),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('are changed only by a user who still holds admin.roles', async () => {
    const s = setUp();
    await withAccount(s);
    // A service account holding admin.roles still cannot change access.
    const machine = serviceAccountActor('portal', [{ ...adminRole }]);
    await expect(
      s.create.handle({
        actor: machine,
        account: { id: 'x', name: 'X', description: null },
        roleIds: ['admin'],
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      s.issue.handle({
        actor: machine,
        serviceAccountId: 'portal',
        name: 'self',
      }),
    ).rejects.toThrow(ForbiddenError);
    // An admin whose role was taken meanwhile.
    s.admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: [] });
    await expect(
      s.update.handle({
        actor: root,
        serviceAccountId: 'portal',
        changes: { name: 'x' },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('are deactivated with their locks released, and reactivated', async () => {
    const s = setUp();
    await withAccount(s);
    s.locks.locks.push({
      id: '0190a000-0000-7000-8000-000000000001',
      subject: { type: 'module', lang: 'de', moduleId: 'battery' },
      changeSetId: '0190a000-0000-7000-8000-0000000000aa',
      holder: { kind: 'service', id: 'portal' },
      since: new Date(),
    });
    // A user of the same ID keeps its lock: holders are told apart by kind.
    s.locks.locks.push({
      id: '0190a000-0000-7000-8000-000000000002',
      subject: { type: 'module', lang: 'de', moduleId: 'safety' },
      changeSetId: '0190a000-0000-7000-8000-0000000000ab',
      holder: { kind: 'user', id: 'portal' },
      since: new Date(),
    });
    const { account, locksReleased } = await s.deactivate.handle({
      actor: root,
      serviceAccountId: 'portal',
    });
    expect(account.deactivatedAt).toBeInstanceOf(Date);
    expect(locksReleased).toBe(1);
    expect(s.locks.locks.map((l) => l.holder)).toEqual([
      { kind: 'user', id: 'portal' },
    ]);
    expect(s.actions().slice(2)).toEqual([
      'service-account.deactivate',
      'lock.release',
    ]);
    await expect(
      s.deactivate.handle({ actor: root, serviceAccountId: 'portal' }),
    ).rejects.toMatchObject({ code: 'already-deactivated' });
    await s.reactivate.handle({ actor: root, serviceAccountId: 'portal' });
    expect((await s.store.find('portal'))?.deactivatedAt).toBeNull();
    await expect(
      s.reactivate.handle({ actor: root, serviceAccountId: 'portal' }),
    ).rejects.toMatchObject({ code: 'not-deactivated' });
  });
});

describe('service tokens', () => {
  it('are issued once, stored as a hash, audited without the token', async () => {
    const s = setUp();
    await withAccount(s);
    const { token, secret } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    expect(secret).toMatch(SERVICE_TOKEN_PATTERN);
    expect(secret).toContain(token.id);
    const stored = s.store.token(token.id);
    expect(stored?.secretHash).toBe(hashServiceToken(secret));
    expect(JSON.stringify(stored)).not.toContain(secret.slice(26));
    // 90 days by default.
    expect(token.expiresAt.getTime() - token.createdAt.getTime()).toBeCloseTo(
      90 * 24 * 3600 * 1000,
      -4,
    );
    const event = s.audit.events.at(-1);
    expect(event).toMatchObject({
      action: 'service-token.issue',
      subject: { type: 'service-account', id: 'portal' },
      data: { tokenId: token.id },
    });
    const everything = JSON.stringify(s.audit.events);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(stored!.secretHash);

    const listed = await s.listTokens.handle({
      actor: root,
      serviceAccountId: 'portal',
      page: { number: 1, size: 50 },
    });
    expect(listed.items).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(stored!.secretHash);
    expect(listed.items[0]).not.toHaveProperty('secretHash');
  });

  it('refuse a bad expiry, a deactivated account and too many tokens', async () => {
    const s = setUp();
    await withAccount(s);
    const now = Date.now();
    for (const expiresAt of [
      new Date(now - 1000),
      new Date(now + MAX_TOKEN_LIFETIME_MS + 60_000),
    ]) {
      await expect(
        s.issue.handle({
          actor: root,
          serviceAccountId: 'portal',
          name: 'x',
          expiresAt,
        }),
      ).rejects.toMatchObject({ code: 'invalid-expiry' });
    }
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      await s.issue.handle({
        actor: root,
        serviceAccountId: 'portal',
        name: `t${i}`,
      });
    }
    await expect(
      s.issue.handle({ actor: root, serviceAccountId: 'portal', name: 'x' }),
    ).rejects.toMatchObject({ code: 'too-many-tokens' });
    await s.deactivate.handle({ actor: root, serviceAccountId: 'portal' });
    await expect(
      s.issue.handle({ actor: root, serviceAccountId: 'portal', name: 'x' }),
    ).rejects.toMatchObject({ code: 'service-account-deactivated' });
    await expect(
      s.issue.handle({ actor: root, serviceAccountId: 'none', name: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('draw another ID when one is taken', async () => {
    const s = setUp();
    await withAccount(s);
    const first = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'a',
    });
    const real = s.issue.mint;
    let calls = 0;
    s.issue.mint = () => {
      calls++;
      const minted = real();
      return calls === 1 ? { ...minted, id: first.token.id } : minted;
    };
    const second = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'b',
    });
    expect(calls).toBe(2);
    expect(second.token.id).not.toBe(first.token.id);
  });

  it('are revoked, audited, only of their own account', async () => {
    const s = setUp();
    await withAccount(s);
    s.store.putAccount({ id: 'agent', name: 'Agent', description: null });
    const { token } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    await expect(
      s.revoke.handle({
        actor: root,
        serviceAccountId: 'agent',
        tokenId: token.id,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      s.revoke.handle({
        actor: root,
        serviceAccountId: 'portal',
        tokenId: 'not-an-id',
      }),
    ).rejects.toThrow(NotFoundError);
    const revoked = await s.revoke.handle({
      actor: root,
      serviceAccountId: 'portal',
      tokenId: token.id,
    });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(s.actions().at(-1)).toBe('service-token.revoke');
    await expect(
      s.revoke.handle({
        actor: root,
        serviceAccountId: 'portal',
        tokenId: token.id,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('AuthenticateServiceTokenAction', () => {
  it('gives the service account with its roles, and records the use once a minute', async () => {
    const s = setUp();
    await withAccount(s);
    const { token, secret } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    const result = await s.authenticate.handle({ token: secret });
    expect(result).toEqual({
      actor: {
        kind: 'service',
        id: 'portal',
        roles: [
          {
            id: 'publisher',
            name: 'Publisher',
            permissions: ['content.read', 'release.publish'],
            scope: {},
          },
        ],
      },
    });
    await s.authenticate.handle({ token: secret });
    expect(s.store.touched.map((t) => t.tokenId)).toEqual([token.id]);
    const later = Date.now() + 61_000;
    s.authenticate.now = () => later;
    await s.authenticate.handle({ token: secret });
    expect(s.store.touched).toHaveLength(2);
  });

  it('refuses at once what was revoked, expired or deactivated', async () => {
    const s = setUp();
    await withAccount(s);
    const { token, secret } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    await s.deactivate.handle({ actor: root, serviceAccountId: 'portal' });
    expect(await s.authenticate.handle({ token: secret })).toEqual({
      refused: 'service-account-deactivated',
    });
    await s.reactivate.handle({ actor: root, serviceAccountId: 'portal' });
    expect('actor' in (await s.authenticate.handle({ token: secret }))).toBe(
      true,
    );
    s.authenticate.now = () => token.expiresAt.getTime();
    expect(await s.authenticate.handle({ token: secret })).toEqual({
      refused: 'token-expired',
    });
    s.authenticate.now = Date.now;
    await s.revoke.handle({
      actor: root,
      serviceAccountId: 'portal',
      tokenId: token.id,
    });
    expect(await s.authenticate.handle({ token: secret })).toEqual({
      refused: 'token-revoked',
    });
  });

  it('says nothing more than invalid without the secret', async () => {
    const s = setUp();
    await withAccount(s);
    const { token, secret } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    await s.revoke.handle({
      actor: root,
      serviceAccountId: 'portal',
      tokenId: token.id,
    });
    const wrongSecret = `ccms_sat_${token.id}_${'0'.repeat(64)}`;
    for (const bad of [wrongSecret, 'ccms_sat_x', secret.slice(0, -1), '']) {
      expect(await s.authenticate.handle({ token: bad })).toEqual({
        refused: 'invalid-token',
      });
    }
    expect(s.store.touched).toEqual([]);
  });

  it('rejects when the store fails, never refusing on a guess', async () => {
    const s = setUp();
    await withAccount(s);
    const { secret } = await s.issue.handle({
      actor: root,
      serviceAccountId: 'portal',
      name: 'CI',
    });
    s.store.fail = new Error('database down');
    await expect(s.authenticate.handle({ token: secret })).rejects.toThrow(
      'database down',
    );
  });
});
