import { Logger } from '@nestjs/common';
import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeEmailCodes } from '../../../../tests/fakes/fake-email-codes.js';
import {
  FakePasswordHasher,
  FakePasswordSignIn,
  FakePasswordStore,
  FakeSignInLinks,
} from '../../../../tests/fakes/fake-passwords.js';
import {
  FakePendingSignIns,
  FakeSecondFactorRule,
  FakeSecondFactors,
  sessionStart,
} from '../../../../tests/fakes/fake-second-factors.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import {
  FakeSessionPolicy,
  FakeSessionStore,
} from '../../../../tests/fakes/fake-sign-in.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import type { SecretSealer } from '../../../base/core/secret-sealer.js';
import type { RoleDefinition } from '../access-admin.js';
import type { Actor } from '../actor.js';
import { PASSWORD_PROVIDER } from '../passwords.js';
import {
  hashPendingSignIn,
  MAX_PENDING_SIGN_INS,
  PENDING_SIGN_IN_MS,
} from '../pending-sign-ins.js';
import { SecondFactorCodes } from '../second-factor-codes.js';
import { hashSessionToken, mintSessionToken } from '../sessions.js';
import { mintSignInLinkToken } from '../sign-in-links.js';
import { TOTP_STEP_MS, totpCode, totpStep } from '../totp.js';
import { WaysIn } from '../ways-in.js';
import { PasswordSignInAction } from './password-sign-in.action.js';
import {
  BeginSetUpAction,
  ConfirmSetUpAction,
  GetSecondFactorAction,
  NewRecoveryCodesAction,
  OwnPassword,
  ProvenChange,
  ResetSecondFactorAction,
  TurnOffSecondFactorAction,
} from './second-factor.action.js';
import {
  BeginRequiredSetUpAction,
  ConfirmRequiredSetUpAction,
  ReadSecondStepAction,
  SecondSteps,
  VerifySecondStepAction,
} from './second-factor-sign-in.action.js';
import { SetPasswordWithLinkAction } from './sign-in-links.action.js';

const adminRole: RoleDefinition = {
  id: 'admin',
  name: 'Admin',
  description: null,
  permissions: ['admin.roles'],
  scope: {},
};

const pat: Actor = { kind: 'user', id: 'pat', roles: [] };
const root: Actor = {
  kind: 'user',
  id: 'root',
  roles: [{ ...adminRole }],
};

const PASSWORD = 'a long and quiet river';
const START = Date.parse('2026-11-20T10:00:00Z');

function setUp(sealer: SecretSealer = fakeSealer(1)) {
  let now = START;
  const clock = () => now;
  const admin = new FakeAccessAdmin();
  admin.putRole(adminRole);
  admin.putUser({
    id: 'root',
    name: 'Root',
    email: 'root@example.org',
    roleIds: ['admin'],
  });
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
  const emailCodes = new FakeEmailCodes(admin);
  const factors = new FakeSecondFactors();
  const pending = new FakePendingSignIns();
  const rule = new FakeSecondFactorRule();
  const waysIn = new WaysIn(sessions, links, emailCodes, pending);
  const start = sessionStart({
    sessions,
    policy,
    admin,
    codes: emailCodes,
    factors,
    pending,
    rule,
  });
  const codes = new SecondFactorCodes(factors, sealer, waysIn, audit);
  const steps = new SecondSteps(
    pending,
    admin,
    policy,
    waysIn,
    start,
    audit,
    unit,
  );
  const own = new OwnPassword(settings, passwords, hasher);
  const change = new ProvenChange(factors, codes, own, waysIn, unit);
  const timed = <T extends { now: () => number }>(action: T): T =>
    Object.assign(action, { now: clock });
  timed(change);
  const signIn = timed(
    new PasswordSignInAction(
      settings,
      passwords,
      hasher,
      start,
      policy,
      admin,
      waysIn,
      audit,
      unit,
    ),
  );
  const actions = {
    get: new GetSecondFactorAction(factors, codes, own, start, unit),
    begin: timed(new BeginSetUpAction(codes, own, admin, waysIn, unit)),
    confirm: timed(new ConfirmSetUpAction(codes, waysIn, unit)),
    newCodes: new NewRecoveryCodesAction(change, codes, audit),
    turnOff: new TurnOffSecondFactorAction(change, factors, waysIn, audit),
    reset: new ResetSecondFactorAction(admin, factors, waysIn, audit, unit),
    read: timed(new ReadSecondStepAction(steps)),
    verify: timed(new VerifySecondStepAction(steps, codes)),
    beginStep: timed(new BeginRequiredSetUpAction(steps, codes)),
    confirmStep: timed(new ConfirmRequiredSetUpAction(steps, codes)),
    setWithLink: timed(
      new SetPasswordWithLinkAction(
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
      ),
    ),
  };

  const codeOf = (secret: string, steps = 0) =>
    totpCode(secret, totpStep(now) + steps);
  const later = (ms: number) => void (now += ms);
  const password = (value = PASSWORD) =>
    unit.run(async (tx) => passwords.set(tx, 'pat', await hasher.hash(value)));
  /** Pat's second factor, on: its secret and recovery codes; the code's step is used up. */
  const turnOn = async () => {
    const begun = await actions.begin.handle({
      actor: pat,
      provider: 'password',
      password: PASSWORD,
    });
    if ('refused' in begun) throw new Error(begun.refused);
    const on = await actions.confirm.handle({
      actor: pat,
      provider: 'password',
      code: codeOf(begun.secret),
    });
    if ('refused' in on) throw new Error(on.refused);
    later(TOTP_STEP_MS);
    return { secret: begun.secret, recoveryCodes: on.recoveryCodes };
  };
  const enter = (previousToken?: string) =>
    signIn.handle({
      email: 'pat@example.org',
      password: PASSWORD,
      ...(previousToken !== undefined && { previousToken }),
    });
  /** Pat's right password, answered with a second step. */
  const firstStep = async (step: 'verify' | 'set-up' = 'verify') => {
    const outcome = await enter();
    if (!('pendingToken' in outcome)) throw new Error('no second step');
    expect(outcome.secondStep).toBe(step);
    return outcome.pendingToken;
  };
  const sessionOf = async (userId: string, provider = PASSWORD_PROVIDER) => {
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
  const running = () =>
    [...sessions.sessions.values()].filter((s) => s.revokedAt === null);
  return {
    ...actions,
    admin,
    audit,
    unit,
    factors,
    pending,
    rule,
    policy,
    settings,
    sealer,
    hasher,
    passwords,
    links,
    waysIn,
    start,
    sessions,
    codeOf,
    later,
    password,
    turnOn,
    enter,
    firstStep,
    sessionOf,
    running,
    audited: () => audit.events.map((e) => e.action),
  };
}

const conflict = (code: string) => (error: unknown) =>
  error instanceof ConflictError && error.code === code;

const without = () => setUp(Object.assign(fakeSealer(1), { available: false }));

describe('a password changed while it is checked (#611)', () => {
  /** Pat's password changes as the check of the old one answers. */
  const changeWhileChecked = (s: ReturnType<typeof setUp>) => {
    const verify = s.hasher.verify.bind(s.hasher);
    s.hasher.verify = async (hash, password) => {
      const right = await verify(hash, password);
      s.hasher.verify = verify;
      await s.password('another long sentence');
      await s.unit.run((tx) => s.waysIn.endAll(tx, 'pat'));
      return right;
    };
  };

  it('signs nobody in, and opens no second step', async () => {
    const s = setUp();
    await s.password();
    changeWhileChecked(s);
    expect(await s.enter()).toEqual({ refused: 'invalid-credentials' });
    expect(s.running()).toEqual([]);
    s.rule.rule = 'everyone';
    await s.password();
    changeWhileChecked(s);
    expect(await s.enter()).toEqual({ refused: 'invalid-credentials' });
    expect(s.pending.open.size).toBe(0);
  });

  it('signs nobody in who was deactivated meanwhile', async () => {
    const s = setUp();
    await s.password();
    const verify = s.hasher.verify.bind(s.hasher);
    s.hasher.verify = async (hash, password) => {
      await s.unit.run((tx) => s.admin.setDeactivated(tx, 'pat', true));
      return verify(hash, password);
    };
    expect(await s.enter()).toEqual({ refused: 'user-deactivated' });
    expect(s.running()).toEqual([]);
  });

  it('proves nothing: no set-up, no new codes, not turned off', async () => {
    const s = setUp();
    await s.password();
    const own = { actor: pat, provider: 'password', password: PASSWORD };
    changeWhileChecked(s);
    expect(await s.begin.handle(own)).toEqual({ refused: 'wrong-password' });
    await s.password();
    await s.turnOn();
    changeWhileChecked(s);
    expect(await s.newCodes.handle(own)).toEqual({ refused: 'wrong-password' });
    await s.password();
    changeWhileChecked(s);
    expect(await s.turnOff.handle(own)).toEqual({ refused: 'wrong-password' });
    expect(s.audited()).not.toContain('user.second-factor-off');
  });
});

describe('with password sign-in off (#611)', () => {
  it('neither asks for a stored password nor takes it as a proof', async () => {
    const s = setUp();
    await s.password();
    s.settings.enabled = false;
    const own = { actor: pat, provider: 'email-code' };
    expect(await s.get.handle(own)).toMatchObject({ hasPassword: false });
    const { secret } = await s.turnOn();
    expect(await s.turnOff.handle({ ...own, password: PASSWORD })).toEqual({
      refused: 'wrong-password',
    });
    expect(await s.turnOff.handle({ ...own, code: s.codeOf(secret) })).toEqual({
      off: true,
    });
  });
});

describe('a stored secret that cannot be opened (#611)', () => {
  it('refuses the code by name, logged once with the ID alone; a recovery code still signs in', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const s = setUp();
    await s.password();
    const { secret, recoveryCodes } = await s.turnOn();
    const token = await s.firstStep();
    s.sealer.open = () => {
      throw new Error('damaged v1.sealed');
    };
    for (let i = 0; i < 2; i++) {
      await expect(
        s.verify.handle({ token, code: s.codeOf(secret) }),
      ).rejects.toSatisfy(conflict('second-factor-unavailable'));
    }
    expect(logged.mock.calls).toEqual([
      [
        'The second factor of user "pat" cannot be opened with the instance secret key: their codes are refused until it is reset.',
      ],
    ]);
    logged.mockRestore();
    expect(
      await s.verify.handle({ token, code: recoveryCodes[0] ?? '' }),
    ).toMatchObject({ userId: 'pat' });
  });
});

describe('setting up a second factor (#611)', () => {
  it('seals the secret, and counts for nothing until a code of it confirms', async () => {
    const s = setUp();
    await s.password();
    const begun = await s.begin.handle({
      actor: pat,
      provider: 'password',
      password: PASSWORD,
    });
    if ('refused' in begun) throw new Error(begun.refused);
    expect(begun.account).toBe('pat@example.org');
    const stored = s.factors.factors.get('pat');
    expect(stored?.sealedSecret).toBe(
      fakeSealer(1).seal(begun.secret, 'second-factor:v1:pat'),
    );
    // Not on: signing in still takes the password alone.
    expect(await s.enter()).toHaveProperty('token');
    expect(
      await s.confirm.handle({
        actor: pat,
        provider: 'password',
        code: '000000',
      }),
    ).toEqual({ refused: 'wrong-code' });
    expect(stored?.confirmedAt).toBeNull();

    const on = await s.confirm.handle({
      actor: pat,
      provider: 'password',
      code: s.codeOf(begun.secret),
    });
    if ('refused' in on) throw new Error(on.refused);
    expect(on.recoveryCodes).toHaveLength(10);
    expect(await s.enter()).toMatchObject({ secondStep: 'verify' });
    expect(
      await s.get.handle({ actor: pat, provider: 'password' }),
    ).toMatchObject({
      on: true,
      recoveryCodesLeft: 10,
      required: false,
      hasPassword: true,
    });
  });

  it('ends every other session, and the request’s own goes on', async () => {
    const s = setUp();
    await s.password();
    const own = await s.sessionOf('pat');
    await s.sessionOf('pat');
    await s.sessionOf('pat', 'oidc');
    await s.sessionOf('root');
    const begun = await s.begin.handle({
      actor: pat,
      provider: 'password',
      password: PASSWORD,
    });
    if ('refused' in begun) throw new Error(begun.refused);
    expect(
      await s.confirm.handle({
        actor: pat,
        provider: 'password',
        code: s.codeOf(begun.secret),
        sessionHash: own.hash,
      }),
    ).toMatchObject({ sessionsEnded: 2 });
    expect(s.running().map((session) => session.userId)).toEqual([
      'pat',
      'root',
    ]);
    expect(s.sessions.sessions.get(own.hash)?.revokedAt).toBeNull();
  });

  it('takes the password again, when there is one', async () => {
    const s = setUp();
    const begin = (password?: string) =>
      s.begin.handle({ actor: pat, provider: 'email-code', password });
    // None: a code by email is how they sign in.
    expect(await begin()).toHaveProperty('secret');
    await s.password();
    expect(await begin()).toEqual({ refused: 'wrong-password' });
    expect(await begin('not it')).toEqual({ refused: 'wrong-password' });
    expect(await begin(PASSWORD)).toHaveProperty('secret');
  });

  it('runs out after ten minutes, and is begun again', async () => {
    const s = setUp();
    const begin = async () => {
      const begun = await s.begin.handle({
        actor: pat,
        provider: 'email-code',
      });
      if ('refused' in begun) throw new Error(begun.refused);
      return begun.secret;
    };
    const confirm = (code: string) =>
      s.confirm.handle({ actor: pat, provider: 'email-code', code });
    await expect(confirm('123456')).rejects.toSatisfy(
      conflict('second-factor-not-begun'),
    );
    const first = await begin();
    s.later(10 * 60_000);
    await expect(confirm(s.codeOf(first))).rejects.toSatisfy(
      conflict('second-factor-not-begun'),
    );
    const second = await begin();
    // The one before it is gone.
    expect(await confirm(s.codeOf(first))).toEqual({ refused: 'wrong-code' });
    expect(await confirm(s.codeOf(second))).toHaveProperty('recoveryCodes');
    await expect(begin()).rejects.toSatisfy(conflict('second-factor-on'));
    await expect(confirm(s.codeOf(second, 1))).rejects.toSatisfy(
      conflict('second-factor-on'),
    );
  });

  it('is for a person whose session began here, and needs the secret key', async () => {
    const s = setUp();
    const service: Actor = { kind: 'service', id: 'bot', roles: [] };
    for (const provider of ['oidc', 'saml', undefined]) {
      await expect(s.get.handle({ actor: pat, provider })).rejects.toSatisfy(
        conflict('second-factor-not-applicable'),
      );
      await expect(s.begin.handle({ actor: pat, provider })).rejects.toSatisfy(
        conflict('second-factor-not-applicable'),
      );
    }
    await expect(
      s.begin.handle({ actor: service, provider: 'password' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      without().begin.handle({ actor: pat, provider: 'email-code' }),
    ).rejects.toSatisfy(conflict('second-factor-unavailable'));
  });
});

describe('the second step of a sign-in (#611)', () => {
  it('stands between the password and any session, and is used once', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const before = s.running().length;
    const token = await s.firstStep();
    expect(s.running()).toHaveLength(before);
    expect(s.audited()).not.toContain('user.sign-in');
    expect(s.pending.open.has(hashPendingSignIn(token))).toBe(true);
    expect([...s.pending.open.keys()].join()).not.toContain(token);

    const previous = await s.sessionOf('pat');
    const done = await s.verify.handle({
      token,
      code: s.codeOf(secret),
      previousToken: previous.token,
    });
    if ('refused' in done) throw new Error(done.refused);
    const session = s.sessions.sessions.get(hashSessionToken(done.token));
    expect(session).toMatchObject({ userId: 'pat', provider: 'password' });
    expect(s.sessions.sessions.get(previous.hash)?.revokedAt).not.toBeNull();
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'user.sign-in',
      data: { method: 'password', provider: 'password', secondFactor: 'totp' },
    });

    s.later(TOTP_STEP_MS);
    expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual({
      refused: 'second-step-expired',
    });
  });

  it('takes one of the two sent at once with one token', async () => {
    const s = setUp();
    await s.password();
    const { recoveryCodes } = await s.turnOn();
    const token = await s.firstStep();
    const outcomes = await Promise.all([
      s.verify.handle({ token, code: recoveryCodes[0]! }),
      s.verify.handle({ token, code: recoveryCodes[1]! }),
    ]);
    expect(outcomes.filter((o) => 'token' in o)).toHaveLength(1);
  });

  it('is bound to its token, its kind and ten minutes', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const token = await s.firstStep();
    const expired = { refused: 'second-step-expired' };
    for (const other of [
      undefined,
      '',
      'x',
      `${token}0`,
      token.slice(0, -1),
      `ccms_2fa_${'0'.repeat(64)}`,
      hashPendingSignIn(token),
    ]) {
      expect(
        await s.verify.handle({ token: other, code: s.codeOf(secret) }),
      ).toEqual(expired);
      expect(await s.read.handle({ token: other })).toEqual(expired);
    }
    // A step to verify is no step to set up.
    expect(await s.beginStep.handle({ token })).toEqual(expired);
    expect(
      await s.confirmStep.handle({ token, code: s.codeOf(secret) }),
    ).toEqual(expired);
    expect(await s.read.handle({ token })).toMatchObject({
      step: 'verify',
      email: 'pat@example.org',
    });
    s.later(PENDING_SIGN_IN_MS);
    expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual(
      expired,
    );
  });

  it('accepts a code once, whichever sign-in it was used for', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const code = s.codeOf(secret);
    const first = await s.firstStep();
    const second = await s.firstStep();
    expect(await s.verify.handle({ token: first, code })).toHaveProperty(
      'token',
    );
    const wrong = { refused: 'wrong-code' };
    expect(await s.verify.handle({ token: second, code })).toEqual(wrong);
    // Nor an earlier one still inside the window.
    expect(
      await s.verify.handle({ token: second, code: s.codeOf(secret, -1) }),
    ).toEqual(wrong);
    // The wrong ones left the step open.
    expect(
      await s.verify.handle({ token: second, code: s.codeOf(secret, 1) }),
    ).toHaveProperty('token');
  });

  it('does not accept the code that turned it on', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    // `turnOn` moved one step on: the code before is still inside the window.
    const token = await s.firstStep();
    expect(
      await s.verify.handle({ token, code: s.codeOf(secret, -1) }),
    ).toEqual({ refused: 'wrong-code' });
  });

  it('accepts a recovery code once', async () => {
    const s = setUp();
    await s.password();
    const { recoveryCodes } = await s.turnOn();
    const code = recoveryCodes[3]!;
    expect(
      await s.verify.handle({
        token: await s.firstStep(),
        code: code.toUpperCase().replaceAll('-', ' '),
      }),
    ).toHaveProperty('token');
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      secondFactor: 'recovery-code',
    });
    expect(await s.verify.handle({ token: await s.firstStep(), code })).toEqual(
      { refused: 'wrong-code' },
    );
    expect(
      (await s.get.handle({ actor: pat, provider: 'password' }))
        .recoveryCodesLeft,
    ).toBe(9);
  });

  it('refuses someone deactivated, or whom the policy refuses, meanwhile', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const token = await s.firstStep();
    s.policy.refuse.add('pat');
    expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual({
      refused: 'sign-in-not-allowed',
    });
    s.policy.refuse.clear();
    s.admin.putUser({
      id: 'pat',
      name: 'Pat Example',
      email: 'pat@example.org',
      deactivatedAt: new Date(START),
    });
    expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual({
      refused: 'user-deactivated',
    });
    expect(await s.read.handle({ token })).toEqual({
      refused: 'user-deactivated',
    });
  });

  it('ends with every change of the person’s ways in', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    for (const end of ['endAll', 'endMailed', 'endOpenSteps'] as const) {
      const token = await s.firstStep();
      await s.unit.run(async (tx) => void (await s.waysIn[end](tx, 'pat')));
      expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual({
        refused: 'second-step-expired',
      });
    }
  });

  it('keeps a bounded number open per person, the newest', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const first = await s.firstStep();
    let last = first;
    for (let i = 0; i < MAX_PENDING_SIGN_INS; i++) last = await s.firstStep();
    expect(s.pending.open.size).toBe(MAX_PENDING_SIGN_INS);
    expect(
      await s.verify.handle({ token: first, code: s.codeOf(secret) }),
    ).toEqual({ refused: 'second-step-expired' });
    expect(
      await s.verify.handle({ token: last, code: s.codeOf(secret) }),
    ).toHaveProperty('token');
  });

  it('is asked for after a reset link too, which starts no session of its own', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const stale = await s.firstStep();
    const link = mintSignInLinkToken();
    await s.unit.run((tx) =>
      s.links.replace(tx, {
        hash: link.hash,
        userId: 'pat',
        kind: 'reset',
        expiresAt: new Date(START + 3_600_000),
      }),
    );
    const set = await s.setWithLink.handle({
      token: link.token,
      password: 'another long sentence',
    });
    if (!('pendingToken' in set)) throw new Error('a session without a code');
    expect(s.running()).toEqual([]);
    expect(s.audited()).not.toContain('user.sign-in');
    // The step begun with the old password is gone; the factor is not.
    expect(
      await s.verify.handle({ token: stale, code: s.codeOf(secret) }),
    ).toEqual({ refused: 'second-step-expired' });
    expect(
      await s.verify.handle({
        token: set.pendingToken,
        code: s.codeOf(secret),
      }),
    ).toHaveProperty('token');
  });

  it('never asks a provider’s sign-in', async () => {
    const s = setUp();
    await s.password();
    await s.turnOn();
    s.rule.rule = 'everyone';
    const started = await s.unit.run((tx) =>
      s.start.begin(tx, {
        userId: 'pat',
        provider: 'oidc',
        held: {},
        now: START,
      }),
    );
    expect(started).toHaveProperty('token');
  });

  it('goes no further without the secret key', async () => {
    const s = without();
    await s.password();
    await s.unit.run(async (tx) => {
      await s.factors.begin(tx, 'pat', 'sealed', new Date(START));
      await s.factors.confirm(tx, 'pat', 'sealed', new Date(START), 1, []);
    });
    const token = await s.firstStep();
    await expect(s.verify.handle({ token, code: '123456' })).rejects.toSatisfy(
      conflict('second-factor-unavailable'),
    );
  });
});

describe('a required second factor (#611)', () => {
  it('asks everyone, or the admins alone, at their next sign-in', async () => {
    const s = setUp();
    await s.password();
    const started = (userId: string) =>
      s.unit.run((tx) =>
        s.start.begin(tx, {
          userId,
          provider: 'email-code',
          held: {},
          now: START,
        }),
      );
    expect(await started('pat')).toHaveProperty('token');
    expect(await started('root')).toHaveProperty('token');
    s.rule.rule = 'admins';
    expect(await started('pat')).toHaveProperty('token');
    expect(await started('root')).toMatchObject({ secondStep: 'set-up' });
    s.rule.rule = 'everyone';
    expect(await started('pat')).toMatchObject({ secondStep: 'set-up' });
    expect(
      await s.get.handle({ actor: pat, provider: 'password' }),
    ).toMatchObject({ on: false, required: true });
  });

  it('is set up before there is any session, which starts with it', async () => {
    const s = setUp();
    await s.password();
    const earlier = await s.sessionOf('pat');
    s.rule.rule = 'everyone';
    const token = await s.firstStep('set-up');
    // A code of nothing: no way round the set-up.
    expect(await s.verify.handle({ token, code: '123456' })).toEqual({
      refused: 'second-step-expired',
    });
    await expect(
      s.confirmStep.handle({ token, code: '123456' }),
    ).rejects.toSatisfy(conflict('second-factor-not-begun'));
    const begun = await s.beginStep.handle({ token });
    if ('refused' in begun) throw new Error(begun.refused);
    expect(await s.confirmStep.handle({ token, code: '000000' })).toEqual({
      refused: 'wrong-code',
    });
    expect(s.audited()).toEqual([]);
    const done = await s.confirmStep.handle({
      token,
      code: s.codeOf(begun.secret),
    });
    if ('refused' in done) throw new Error(done.refused);
    expect(done.recoveryCodes).toHaveLength(10);
    expect(s.running().map((session) => session.hash)).toEqual([
      hashSessionToken(done.token),
    ]);
    expect(s.sessions.sessions.get(earlier.hash)?.revokedAt).not.toBeNull();
    expect(s.audited()).toEqual(['user.second-factor-on', 'user.sign-in']);
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      secondFactor: 'set-up',
    });
    s.later(TOTP_STEP_MS);
    expect(
      await s.confirmStep.handle({ token, code: s.codeOf(begun.secret) }),
    ).toEqual({ refused: 'second-step-expired' });
  });

  it('turned on meanwhile, ends the other sign-ins that were to set it up', async () => {
    const s = setUp();
    await s.password();
    s.rule.rule = 'everyone';
    const one = await s.firstStep('set-up');
    const other = await s.firstStep('set-up');
    const begun = await s.beginStep.handle({ token: one });
    if ('refused' in begun) throw new Error(begun.refused);
    await s.confirmStep.handle({ token: one, code: s.codeOf(begun.secret) });
    expect(await s.beginStep.handle({ token: other })).toEqual({
      refused: 'second-step-expired',
    });
  });
});

describe('changing a second factor (#611)', () => {
  it('takes the password or a current code again, for either change', async () => {
    const s = setUp();
    await s.password();
    const { secret, recoveryCodes } = await s.turnOn();
    const own = { actor: pat, provider: 'password' };
    for (const change of [s.newCodes, s.turnOff]) {
      expect(await change.handle(own)).toEqual({ refused: 'wrong-code' });
      expect(await change.handle({ ...own, code: '000000' })).toEqual({
        refused: 'wrong-code',
      });
      expect(await change.handle({ ...own, password: 'not it' })).toEqual({
        refused: 'wrong-password',
      });
    }
    expect(s.audited()).toEqual(['user.second-factor-on']);
    const made = await s.newCodes.handle({ ...own, code: s.codeOf(secret) });
    if ('refused' in made) throw new Error(made.refused);
    // The code is used up, and the earlier recovery codes are gone.
    expect(await s.turnOff.handle({ ...own, code: s.codeOf(secret) })).toEqual({
      refused: 'wrong-code',
    });
    expect(await s.turnOff.handle({ ...own, code: recoveryCodes[0] })).toEqual({
      refused: 'wrong-code',
    });
    expect(
      await s.newCodes.handle({ ...own, password: PASSWORD }),
    ).toHaveProperty('recoveryCodes');
  });

  it('turned off, the password alone signs in, and open steps end', async () => {
    const s = setUp();
    await s.password();
    const { secret } = await s.turnOn();
    const token = await s.firstStep();
    const own = { actor: pat, provider: 'password' };
    expect(await s.turnOff.handle({ ...own, password: PASSWORD })).toEqual({
      off: true,
    });
    expect(s.factors.factors.size).toBe(0);
    expect(await s.verify.handle({ token, code: s.codeOf(secret) })).toEqual({
      refused: 'second-step-expired',
    });
    expect(await s.enter()).toHaveProperty('token');
    expect(s.audited().at(-2)).toBe('user.second-factor-off');
    for (const change of [s.newCodes, s.turnOff]) {
      await expect(
        change.handle({ ...own, password: PASSWORD }),
      ).rejects.toSatisfy(conflict('second-factor-off'));
    }
  });

  it('turned off where it is required, is set up again at the next sign-in', async () => {
    const s = setUp();
    await s.password();
    await s.turnOn();
    s.rule.rule = 'everyone';
    await s.turnOff.handle({
      actor: pat,
      provider: 'password',
      password: PASSWORD,
    });
    await s.firstStep('set-up');
  });

  it('is reset by an admin for another person, audited, and never one’s own', async () => {
    const s = setUp();
    await s.password();
    await s.turnOn();
    const token = await s.firstStep();
    await expect(
      s.reset.handle({ actor: pat, userId: 'root' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.reset.handle({ actor: root, userId: 'root' }),
    ).rejects.toSatisfy(conflict('second-factor-own'));
    await expect(
      s.reset.handle({ actor: root, userId: 'nobody' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await s.reset.handle({ actor: root, userId: 'pat' });
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'user.second-factor-reset',
      actor: { id: 'root' },
      subject: { type: 'user', id: 'pat' },
    });
    expect(await s.read.handle({ token })).toEqual({
      refused: 'second-step-expired',
    });
    expect(await s.enter()).toHaveProperty('token');
    await expect(
      s.reset.handle({ actor: root, userId: 'pat' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaves no secret, code or token in the audit log', async () => {
    const s = setUp();
    await s.password();
    const { secret, recoveryCodes } = await s.turnOn();
    const code = s.codeOf(secret);
    const token = await s.firstStep();
    await s.verify.handle({ token, code });
    const made = await s.newCodes.handle({
      actor: pat,
      provider: 'password',
      password: PASSWORD,
    });
    if ('refused' in made) throw new Error(made.refused);
    await s.reset.handle({ actor: root, userId: 'pat' });
    const log = JSON.stringify(s.audit.events);
    for (const kept of [
      secret,
      code,
      token,
      PASSWORD,
      ...recoveryCodes,
      ...made.recoveryCodes,
    ]) {
      expect(log).not.toContain(kept);
    }
  });
});
