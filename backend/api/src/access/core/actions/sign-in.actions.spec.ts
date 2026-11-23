import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeEmailCodes } from '../../../../tests/fakes/fake-email-codes.js';
import {
  FakeGroupMappings,
  FakeIdentityProvider,
  FakeSessionPolicy,
  FakeSessionStore,
  FakeUserIdentities,
} from '../../../../tests/fakes/fake-sign-in.js';
import { FakeSignInLinks } from '../../../../tests/fakes/fake-passwords.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import type { RoleDefinition } from '../access-admin.js';
import type { Actor } from '../actor.js';
import {
  type ExternalIdentity,
  SignInFailedError,
  StaticIdentityProviders,
} from '../identity-provider.js';
import { hashSessionToken, SESSION_TOKEN_PATTERN } from '../sessions.js';
import { userIdBase } from '../sign-in-users.js';
import { WaysIn } from '../ways-in.js';
import { AuthenticateSessionAction } from './authenticate-session.action.js';
import { CompleteSignInAction } from './complete-sign-in.action.js';
import { UpdateUserAction } from './update-user.action.js';
import {
  CreateGroupMappingAction,
  DeleteGroupMappingAction,
  ListGroupMappingsAction,
} from './group-mappings.action.js';
import {
  ListIdentityProvidersAction,
  SignOutAction,
} from './sign-in.action.js';

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
  description: null,
  permissions: ['content.read', 'content.edit'],
  scope: {},
};
const root: Actor = { kind: 'user', id: 'root', roles: [{ ...adminRole }] };

const identity = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
  issuer: 'https://idp.example.org',
  subject: 'sub-1',
  email: 'pat@example.org',
  emailVerified: true,
  name: 'Pat Example',
  username: 'pat',
  groups: [],
  ...over,
});

function setUp() {
  const admin = new FakeAccessAdmin();
  admin.putRole(adminRole);
  admin.putRole(authorRole);
  admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: ['admin'] });
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const identities = new FakeUserIdentities(admin);
  const mappings = new FakeGroupMappings(admin);
  const sessions = new FakeSessionStore();
  const policy = new FakeSessionPolicy();
  const provider = new FakeIdentityProvider();
  const providers = new StaticIdentityProviders([provider]);
  const links = new FakeSignInLinks();
  const codes = new FakeEmailCodes(admin);
  const waysIn = new WaysIn(sessions, links, codes);
  const complete = new CompleteSignInAction(
    providers,
    admin,
    identities,
    mappings,
    sessions,
    policy,
    audit,
    unit,
    links,
    waysIn,
  );
  const signIn = async (who: ExternalIdentity, previousToken?: string) => {
    provider.next = who;
    return complete.handle({
      providerId: 'oidc',
      callback: new URLSearchParams({ state: 's1', code: 'c' }),
      pending: { state: 's1' },
      ...(previousToken !== undefined && { previousToken }),
    });
  };
  const token = async (who: ExternalIdentity) => {
    const outcome = await signIn(who);
    if (!('token' in outcome)) throw new Error(`refused: ${outcome.refused}`);
    return outcome;
  };
  return {
    admin,
    audit,
    unit,
    links,
    codes,
    waysIn,
    identities,
    mappings,
    sessions,
    policy,
    provider,
    providers,
    complete,
    signIn,
    token,
    createMapping: new CreateGroupMappingAction(admin, mappings, audit, unit),
    deleteMapping: new DeleteGroupMappingAction(admin, mappings, audit, unit),
    actions: () => audit.events.map((e) => e.action),
  };
}

describe('CompleteSignInAction', () => {
  it('makes a user at the first sign-in, from the login name, without roles', async () => {
    const s = setUp();
    const outcome = await s.token(identity());
    expect(outcome.userId).toBe('pat');
    expect(outcome.token).toMatch(SESSION_TOKEN_PATTERN);
    expect(s.admin.user('pat')).toMatchObject({
      name: 'Pat Example',
      email: 'pat@example.org',
      roleIds: [],
    });
    expect(
      s.sessions.sessions.get(hashSessionToken(outcome.token)),
    ).toMatchObject({ userId: 'pat', provider: 'oidc', revokedAt: null });
    expect(s.actions()).toEqual(['user.create', 'user.sign-in']);
    expect(s.audit.events.at(-1)?.data).toEqual({
      provider: 'oidc',
      created: true,
      linked: false,
    });
  });

  it('signs the same identity in as the same user later', async () => {
    const s = setUp();
    await s.token(identity());
    const again = await s.token(identity({ name: 'Pat Renamed' }));
    expect(again.userId).toBe('pat');
    expect(s.admin.user('pat')?.name).toBe('Pat Renamed');
    expect([...s.admin.committed.users.keys()]).toEqual(['root', 'pat']);
  });

  it('ends an open code by email when the provider brings a new address, not when it keeps it (#645)', async () => {
    const s = setUp();
    await s.token(identity());
    const openCode = () =>
      s.unit.run((tx) =>
        s.codes.replace(tx, {
          userId: 'pat',
          codeHash: '0'.repeat(64),
          linkHash: '1'.repeat(64),
          sentTo: s.admin.user('pat')!.email!,
          expiresAt: new Date(Date.now() + 600_000),
        }),
      );
    await openCode();
    await s.token(identity({ email: 'PAT@example.org', name: 'Pat Renamed' }));
    expect(s.codes.codes.has('pat')).toBe(true);
    await s.token(identity({ email: 'pat@new.example.org' }));
    expect(s.admin.user('pat')?.email).toBe('pat@new.example.org');
    expect(s.codes.codes.has('pat')).toBe(false);
  });

  it('makes another identity with the same login name a user of its own', async () => {
    const s = setUp();
    await s.token(identity());
    const other = await s.token(
      identity({ subject: 'sub-2', email: 'pat@other.example.org' }),
    );
    expect(other.userId).toBe('pat-2');
  });

  it('links a user with the same verified email address that has no identity there yet', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'PAT@example.org',
      roleIds: ['author'],
    });
    const outcome = await s.token(identity());
    expect(outcome.userId).toBe('p.example');
    expect(s.audit.events.at(-1)?.data).toMatchObject({ linked: true });
    expect(
      s.audit.events.find((e) => e.action === 'user.identity-link'),
    ).toMatchObject({
      subject: { type: 'user', id: 'p.example' },
      data: {
        issuer: 'https://idp.example.org',
        provider: 'oidc',
        via: 'email',
      },
    });
    expect(s.admin.user('p.example')?.roleIds).toEqual(['author']);
  });

  it('closes the open invite of the user it links (#373: the first admin signing in with the provider)', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['admin'],
    });
    await s.unit.run((tx) =>
      s.links.replace(tx, {
        hash: 'h1',
        userId: 'p.example',
        kind: 'invite',
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    const hold = vi.spyOn(s.codes, 'holdToEnd');
    const revoke = vi.spyOn(s.links, 'revokeAll');
    await s.token(identity());
    expect(s.links.links.size).toBe(0);
    // The person before their invite (#650), as every change that ends ways in takes them.
    expect(hold).toHaveBeenCalledWith(expect.anything(), 'p.example');
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      revoke.mock.invocationCallOrder[0]!,
    );
    expect(
      s.audit.events.find((e) => e.action === 'user.invite-withdraw'),
    ).toMatchObject({
      subject: { type: 'user', id: 'p.example' },
      data: { via: 'sign-in', provider: 'oidc' },
    });
    // A later sign-in (already linked) touches no link.
    await s.unit.run((tx) =>
      s.links.replace(tx, {
        hash: 'h2',
        userId: 'p.example',
        kind: 'invite',
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    await s.token(identity());
    expect(s.links.links.size).toBe(1);
  });

  it('by default never links a user who has signed in before, at any provider', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['admin'],
    });
    // They signed in at another issuer once: claimed, so no new identity joins them.
    await s.token(
      identity({ issuer: 'https://other.example.org', subject: 'o-1' }),
    );
    expect(s.actions()).toContain('user.identity-link');
    const outcome = await s.token(identity());
    expect(outcome.userId).toBe('pat');
    expect(s.actions().filter((a) => a === 'user.identity-link')).toHaveLength(
      1,
    );
    expect(s.admin.user('pat')?.roleIds).toEqual([]);
  });

  it('by default never links a user who signs in with a password (#610)', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['admin'],
    });
    s.identities.withPassword.add('p.example');
    const outcome = await s.token(identity());
    expect(outcome.userId).toBe('pat');
    expect(s.actions()).not.toContain('user.identity-link');
  });

  it('links any user without an identity at that issuer when set to any', async () => {
    const s = setUp();
    s.policy.linking = 'any';
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['author'],
    });
    await s.token(
      identity({ issuer: 'https://other.example.org', subject: 'o-1' }),
    );
    expect((await s.token(identity())).userId).toBe('p.example');
    // One per issuer still.
    expect(
      (await s.token(identity({ subject: 'sub-2', username: 'pat2' }))).userId,
    ).toBe('pat2');
  });

  it('never links when set to off: a new user', async () => {
    const s = setUp();
    s.policy.linking = 'off';
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['admin'],
    });
    const outcome = await s.token(identity());
    expect(outcome.userId).toBe('pat');
    expect(s.actions()).not.toContain('user.identity-link');
    expect(s.admin.user('pat')?.roleIds).toEqual([]);
  });

  it('never links by an email address the provider does not vouch for', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'p.example',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['admin'],
    });
    const outcome = await s.token(identity({ emailVerified: false }));
    expect(outcome.userId).toBe('pat');
    // Not the address either: another user holds it, and it is not vouched for.
    expect(s.admin.user('pat')?.email).toBeNull();
  });

  it('never links a user who already has an identity at that issuer', async () => {
    const s = setUp();
    await s.token(identity());
    const second = await s.token(
      identity({ subject: 'sub-2', username: 'pat2' }),
    );
    expect(second.userId).toBe('pat2');
    expect(s.admin.user('pat2')?.email).toBeNull();
  });

  it('applies the groups through the mappings at every sign-in; direct roles stay', async () => {
    const s = setUp();
    await s.createMapping.handle({
      actor: root,
      group: 'writers',
      roleId: 'author',
    });
    s.audit.events.length = 0;
    const first = await s.token(identity({ groups: ['writers', 'other'] }));
    expect(s.admin.user(first.userId)).toMatchObject({
      roleIds: ['author'],
      groupRoleIds: ['author'],
    });
    expect(
      s.audit.events.find((e) => e.action === 'role.assign')?.data,
    ).toEqual({
      userId: 'pat',
      via: 'groups',
    });
    await s.token(identity({ groups: [] }));
    expect(s.admin.user('pat')?.roleIds).toEqual([]);
    expect(s.actions()).toContain('role.unassign');
  });

  it('takes the last admin’s group role as the provider says', async () => {
    const s = setUp();
    await s.createMapping.handle({
      actor: root,
      group: 'admins',
      roleId: 'admin',
    });
    await s.token(identity({ groups: ['admins'] }));
    expect(s.admin.user('pat')?.roleIds).toEqual(['admin']);
    await s.token(identity({ groups: [] }));
    expect(s.admin.user('pat')?.roleIds).toEqual([]);
  });

  it('refuses a deactivated user, and writes nothing', async () => {
    const s = setUp();
    await s.token(identity());
    s.admin.committed.users.get('pat')!.deactivatedAt = new Date();
    const before = s.sessions.sessions.size;
    s.audit.events.length = 0;
    expect(await s.signIn(identity({ name: 'Changed' }))).toEqual({
      refused: 'user-deactivated',
    });
    expect(s.sessions.sessions.size).toBe(before);
    expect(s.admin.user('pat')?.name).toBe('Pat Example');
    expect(s.audit.events).toEqual([]);
  });

  it('refuses whom the session policy refuses', async () => {
    const s = setUp();
    s.policy.refuse.add('pat');
    expect(await s.signIn(identity())).toEqual({
      refused: 'sign-in-not-allowed',
    });
    expect(s.admin.user('pat')).toBeUndefined();
  });

  it('ends the session the browser held before', async () => {
    const s = setUp();
    const first = await s.token(identity());
    const second = await s.signIn(identity(), first.token);
    expect('token' in second).toBe(true);
    expect(
      s.sessions.sessions.get(hashSessionToken(first.token))?.revokedAt,
    ).not.toBeNull();
  });

  it('passes the provider’s refusal on, and knows only its providers', async () => {
    const s = setUp();
    s.provider.next = new SignInFailedError('access-denied', 'no');
    await expect(
      s.complete.handle({
        providerId: 'oidc',
        callback: new URLSearchParams({ state: 's1' }),
        pending: { state: 's1' },
      }),
    ).rejects.toMatchObject({ reason: 'access-denied' });
    await expect(
      s.complete.handle({
        providerId: 'saml',
        callback: new URLSearchParams(),
        pending: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AuthenticateSessionAction', () => {
  function authenticate() {
    const s = setUp();
    const users = new FakeUserDirectory();
    const auth = new AuthenticateSessionAction(s.sessions, s.policy, users);
    return { ...s, users, auth };
  }

  it('acts as the session’s user with the roles they hold now', async () => {
    const s = authenticate();
    const { token, userId } = await s.token(identity());
    s.users.put({ kind: 'user', id: userId, roles: [{ ...authorRole }] });
    const result = await s.auth.handle({ token });
    expect(result).toMatchObject({
      actor: { id: 'pat', roles: [{ id: 'author' }] },
      session: { provider: 'oidc' },
    });
  });

  it('refuses a malformed, unknown or signed-out token alike', async () => {
    const s = authenticate();
    const { token, userId } = await s.token(identity());
    s.users.put({ kind: 'user', id: userId, roles: [] });
    expect(await s.auth.handle({ token: 'nope' })).toEqual({
      refused: 'invalid-session',
    });
    expect(
      await s.auth.handle({ token: `ccms_ses_${'0'.repeat(64)}` }),
    ).toEqual({
      refused: 'invalid-session',
    });
    await s.sessions.revoke(hashSessionToken(token));
    expect(await s.auth.handle({ token })).toEqual({
      refused: 'invalid-session',
    });
  });

  it('ends a session past its idle time or its longest lifetime', async () => {
    const s = authenticate();
    let now = Date.parse('2026-11-20T10:00:00Z');
    s.sessions.now = () => now;
    s.auth.now = () => now;
    s.policy.fixed = { idleMs: 60 * 60_000, maxMs: 3 * 60 * 60_000 };
    const { token, userId } = await s.token(identity());
    s.users.put({ kind: 'user', id: userId, roles: [] });
    now += 50 * 60_000;
    expect(await s.auth.handle({ token })).toHaveProperty('actor');
    now += 50 * 60_000;
    expect(await s.auth.handle({ token })).toHaveProperty('actor');
    now += 61 * 60_000;
    expect(await s.auth.handle({ token })).toEqual({
      refused: 'session-expired',
    });
    // Ended: asked again, it is no session at all.
    expect(await s.auth.handle({ token })).toEqual({
      refused: 'invalid-session',
    });

    const busy = await s.token(identity());
    for (let i = 0; i < 6; i++) {
      now += 30 * 60_000;
      const result = await s.auth.handle({ token: busy.token });
      expect(result).toHaveProperty(
        i < 5 ? 'actor' : 'refused',
        i < 5 ? expect.anything() : 'session-expired',
      );
    }
  });

  it('says a deactivated user is deactivated', async () => {
    const s = authenticate();
    const { token, userId } = await s.token(identity());
    s.users.put({ kind: 'user', id: userId, roles: [] });
    s.users.deactivated.set(userId, new Date());
    expect(await s.auth.handle({ token })).toEqual({
      refused: 'user-deactivated',
    });
  });
});

describe('SignOutAction', () => {
  it('ends the session, records it and answers the provider’s address', async () => {
    const s = setUp();
    const { token } = await s.token(identity());
    const signOut = new SignOutAction(s.sessions, s.providers, s.audit, s.unit);
    const out = await signOut.handle({
      token,
      returnTo: 'https://editor.example.org/sign-in',
    });
    expect(out.signOutUrl).toBe(
      'https://idp.example.org/logout?post_logout_redirect_uri=https%3A%2F%2Feditor.example.org%2Fsign-in',
    );
    expect(
      s.sessions.sessions.get(hashSessionToken(token))?.revokedAt,
    ).not.toBeNull();
    expect(s.actions().at(-1)).toBe('user.sign-out');
    // Again, or with nothing: nothing to end, nothing said.
    expect(await signOut.handle({ token, returnTo: '/' })).toEqual({
      signOutUrl: undefined,
    });
    expect(await signOut.handle({ token: undefined, returnTo: '/' })).toEqual({
      signOutUrl: undefined,
    });
  });
});

describe('ListIdentityProvidersAction', () => {
  it('lists the providers, paged', () => {
    const s = setUp();
    const page = new ListIdentityProvidersAction(s.providers).handle({
      page: { number: 1, size: 10 },
    });
    expect(page).toEqual({
      items: [{ id: 'oidc', displayName: 'Test provider' }],
      total: 1,
    });
  });
});

describe('group mappings', () => {
  it('gives the role to the group’s members at once, and takes it again', async () => {
    const s = setUp();
    await s.token(identity({ groups: ['writers'] }));
    const mapping = await s.createMapping.handle({
      actor: root,
      group: 'writers',
      roleId: 'author',
    });
    expect(s.admin.user('pat')?.roleIds).toEqual(['author']);
    expect(s.actions()).toEqual(
      expect.arrayContaining(['group-mapping.create', 'role.assign']),
    );
    const list = await new ListGroupMappingsAction(s.mappings).handle({
      actor: root,
      page: { number: 1, size: 10 },
      filter: { role: 'author' },
    });
    expect(list.items.map((m) => m.group)).toEqual(['writers']);

    await expect(
      s.createMapping.handle({
        actor: root,
        group: 'writers',
        roleId: 'author',
      }),
    ).rejects.toMatchObject({ code: 'group-mapping-exists' });
    await expect(
      s.createMapping.handle({ actor: root, group: 'writers', roleId: 'nope' }),
    ).rejects.toMatchObject({ code: 'unknown-role' });

    await s.deleteMapping.handle({ actor: root, id: mapping.id });
    expect(s.admin.user('pat')?.roleIds).toEqual([]);
    await expect(
      s.deleteMapping.handle({ actor: root, id: mapping.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never makes a group role direct when an admin sets the user’s roles', async () => {
    const s = setUp();
    await s.token(identity({ groups: ['writers'] }));
    await s.createMapping.handle({
      actor: root,
      group: 'writers',
      roleId: 'author',
    });
    const update = new UpdateUserAction(s.admin, s.waysIn, s.audit, s.unit);
    // The editor sends every role it shows: the group's one with the one added.
    await update.handle({
      actor: root,
      userId: 'pat',
      changes: { roles: { set: ['author', 'admin'] } },
    });
    expect(s.admin.user('pat')).toMatchObject({
      roleIds: ['admin', 'author'],
      groupRoleIds: ['author'],
    });
    // Left out: still the group's, unchanged.
    await update.handle({
      actor: root,
      userId: 'pat',
      changes: { roles: { set: ['admin'] } },
    });
    expect(s.admin.user('pat')?.groupRoleIds).toEqual(['author']);
    // The group goes: so does its role; the direct one stays.
    await s.token(identity({ groups: [] }));
    expect(s.admin.user('pat')?.roleIds).toEqual(['admin']);
  });

  it('keeps a direct assignment of the role the mapping gave too', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      roleIds: ['author'],
    });
    await s.token(identity({ groups: ['writers'] }));
    const mapping = await s.createMapping.handle({
      actor: root,
      group: 'writers',
      roleId: 'author',
    });
    expect(s.admin.user('pat')?.groupRoleIds).toEqual([]);
    await s.deleteMapping.handle({ actor: root, id: mapping.id });
    expect(s.admin.user('pat')?.roleIds).toEqual(['author']);
  });

  it('refuses to remove the mapping the last admin holds admin.roles through', async () => {
    const s = setUp();
    const mapping = await s.createMapping.handle({
      actor: root,
      group: 'admins',
      roleId: 'admin',
    });
    await s.token(identity({ groups: ['admins'] }));
    s.admin.committed.users.get('root')!.roleIds.clear();
    const pat: Actor = { kind: 'user', id: 'pat', roles: [{ ...adminRole }] };
    await expect(
      s.deleteMapping.handle({ actor: pat, id: mapping.id }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(s.admin.user('pat')?.roleIds).toEqual(['admin']);
  });
});

describe('userIdBase', () => {
  it('makes a user ID of a login name or an email address', () => {
    expect(userIdBase(identity({ username: 'Zoë Müller' }))).toBe('zoe-muller');
    expect(
      userIdBase(identity({ username: null, email: 'J.Doe+x@example.org' })),
    ).toBe('j.doe-x');
    expect(userIdBase(identity({ username: '---', email: null }))).toBe('user');
    expect(userIdBase(identity({ username: 'a'.repeat(100) }))).toHaveLength(
      56,
    );
  });
});
