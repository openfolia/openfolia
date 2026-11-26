import {
  FakePendingSignIns,
  sessionStart,
} from '../../../../tests/fakes/fake-second-factors.js';
import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeEmailCodes } from '../../../../tests/fakes/fake-email-codes.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import {
  FakeMailSettings,
  FakeMailStore,
} from '../../../../tests/fakes/fake-mail.js';
import {
  FakePasswordHasher,
  FakePasswordSignIn,
  FakePasswordStore,
  FakeSignInLinks,
} from '../../../../tests/fakes/fake-passwords.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import {
  FakeSessionPolicy,
  FakeSessionStore,
  FakeUserIdentities,
  FakeSignInEvents,
} from '../../../../tests/fakes/fake-sign-in.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import type { RoleDefinition } from '../access-admin.js';
import type { Actor } from '../actor.js';
import { hashEmailCodeLink, mintEmailCode } from '../email-codes.js';
import { hashSessionToken, mintSessionToken } from '../sessions.js';
import {
  hashSignInLinkToken,
  RESET_LINK_MS,
  SIGN_IN_LINK_PATTERN,
} from '../sign-in-links.js';
import { WaysIn } from '../ways-in.js';
import {
  ChangePasswordAction,
  PasswordSignInAction,
} from './password-sign-in.action.js';
import {
  CreateSignInLinkAction,
  ForgotPasswordAction,
  ReadSignInLinkAction,
  SetPasswordWithLinkAction,
  WithdrawInviteAction,
} from './sign-in-links.action.js';

const adminRole: RoleDefinition = {
  id: 'admin',
  name: 'Admin',
  description: null,
  permissions: ['admin.roles'],
  scope: {},
};
const root: Actor = { kind: 'user', id: 'root', roles: [{ ...adminRole }] };
const pat: Actor = { kind: 'user', id: 'pat', roles: [] };

const GOOD = 'a long and quiet river';
const OTHER = 'another long sentence';

function setUp() {
  let now = Date.parse('2026-11-20T10:00:00Z');
  const clock = () => now;
  const admin = new FakeAccessAdmin();
  admin.putRole(adminRole);
  admin.putUser({ id: 'root', name: 'Root', email: null, roleIds: ['admin'] });
  admin.putUser({ id: 'pat', name: 'Pat Example', email: 'pat@example.org' });
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const settings = new FakePasswordSignIn();
  const passwords = new FakePasswordStore(admin);
  const hasher = new FakePasswordHasher();
  const links = new FakeSignInLinks();
  links.now = clock;
  const sessions = new FakeSessionStore();
  sessions.now = clock;
  const policy = new FakeSessionPolicy();
  const identities = new FakeUserIdentities(admin);
  const mailSettings = new FakeMailSettings();
  const mailStore = new FakeMailStore();
  const jobs = new FakeJobQueue();
  const mail = new MailOutbox(mailSettings, mailStore, fakeSealer(1), jobs);
  const codes = new FakeEmailCodes(admin);
  codes.now = clock;
  const waysIn = new WaysIn(sessions, links, codes, new FakePendingSignIns());
  const events = new FakeSignInEvents();
  const start = sessionStart({
    sessions,
    policy,
    admin,
    codes,
    auditLog: audit,
    events,
  });

  const signIn = new PasswordSignInAction(
    settings,
    passwords,
    hasher,
    start,
    policy,
    admin,
    waysIn,
    audit,
    unit,
  );
  signIn.now = clock;
  const change = new ChangePasswordAction(
    settings,
    passwords,
    hasher,
    admin,
    waysIn,
    audit,
    unit,
  );
  const makeLink = new CreateSignInLinkAction(
    settings,
    admin,
    links,
    mail,
    audit,
    unit,
    policy,
  );
  makeLink.now = clock;
  const readLink = new ReadSignInLinkAction(
    settings,
    links,
    admin,
    unit,
    policy,
  );
  readLink.now = clock;
  const setWithLink = new SetPasswordWithLinkAction(
    settings,
    links,
    admin,
    passwords,
    hasher,
    start,
    policy,
    waysIn,
    audit,
    unit,
  );
  setWithLink.now = clock;
  const forgot = new ForgotPasswordAction(
    settings,
    identities,
    admin,
    links,
    passwords,
    mail,
    audit,
    unit,
    policy,
  );
  forgot.now = clock;
  const withdraw = new WithdrawInviteAction(admin, links, audit, unit);

  /** A running session of `userId`, begun `provider`. */
  const sessionOf = async (userId: string, provider = 'password') => {
    const minted = mintSessionToken();
    await unit.run((tx) =>
      sessions.create(tx, {
        hash: minted.hash,
        userId,
        provider,
        endedBefore: new Date(0),
      }),
    );
    return minted;
  };
  const running = (userId: string) =>
    [...sessions.sessions.values()].filter(
      (s) => s.userId === userId && s.revokedAt === null,
    );
  /** An open code by email for `userId`, as "Email me a code" stores it. */
  const openCode = async (userId: string) => {
    const minted = mintEmailCode();
    await unit.run((tx) =>
      codes.replace(tx, {
        userId,
        codeHash: '0'.repeat(64),
        linkHash: minted.linkHash,
        sentTo: admin.user(userId)!.email!,
        expiresAt: new Date(clock() + 10 * 60_000),
      }),
    );
    return minted.linkToken;
  };
  /** Whether a code for `email` would still be compared, by the code or by its link. */
  const codeWorks = async (email: string, linkToken: string) =>
    (await codes.findByLink(hashEmailCodeLink(linkToken))) !== undefined ||
    (await codes.claim(email, new Date(clock()))) !== undefined;
  return {
    events,
    admin,
    audit,
    codes,
    openCode,
    codeWorks,
    settings,
    passwords,
    hasher,
    links,
    sessions,
    policy,
    mailSettings,
    mailStore,
    signIn,
    change,
    makeLink,
    readLink,
    setWithLink,
    forgot,
    withdraw,
    sessionOf,
    running,
    advance: (ms: number) => {
      now += ms;
    },
    actions: () => audit.events.map((e) => e.action),
    withPassword: async (userId = 'pat', password = GOOD) => {
      passwords.hashes.set(userId, await hasher.hash(password));
    },
  };
}

describe('PasswordSignInAction', () => {
  it('signs in with the right password: a password session, the previous one ended, recorded', async () => {
    const s = setUp();
    await s.withPassword();
    const before = await s.sessionOf('pat', 'oidc');
    const outcome = await s.signIn.handle({
      email: ' PAT@example.org ',
      password: GOOD,
      previousToken: before.token,
    });
    expect(outcome).toMatchObject({ userId: 'pat' });
    if (!('token' in outcome)) throw new Error('refused');
    const session = s.sessions.sessions.get(hashSessionToken(outcome.token));
    expect(session).toMatchObject({ userId: 'pat', provider: 'password' });
    expect(s.sessions.sessions.get(before.hash)?.revokedAt).not.toBeNull();
    const event = s.audit.events.find((e) => e.action === 'user.sign-in');
    expect(event?.data).toEqual({
      method: 'password',
      provider: 'password',
      rehashed: false,
    });
    // Nothing secret in the audit log.
    expect(JSON.stringify(s.audit.events)).not.toContain(GOOD);
    expect(JSON.stringify(s.audit.events)).not.toContain(outcome.token);
  });

  it('answers the same for an unknown address, no password and a wrong one, each checked once', async () => {
    const s = setUp();
    s.admin.putUser({ id: 'lee', name: 'Lee', email: 'lee@example.org' });
    await s.withPassword();
    const unknown = await s.signIn.handle({
      email: 'nobody@example.org',
      password: GOOD,
    });
    const noPassword = await s.signIn.handle({
      email: 'lee@example.org',
      password: GOOD,
    });
    const malformed = await s.signIn.handle({
      email: 'not an address',
      password: GOOD,
    });
    expect(s.hasher.nothings).toBe(3);
    expect(s.hasher.verified).toBe(0);
    const wrong = await s.signIn.handle({
      email: 'pat@example.org',
      password: OTHER,
    });
    expect(s.hasher.verified).toBe(1);
    for (const outcome of [unknown, noPassword, malformed, wrong]) {
      expect(outcome).toEqual({ refused: 'invalid-credentials' });
    }
    expect(s.sessions.sessions.size).toBe(0);
    expect(s.actions()).toEqual([]);
  });

  it('says a user is deactivated, or refused by the policy, only with the right password', async () => {
    const s = setUp();
    await s.withPassword();
    s.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    expect(
      await s.signIn.handle({ email: 'pat@example.org', password: OTHER }),
    ).toEqual({ refused: 'invalid-credentials' });
    expect(
      await s.signIn.handle({ email: 'pat@example.org', password: GOOD }),
    ).toEqual({ refused: 'user-deactivated' });

    const t = setUp();
    await t.withPassword();
    t.policy.refuse.add('pat');
    expect(
      await t.signIn.handle({ email: 'pat@example.org', password: GOOD }),
    ).toEqual({ refused: 'invalid-credentials' });
    expect(t.sessions.sessions.size).toBe(0);
  });

  it('answers whom the policy refuses as a wrong password, after the same work', async () => {
    const s = setUp();
    await s.withPassword();
    s.policy.refuse.add('pat');
    const verify = vi.spyOn(s.hasher, 'verify');
    s.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    expect(
      await s.signIn.handle({ email: 'pat@example.org', password: GOOD }),
    ).toEqual({ refused: 'invalid-credentials' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('answers the same when the policy changes between the check and the session', async () => {
    const s = setUp();
    await s.withPassword();
    const asked = vi
      .spyOn(s.policy, 'maySignIn')
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    expect(
      await s.signIn.handle({ email: 'pat@example.org', password: GOOD }),
    ).toEqual({ refused: 'invalid-credentials' });
    expect(asked).toHaveBeenCalledTimes(2);
    expect(s.sessions.sessions.size).toBe(0);
    expect(s.audit.events).toEqual([]);
  });

  it('records each use of the break-glass account, and tells of it (#378)', async () => {
    const s = setUp();
    await s.withPassword();
    s.policy.required = true;
    await s.signIn.handle({ email: 'pat@example.org', password: GOOD });
    expect(s.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['user.break-glass-sign-in', 'user.sign-in']),
    );
    expect(s.events.used).toEqual(['pat']);
  });

  it('rehashes a password made with other parameters, once', async () => {
    const s = setUp();
    await s.withPassword();
    s.hasher.version = 2;
    await s.signIn.handle({ email: 'pat@example.org', password: GOOD });
    expect(s.passwords.hashes.get('pat')).toBe(`fake$2$${GOOD}`);
    expect(
      s.audit.events.find((e) => e.action === 'user.sign-in')?.data,
    ).toMatchObject({ rehashed: true });
    // With the current parameters already: kept as it is.
    await s.signIn.handle({ email: 'pat@example.org', password: GOOD });
    expect(
      s.audit.events.filter((e) => e.action === 'user.sign-in')[1]?.data,
    ).toMatchObject({ rehashed: false });
  });

  it('is refused while password sign-in is off', async () => {
    const s = setUp();
    s.settings.enabled = false;
    await expect(
      s.signIn.handle({ email: 'pat@example.org', password: GOOD }),
    ).rejects.toMatchObject({ code: 'password-sign-in-off' });
  });
});

describe('invites and reset links', () => {
  it('makes an invite valid a week, shown once and emailed; only IDs recorded', async () => {
    const s = setUp();
    const made = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    expect(made.token).toMatch(SIGN_IN_LINK_PATTERN);
    expect(made.url).toBe(
      `https://docs.example.com/set-password#${made.token}`,
    );
    expect(made.expiresAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(made.emailed).toBe(true);
    expect([...s.mailStore.rows.values()]).toMatchObject([
      { toAddress: 'pat@example.org', template: 'invite' },
    ]);
    // Only the hash is kept.
    expect(s.links.links.has(hashSignInLinkToken(made.token))).toBe(true);
    expect(JSON.stringify([...s.links.links.values()])).not.toContain(
      made.token,
    );
    const event = s.audit.events.find((e) => e.action === 'user.invite');
    expect(event?.subject).toEqual({ type: 'user', id: 'pat' });
    expect(JSON.stringify(event)).not.toContain(made.token);
    expect(JSON.stringify(event)).not.toContain(
      hashSignInLinkToken(made.token),
    );
  });

  it('copies the link only when email is off, or the person has no address', async () => {
    const s = setUp();
    s.mailSettings.state = 'off';
    const made = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    expect(made.emailed).toBe(false);
    expect(s.mailStore.rows.size).toBe(0);

    const t = setUp();
    t.mailSettings.publicUrl = null;
    t.settings.linkBase = null;
    const noUrl = await t.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    expect(noUrl).toMatchObject({ emailed: false, url: null });
  });

  it('an invite expires, and works once', async () => {
    const s = setUp();
    const first = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    expect(await s.readLink.handle({ token: first.token })).toMatchObject({
      kind: 'invite',
      name: 'Pat Example',
      email: 'pat@example.org',
    });
    const used = await s.setWithLink.handle({
      token: first.token,
      password: GOOD,
    });
    expect(used).toMatchObject({ userId: 'pat' });
    expect(s.passwords.hashes.get('pat')).toBe(`fake$1$${GOOD}`);
    expect(
      await s.setWithLink.handle({ token: first.token, password: OTHER }),
    ).toEqual({ refused: 'link-invalid' });
    expect(s.passwords.hashes.get('pat')).toBe(`fake$1$${GOOD}`);

    const second = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    s.advance(7 * 24 * 60 * 60 * 1000);
    expect(await s.readLink.handle({ token: second.token })).toEqual({
      refused: 'link-expired',
    });
    expect(
      await s.setWithLink.handle({ token: second.token, password: OTHER }),
    ).toEqual({ refused: 'link-expired' });
    expect(s.passwords.hashes.get('pat')).toBe(`fake$1$${GOOD}`);
  });

  it('a new link revokes the earlier one; a reset ends every other session', async () => {
    const s = setUp();
    await s.withPassword();
    const elsewhere = await s.sessionOf('pat');
    const another = await s.sessionOf('pat', 'oidc');
    const invite = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    const reset = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'reset',
    });
    expect(reset.expiresAt.getTime() - Date.parse('2026-11-20T10:00:00Z')).toBe(
      RESET_LINK_MS,
    );
    expect(await s.readLink.handle({ token: invite.token })).toEqual({
      refused: 'link-invalid',
    });
    // Making the link ends nothing yet.
    expect(s.running('pat')).toHaveLength(2);
    const outcome = await s.setWithLink.handle({
      token: reset.token,
      password: OTHER,
    });
    if (!('token' in outcome)) throw new Error('refused');
    const running = s.running('pat');
    expect(running.map((r) => r.hash)).toEqual([
      hashSessionToken(outcome.token),
    ]);
    expect(s.sessions.sessions.get(elsewhere.hash)?.revokedAt).not.toBeNull();
    expect(s.sessions.sessions.get(another.hash)?.revokedAt).not.toBeNull();
    expect(
      s.audit.events.find((e) => e.action === 'user.password-set')?.data,
    ).toEqual({ via: 'reset', sessionsEnded: 2 });
    expect(s.actions()).toContain('user.password-reset-requested');
  });

  it('setting a password through a link ends an open code by email (#645)', async () => {
    const s = setUp();
    const invite = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    const code = await s.openCode('pat');
    expect(await s.codeWorks('pat@example.org', code)).toBe(true);
    const outcome = await s.setWithLink.handle({
      token: invite.token,
      password: GOOD,
    });
    expect(outcome).toMatchObject({ userId: 'pat' });
    expect(await s.codeWorks('pat@example.org', code)).toBe(false);
  });

  it('holds the person before taking the link, as every change that ends ways in does (#650)', async () => {
    const s = setUp();
    const invite = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    const hold = vi.spyOn(s.codes, 'holdToEnd');
    const take = vi.spyOn(s.links, 'take');
    await s.setWithLink.handle({ token: invite.token, password: GOOD });
    expect(hold).toHaveBeenCalledWith(expect.anything(), 'pat');
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      take.mock.invocationCallOrder[0]!,
    );
  });

  it('checks the new password before using the link, which then still works', async () => {
    const s = setUp();
    const made = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    for (const [password, code] of [
      ['short', 'password-too-short'],
      ['password1234!', 'password-too-common'],
      ['x'.repeat(257), 'password-too-long'],
      ['pat@example.org', 'password-too-common'],
    ] as const) {
      await expect(
        s.setWithLink.handle({ token: made.token, password }),
      ).rejects.toMatchObject({ code });
    }
    expect(await s.readLink.handle({ token: made.token })).toMatchObject({
      kind: 'invite',
    });
  });

  it('refuses a deactivated person, an unknown one, and only admins make links', async () => {
    const s = setUp();
    await expect(
      s.makeLink.handle({ actor: root, userId: 'nobody', kind: 'invite' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const made = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    s.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    expect(await s.readLink.handle({ token: made.token })).toEqual({
      refused: 'link-invalid',
    });
    expect(
      await s.setWithLink.handle({ token: made.token, password: GOOD }),
    ).toEqual({ refused: 'link-invalid' });
    await expect(
      s.makeLink.handle({ actor: root, userId: 'pat', kind: 'reset' }),
    ).rejects.toMatchObject({ code: 'user-deactivated' });
    await expect(
      s.makeLink.handle({ actor: pat, userId: 'root', kind: 'reset' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('makes no link for someone without an email address to sign in with', async () => {
    const s = setUp();
    await expect(
      s.makeLink.handle({ actor: root, userId: 'root', kind: 'invite' }),
    ).rejects.toMatchObject({ code: 'no-email-address' });
    expect(s.links.links.size).toBe(0);
  });

  it('withdraws an open invite', async () => {
    const s = setUp();
    const made = await s.makeLink.handle({
      actor: root,
      userId: 'pat',
      kind: 'invite',
    });
    await s.withdraw.handle({ actor: root, userId: 'pat' });
    expect(await s.readLink.handle({ token: made.token })).toEqual({
      refused: 'link-invalid',
    });
    expect(s.actions()).toContain('user.invite-withdraw');
    await expect(
      s.withdraw.handle({ actor: root, userId: 'pat' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a malformed token without looking', async () => {
    const s = setUp();
    expect(await s.readLink.handle({ token: 'ccms_pwl_nope' })).toEqual({
      refused: 'link-invalid',
    });
  });
});

describe('ForgotPasswordAction', () => {
  it('emails a reset link to a known address, and answers nothing either way', async () => {
    const s = setUp();
    await s.withPassword();
    expect(await s.forgot.handle({ email: 'PAT@example.org' })).toBeUndefined();
    expect(
      await s.forgot.handle({ email: 'nobody@example.org' }),
    ).toBeUndefined();
    expect(await s.forgot.handle({ email: 'not an address' })).toBeUndefined();
    expect([...s.mailStore.rows.values()]).toMatchObject([
      { toAddress: 'pat@example.org', template: 'password-reset' },
    ]);
    expect([...s.links.links.values()]).toMatchObject([
      { userId: 'pat', kind: 'reset' },
    ]);
    const event = s.audit.events.find(
      (e) => e.action === 'user.password-reset-requested',
    );
    expect(event).toMatchObject({
      actor: { kind: 'service', id: 'service:sign-in' },
      subject: { type: 'user', id: 'pat' },
      data: { via: 'email' },
    });
  });

  it('sends at most one a minute, and nothing to a deactivated person', async () => {
    const s = setUp();
    await s.withPassword();
    await s.forgot.handle({ email: 'pat@example.org' });
    await s.forgot.handle({ email: 'pat@example.org' });
    expect(s.mailStore.rows.size).toBe(1);
    s.advance(60_000);
    await s.forgot.handle({ email: 'pat@example.org' });
    expect(s.mailStore.rows.size).toBe(2);
    // Only the latest link works.
    expect(s.links.links.size).toBe(1);

    const t = setUp();
    t.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    await t.forgot.handle({ email: 'pat@example.org' });
    expect(t.mailStore.rows.size).toBe(0);
  });

  it('sends nothing to a person without a password, nor replaces their invite', async () => {
    const s = setUp();
    await s.makeLink.handle({ actor: root, userId: 'pat', kind: 'invite' });
    const invite = [...s.links.links.values()];
    const mails = s.mailStore.rows.size;
    await s.forgot.handle({ email: 'pat@example.org' });
    expect([...s.links.links.values()]).toEqual(invite);
    expect(s.mailStore.rows.size).toBe(mails);
    expect(
      s.audit.events.some((e) => e.action === 'user.password-reset-requested'),
    ).toBe(false);
  });

  it('makes no link when single sign-on is required while it runs (#378)', async () => {
    const s = setUp();
    await s.withPassword();
    vi.spyOn(s.policy, 'requiresSingleSignOn').mockImplementation(
      async (tx?: unknown) => tx !== undefined,
    );
    await s.forgot.handle({ email: 'pat@example.org' });
    expect(s.links.links.size).toBe(0);
  });

  it('is not offered, and does nothing, with single sign-on required (#378)', async () => {
    const s = setUp();
    await s.withPassword();
    expect(await s.forgot.offered()).toBe(true);
    s.policy.required = true;
    expect(await s.forgot.offered()).toBe(false);
    await s.forgot.handle({ email: 'pat@example.org' });
    expect(s.audit.events).toEqual([]);
  });

  it('is not offered, and does nothing, while email cannot carry links', async () => {
    const s = setUp();
    s.mailSettings.publicUrl = null;
    expect(await s.forgot.offered()).toBe(false);
    await s.forgot.handle({ email: 'pat@example.org' });
    expect(s.links.links.size).toBe(0);
  });
});

describe('ChangePasswordAction', () => {
  it('checks the current password, sets the new one and ends the other sessions', async () => {
    const s = setUp();
    await s.withPassword();
    const current = await s.sessionOf('pat');
    const other = await s.sessionOf('pat');
    expect(
      await s.change.handle({
        actor: pat,
        currentPassword: OTHER,
        newPassword: OTHER,
        sessionHash: current.hash,
      }),
    ).toEqual({ refused: 'wrong-password' });
    expect(s.running('pat')).toHaveLength(2);
    await expect(
      s.change.handle({
        actor: pat,
        currentPassword: GOOD,
        newPassword: 'qwertyuiop123',
        sessionHash: current.hash,
      }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    expect(
      await s.change.handle({
        actor: pat,
        currentPassword: GOOD,
        newPassword: OTHER,
        sessionHash: current.hash,
      }),
    ).toEqual({ sessionsEnded: 1 });
    expect(s.passwords.hashes.get('pat')).toBe(`fake$1$${OTHER}`);
    expect(s.running('pat').map((r) => r.hash)).toEqual([current.hash]);
    expect(s.sessions.sessions.get(other.hash)?.revokedAt).not.toBeNull();
    expect(
      s.audit.events.find((e) => e.action === 'user.password-changed')?.data,
    ).toEqual({ sessionsEnded: 1 });
  });

  it('holds the person before their password, as setting one through a link does (#650)', async () => {
    const s = setUp();
    await s.withPassword();
    const hold = vi.spyOn(s.codes, 'holdToEnd');
    const replace = vi.spyOn(s.passwords, 'replaceIf');
    expect(
      await s.change.handle({
        actor: { kind: 'user', id: 'pat', roles: [] },
        currentPassword: GOOD,
        newPassword: OTHER,
      }),
    ).toEqual({ sessionsEnded: 0 });
    expect(hold).toHaveBeenCalledWith(expect.anything(), 'pat');
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0]!,
    );
  });

  it('ends an open code by email, which a wrong password leaves (#645)', async () => {
    const s = setUp();
    await s.withPassword();
    const code = await s.openCode('pat');
    await s.change.handle({
      actor: pat,
      currentPassword: OTHER,
      newPassword: OTHER,
    });
    expect(await s.codeWorks('pat@example.org', code)).toBe(true);
    await s.change.handle({
      actor: pat,
      currentPassword: GOOD,
      newPassword: OTHER,
    });
    expect(await s.codeWorks('pat@example.org', code)).toBe(false);
  });

  it('refuses someone without a password, and a service account', async () => {
    const s = setUp();
    await expect(
      s.change.handle({
        actor: pat,
        currentPassword: GOOD,
        newPassword: OTHER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      s.change.handle({
        actor: { kind: 'service', id: 'bot', roles: [] },
        currentPassword: GOOD,
        newPassword: OTHER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
