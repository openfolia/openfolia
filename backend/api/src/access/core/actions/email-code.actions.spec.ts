import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import {
  FakeEmailCodeHasher,
  FakeEmailCodes,
  FakeEmailCodeSignIn,
  FakePasswordAttempts,
} from '../../../../tests/fakes/fake-email-codes.js';
import { FakeSignInLinks } from '../../../../tests/fakes/fake-passwords.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import {
  FakeMailSettings,
  FakeMailStore,
} from '../../../../tests/fakes/fake-mail.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import {
  FakeSessionPolicy,
  FakeSessionStore,
  FakeUserIdentities,
} from '../../../../tests/fakes/fake-sign-in.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { ConflictError } from '../../../base/core/errors.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { mailParamsContext } from '../../../mail/core/mail-ports.js';
import {
  EMAIL_CODE_LINK_PATTERN,
  hashEmailCodeLink,
  readEmailCode,
} from '../email-codes.js';
import { hashSessionToken, mintSessionToken } from '../sessions.js';
import {
  codeAttemptKey,
  codeRequestKey,
  RequestEmailCodeAction,
  SignInWithEmailCodeAction,
  SignInWithEmailLinkAction,
} from './email-code.action.js';

const SEALER_ID = 1;

function setUp({ max = 3 } = {}) {
  let now = Date.parse('2026-11-21T10:00:00Z');
  const clock = () => now;
  const admin = new FakeAccessAdmin();
  admin.putUser({ id: 'pat', name: 'Pat Example', email: 'pat@example.org' });
  admin.putUser({ id: 'lee', name: 'Lee Example', email: 'lee@example.org' });
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const settings = new FakeEmailCodeSignIn();
  const hasher = new FakeEmailCodeHasher();
  const codes = new FakeEmailCodes(admin);
  codes.now = clock;
  const attempts = new FakePasswordAttempts(max);
  const identities = new FakeUserIdentities(admin);
  const links = new FakeSignInLinks();
  const sessions = new FakeSessionStore();
  sessions.now = clock;
  const policy = new FakeSessionPolicy();
  const mailSettings = new FakeMailSettings();
  const mailStore = new FakeMailStore();
  const sealer = fakeSealer(SEALER_ID);
  const mail = new MailOutbox(
    mailSettings,
    mailStore,
    sealer,
    new FakeJobQueue(),
  );

  const request = new RequestEmailCodeAction(
    settings,
    hasher,
    codes,
    attempts,
    identities,
    admin,
    mail,
    audit,
    unit,
  );
  request.now = clock;
  const signIn = new SignInWithEmailCodeAction(
    settings,
    hasher,
    codes,
    attempts,
    mail,
    sessions,
    policy,
    audit,
    unit,
    identities,
    links,
  );
  signIn.now = clock;
  const link = new SignInWithEmailLinkAction(
    settings,
    hasher,
    codes,
    mail,
    admin,
    sessions,
    policy,
    audit,
    unit,
    identities,
    links,
  );
  link.now = clock;

  /** Asks for a code for `email` and waits for it to be made and queued. */
  const ask = async (email: string, language?: string) => {
    const outcome = await request.handle({ email, language });
    if ('retryAfter' in outcome) return outcome;
    await outcome.sending;
    return outcome;
  };
  /** The params of the emails queued so far, opened. */
  const sent = () =>
    [...mailStore.rows.values()].map((row) => ({
      to: row.toAddress,
      template: row.template,
      language: row.language,
      params: JSON.parse(
        sealer.open(row.paramsSealed, mailParamsContext(row.id)),
      ) as { code: string; token: string; minutes: number },
    }));
  const lastCode = () => sent().at(-1)!.params;

  return {
    admin,
    identities,
    links,
    audit,
    settings,
    hasher,
    codes,
    attempts,
    sessions,
    policy,
    mailSettings,
    mailStore,
    request,
    signIn,
    link,
    ask,
    sent,
    lastCode,
    advance: (ms: number) => {
      now += ms;
    },
    actions: () => audit.events.map((e) => e.action),
  };
}

describe('readEmailCode', () => {
  it('reads six digits, with spaces or dashes between them, and nothing else', () => {
    expect(readEmailCode('123456')).toBe('123456');
    expect(readEmailCode(' 123 456 ')).toBe('123456');
    expect(readEmailCode('123-456')).toBe('123456');
    expect(readEmailCode('12345')).toBeNull();
    expect(readEmailCode('1234567')).toBeNull();
    expect(readEmailCode('12345a')).toBeNull();
    expect(readEmailCode('١٢٣٤٥٦')).toBeNull();
  });
});

describe('RequestEmailCodeAction', () => {
  it('emails a code and a link to a known address, stored only as hashes, and recorded', async () => {
    const s = setUp();
    await s.ask(' PAT@example.org ', 'de-AT');
    const [mail] = s.sent();
    expect(mail).toMatchObject({
      to: 'pat@example.org',
      template: 'email-code',
      language: 'de',
      params: { minutes: 10 },
    });
    expect(mail?.params.code).toMatch(/^[0-9]{6}$/);
    expect(mail?.params.token).toMatch(EMAIL_CODE_LINK_PATTERN);
    const stored = s.codes.codes.get('pat');
    expect(stored).toMatchObject({
      userId: 'pat',
      linkHash: hashEmailCodeLink(mail!.params.token),
      codeHash: s.hasher.hash('pat', mail!.params.code),
      expiresAt: new Date(Date.parse('2026-11-21T10:10:00Z')),
    });
    // Neither the code nor the link is stored or recorded.
    const kept = JSON.stringify([...s.codes.codes.values(), s.audit.events]);
    expect(kept).not.toContain(mail!.params.code);
    expect(kept).not.toContain(mail!.params.token);
    expect(s.audit.events).toMatchObject([
      {
        action: 'user.email-code-requested',
        actor: { kind: 'service', id: 'service:sign-in' },
        subject: { type: 'user', id: 'pat' },
        data: { emailed: true, expiresAt: '2026-11-21T10:10:00.000Z' },
      },
    ]);
  });

  it('answers the same for an unknown address, a malformed one and a deactivated person, and sends nothing', async () => {
    const s = setUp();
    s.admin.putUser({
      id: 'lee',
      name: 'Lee',
      email: 'lee@example.org',
      deactivatedAt: new Date(0),
    });
    const answers = [];
    for (const email of [
      'nobody@example.org',
      'not an address',
      'lee@example.org',
      'pat@example.org',
    ]) {
      const outcome = await s.request.handle({ email });
      expect(Object.keys(outcome)).toEqual(['sending']);
      answers.push(outcome);
      if ('sending' in outcome) await outcome.sending;
    }
    // Each counted toward its own address's requests, known or not.
    expect(s.attempts.counts.get(codeRequestKey('nobody@example.org'))).toBe(1);
    expect(s.attempts.counts.get(codeRequestKey('pat@example.org'))).toBe(1);
    expect(s.sent().map((m) => m.to)).toEqual(['pat@example.org']);
    expect(s.actions()).toEqual(['user.email-code-requested']);
  });

  it('stores the code for the address it mails, and mails nothing when that is no longer the person’s (#646)', async () => {
    const s = setUp();
    const replace = vi.spyOn(s.codes, 'replace');
    await s.ask('PAT@example.org');
    expect(replace).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'pat', sentTo: 'pat@example.org' }),
    );
    expect(s.sent()).toHaveLength(1);
    // The address changed between reading the person and storing the code: the store refuses
    // it, so nothing goes to the old address and nothing is recorded.
    replace.mockResolvedValueOnce(false);
    await s.ask('pat@example.org');
    expect(s.sent()).toHaveLength(1);
    expect(s.actions()).toEqual(['user.email-code-requested']);
  });

  it('holds the person before reading them, so a password set or change meanwhile ends the code (#650)', async () => {
    const s = setUp();
    const hold = vi.spyOn(s.codes, 'hold');
    const read = vi.spyOn(s.admin, 'findUser');
    const replace = vi.spyOn(s.codes, 'replace');
    await s.ask('PAT@example.org');
    expect(hold).toHaveBeenCalledWith(expect.anything(), 'pat');
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      read.mock.invocationCallOrder[0]!,
    );
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0]!,
    );
    // Nobody with the address: nobody to hold.
    await s.ask('nobody@example.org');
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('mails nothing when the address changed between finding the person and reading them (#650)', async () => {
    const s = setUp();
    const read = s.admin.findUser.bind(s.admin);
    vi.spyOn(s.admin, 'findUser').mockImplementationOnce(async (tx, id) => {
      const user = await read(tx, id);
      return user && { ...user, email: 'pat@new.example.org' };
    });
    const replace = vi.spyOn(s.codes, 'replace');
    await s.ask('pat@example.org');
    expect(replace).not.toHaveBeenCalled();
    expect(s.sent()).toEqual([]);
    expect(s.actions()).toEqual([]);
  });

  it('revokes the earlier code with a new one: the old code and link stop working', async () => {
    const s = setUp();
    await s.ask('pat@example.org');
    const first = s.lastCode();
    await s.ask('pat@example.org');
    const second = s.lastCode();
    expect(s.codes.codes.size).toBe(1);
    if (first.code !== second.code) {
      expect(
        await s.signIn.handle({ email: 'pat@example.org', code: first.code }),
      ).toEqual({ refused: 'invalid-code' });
    }
    expect(await s.link.handle({ token: first.token })).toEqual({
      refused: 'link-invalid',
    });
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code: second.code }),
    ).toMatchObject({ userId: 'pat' });
  });

  it('refuses past the address’s request budget, known or not, apart from its tries', async () => {
    const s = setUp({ max: 2 });
    for (const email of ['pat@example.org', 'nobody@example.org']) {
      expect(await s.ask(email)).toHaveProperty('sending');
      expect(await s.ask(email)).toHaveProperty('sending');
      expect(await s.ask(email)).toEqual({ retryAfter: 60 });
    }
    // Asking used up, the last code can still be tried.
    const { code } = s.lastCode();
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code }),
    ).toMatchObject({ userId: 'pat' });
  });

  it('is off while the settings say so, or email does not go out', async () => {
    const s = setUp();
    expect(s.request.offered).toBe(true);
    s.mailSettings.state = 'no-secret-key';
    expect(s.request.offered).toBe(false);
    await expect(
      s.request.handle({ email: 'pat@example.org' }),
    ).rejects.toThrow(ConflictError);
    const t = setUp();
    t.settings.enabled = false;
    expect(t.request.offered).toBe(false);
    await expect(
      t.signIn.handle({ email: 'pat@example.org', code: '123456' }),
    ).rejects.toMatchObject({ code: 'email-code-sign-in-off' });
    await expect(
      t.link.handle({ token: `ccms_ecl_${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'email-code-sign-in-off' });
  });
});

describe('SignInWithEmailCodeAction', () => {
  it('signs in with the right code: an email-code session, the previous one ended, recorded', async () => {
    const s = setUp();
    const linkable = () =>
      new FakeUnitOfWork().run((tx) => s.identities.hasAnyIdentity(tx, 'pat'));
    expect(await linkable()).toBe(false);
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const before = mintSessionToken();
    await new FakeUnitOfWork().run((tx) =>
      s.sessions.create(tx, {
        hash: before.hash,
        userId: 'lee',
        provider: 'password',
        endedBefore: new Date(0),
      }),
    );
    const outcome = await s.signIn.handle({
      email: 'Pat@Example.org',
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
      previousToken: before.token,
    });
    expect(outcome).toMatchObject({ userId: 'pat' });
    if (!('token' in outcome)) throw new Error('refused');
    expect(
      s.sessions.sessions.get(hashSessionToken(outcome.token)),
    ).toMatchObject({ userId: 'pat', provider: 'email-code' });
    expect(s.sessions.sessions.get(before.hash)?.revokedAt).not.toBeNull();
    // A way in of their own now: `pending` OIDC linking by email never takes the account.
    expect(await linkable()).toBe(true);
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'user.sign-in',
      actor: { kind: 'user', id: 'pat' },
      data: { method: 'email-code', provider: 'email-code', via: 'code' },
    });
    expect(JSON.stringify(s.audit.events)).not.toContain(outcome.token);
    // The right code is no failure.
    expect(s.attempts.counts.get(codeAttemptKey('pat@example.org'))).toBe(0);
  });

  it('closes the open invite of whoever signs in, by code or by its link (#373: the first admin)', async () => {
    for (const how of ['code', 'link'] as const) {
      const s = setUp();
      await new FakeUnitOfWork().run((tx) =>
        s.links.replace(tx, {
          hash: 'h1',
          userId: 'pat',
          kind: 'invite',
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );
      await s.ask('pat@example.org');
      const { code, token } = s.lastCode();
      const outcome =
        how === 'code'
          ? await s.signIn.handle({ email: 'pat@example.org', code })
          : await s.link.handle({ token });
      expect('token' in outcome).toBe(true);
      expect(s.links.links.size).toBe(0);
      expect(
        s.audit.events.find((e) => e.action === 'user.invite-withdraw'),
      ).toMatchObject({
        subject: { type: 'user', id: 'pat' },
        data: { via: 'sign-in' },
      });
    }
  });

  it('holds the person before taking the code and closing the invite, by code or by its link (#660)', async () => {
    for (const how of ['code', 'link'] as const) {
      const s = setUp();
      await s.ask('pat@example.org');
      const { code, token } = s.lastCode();
      const hold = vi.spyOn(s.codes, 'holdToEnd');
      const take = vi.spyOn(s.codes, 'take');
      const close = vi.spyOn(s.links, 'revokeAll');
      const outcome =
        how === 'code'
          ? await s.signIn.handle({ email: 'pat@example.org', code })
          : await s.link.handle({ token });
      expect('token' in outcome).toBe(true);
      expect(hold).toHaveBeenCalledWith(expect.anything(), 'pat');
      expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
        take.mock.invocationCallOrder[0]!,
      );
      expect(take.mock.invocationCallOrder[0]).toBeLessThan(
        close.mock.invocationCallOrder[0]!,
      );
    }
  });

  it('is single-use: the code, and its link, work once', async () => {
    const s = setUp();
    await s.ask('pat@example.org');
    const { code, token } = s.lastCode();
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code }),
    ).toMatchObject({ userId: 'pat' });
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
    expect(await s.link.handle({ token })).toEqual({ refused: 'link-invalid' });
  });

  it('expires after its minutes', async () => {
    const s = setUp();
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    s.advance(10 * 60_000);
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
    expect(s.sessions.sessions.size).toBe(0);
  });

  it('answers the same for an unknown address, no code, a malformed one and a wrong one, after the same work', async () => {
    const s = setUp({ max: 10 });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const wrong = code === '000001' ? '000002' : '000001';
    s.hasher.hashed = 0;
    s.codes.lookups = 0;
    const outcomes = [
      await s.signIn.handle({ email: 'nobody@example.org', code }),
      await s.signIn.handle({ email: 'lee@example.org', code }),
      await s.signIn.handle({ email: 'pat@example.org', code: 'abc' }),
      await s.signIn.handle({ email: 'pat@example.org', code: wrong }),
    ];
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ refused: 'invalid-code' });
    }
    // One lookup and one hash each, whatever the address.
    expect(s.codes.lookups).toBe(4);
    expect(s.hasher.hashed).toBe(4);
    expect(s.sessions.sessions.size).toBe(0);
    expect(s.actions()).toEqual(['user.email-code-requested']);
    // Each counted toward its address's tries.
    expect(s.attempts.counts.get(codeAttemptKey('nobody@example.org'))).toBe(1);
    expect(s.attempts.counts.get(codeAttemptKey('pat@example.org'))).toBe(2);
  });

  it('revokes the code once its tries are used up, and refuses until the window ends', async () => {
    const s = setUp({ max: 3 });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const wrong = code === '000001' ? '000002' : '000001';
    for (let i = 0; i < 2; i++) {
      expect(
        await s.signIn.handle({ email: 'pat@example.org', code: wrong }),
      ).toEqual({ refused: 'invalid-code' });
    }
    expect(s.codes.codes.has('pat')).toBe(true);
    // The last try the window allows: wrong, and the code goes with it.
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code: wrong }),
    ).toEqual({ refused: 'invalid-code' });
    expect(s.codes.codes.has('pat')).toBe(false);
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      retryAfter: 60,
    });
    // A window later, the right code of before does not work: it was revoked.
    s.attempts.counts.clear();
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
  });

  it('compares no more than five codes when twenty wrong ones come at once', async () => {
    const s = setUp({ max: Infinity });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const wrong = (i: number) =>
      String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0');
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.signIn.handle({ email: 'pat@example.org', code: wrong(i) }),
      ),
    );
    expect(outcomes.every((o) => 'refused' in o)).toBe(true);
    expect(s.codes.granted).toBe(5);
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
  });

  it('revokes the code after five wrong ones, even without an account budget', async () => {
    const s = setUp({ max: Infinity });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const wrong = code === '000001' ? '000002' : '000001';
    for (let i = 0; i < 5; i++) {
      await s.signIn.handle({ email: 'pat@example.org', code: wrong });
    }
    expect(s.codes.codes.has('pat')).toBe(false);
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
  });

  it('refuses a try past the budget without comparing, leaving the code for after the window', async () => {
    const s = setUp({ max: 1 });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    s.attempts.counts.set(codeAttemptKey('pat@example.org'), 1);
    s.codes.lookups = 0;
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      retryAfter: 60,
    });
    expect(s.codes.lookups).toBe(0);
    expect(s.codes.codes.has('pat')).toBe(true);
  });

  it('keeps its budgets apart from sign-in and reset, and from each other', async () => {
    const s = setUp({ max: 2 });
    // A password's budgets used up for the address.
    for (const key of [
      'sign-in:account:pat@example.org',
      'reset:account:pat@example.org',
    ]) {
      s.attempts.counts.set(key, 2);
    }
    await s.ask('pat@example.org');
    let { code } = s.lastCode();
    const wrong = code === '000001' ? '000002' : '000001';
    // Tries used up: asking still works, and the new code waits for the window, untouched by
    // the tries refused meanwhile.
    for (let i = 0; i < 2; i++) {
      await s.signIn.handle({ email: 'pat@example.org', code: wrong });
    }
    expect(await s.ask('pat@example.org')).toHaveProperty('sending');
    ({ code } = s.lastCode());
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      retryAfter: 60,
    });
    expect([...s.attempts.counts.keys()].sort()).toEqual([
      codeAttemptKey('pat@example.org'),
      codeRequestKey('pat@example.org'),
      'reset:account:pat@example.org',
      'sign-in:account:pat@example.org',
    ]);
    // The password's budgets were not touched.
    expect(s.attempts.counts.get('sign-in:account:pat@example.org')).toBe(2);
    expect(s.attempts.counts.get('reset:account:pat@example.org')).toBe(2);
    // The window over, the code asked for during it works.
    s.attempts.counts.delete(codeAttemptKey('pat@example.org'));
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code }),
    ).toMatchObject({ userId: 'pat' });
  });

  it('says a user is deactivated, or refused by the policy, only with the right code', async () => {
    const s = setUp({ max: 10 });
    await s.ask('pat@example.org');
    const { code } = s.lastCode();
    const wrong = code === '000001' ? '000002' : '000001';
    s.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    expect(
      await s.signIn.handle({ email: 'pat@example.org', code: wrong }),
    ).toEqual({ refused: 'invalid-code' });
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'user-deactivated',
    });
    s.admin.putUser({ id: 'pat', name: 'Pat', email: 'pat@example.org' });
    s.policy.refuse.add('pat');
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'sign-in-not-allowed',
    });
    expect(s.sessions.sessions.size).toBe(0);
  });
});

describe('SignInWithEmailLinkAction', () => {
  it('signs in with the link, once, and the code goes with it', async () => {
    const s = setUp();
    await s.ask('pat@example.org');
    const { code, token } = s.lastCode();
    const outcome = await s.link.handle({ token });
    expect(outcome).toMatchObject({ userId: 'pat' });
    if (!('token' in outcome)) throw new Error('refused');
    expect(
      s.sessions.sessions.get(hashSessionToken(outcome.token)),
    ).toMatchObject({ userId: 'pat', provider: 'email-code' });
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'user.sign-in',
      data: { method: 'email-code', via: 'link' },
    });
    expect(await s.link.handle({ token })).toEqual({ refused: 'link-invalid' });
    expect(await s.signIn.handle({ email: 'pat@example.org', code })).toEqual({
      refused: 'invalid-code',
    });
  });

  it('refuses a malformed, unknown, expired or deactivated person’s link', async () => {
    const s = setUp();
    expect(await s.link.handle({ token: 'ccms_ecl_nope' })).toEqual({
      refused: 'link-invalid',
    });
    expect(
      await s.link.handle({ token: `ccms_ecl_${'0'.repeat(64)}` }),
    ).toEqual({ refused: 'link-invalid' });
    await s.ask('pat@example.org');
    const { token } = s.lastCode();
    s.advance(10 * 60_000);
    expect(await s.link.handle({ token })).toEqual({ refused: 'link-expired' });

    const t = setUp();
    await t.ask('pat@example.org');
    t.admin.putUser({
      id: 'pat',
      name: 'Pat',
      email: 'pat@example.org',
      deactivatedAt: new Date(0),
    });
    expect(await t.link.handle({ token: t.lastCode().token })).toEqual({
      refused: 'link-invalid',
    });
  });
});
