import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAccessAdmin } from '../../../../tests/fakes/fake-access-admin.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeInstallationSettingsStore } from '../../../../tests/fakes/fake-installation-settings-store.js';
import { FakeSecondFactors } from '../../../../tests/fakes/fake-second-factors.js';
import {
  FakeIdentityProvider,
  FakeRefusedSignIns,
  FakeSignInEvents,
  FakeSignInRules,
  FakeSignInSetup,
} from '../../../../tests/fakes/fake-sign-in.js';
import { StaticIdentityProviders } from '../../../access/core/identity-provider.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { SecretSealer } from '../../../base/core/secret-sealer.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import { allowsSelf } from '../../../change-sets/core/self-approval.js';
import { EndRefusedSignIns } from '../../../access/core/refused-sign-ins.js';
import { SignInStates } from '../sign-in-state.js';
import { StoredSecondFactorRule } from '../stored-second-factor-rule.js';
import { StoredSelfApprovalRule } from '../stored-self-approval-rule.js';
import { GetInstallationSettingsAction } from './get-installation-settings.action.js';
import { UpdateInstallationSettingsAction } from './update-installation-settings.action.js';

const admin = { ...actorWith(['admin.roles']), id: 'admin' };
const reviewer = {
  ...actorWith(['content.read', 'content.review', 'admin.branding']),
  id: 'reviewer',
};

function setup(sealer: SecretSealer = fakeSealer(1)) {
  const store = new FakeInstallationSettingsStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const factors = new FakeSecondFactors();
  const rules = new FakeSignInRules();
  const signInSetup = new FakeSignInSetup();
  const states = new SignInStates(rules, signInSetup);
  const refused = new FakeRefusedSignIns();
  const provider = new FakeIdentityProvider();
  const access = new FakeAccessAdmin();
  access.putRole({
    id: 'admin',
    name: 'Admin',
    description: null,
    permissions: ['admin.roles'],
    scope: {},
  });
  access.putUser({
    id: 'admin',
    name: 'Admin',
    email: null,
    roleIds: ['admin'],
  });
  const events = new FakeSignInEvents();
  // The rule as stored, as the adapter reads it.
  rules.read = async () => {
    const { settings } = store.stored;
    return {
      ...settings,
      breakGlass:
        settings.breakGlassUserId === null
          ? null
          : { userId: settings.breakGlassUserId, problem: null },
    };
  };
  return {
    rules,
    refused,
    provider,
    access,
    events,
    unit,
    factors,
    secondFactorRule: new StoredSecondFactorRule(store),
    store,
    audit,
    get: new GetInstallationSettingsAction(store, states),
    update: new UpdateInstallationSettingsAction(
      store,
      audit,
      unit,
      factors,
      sealer,
      states,
      rules,
      signInSetup,
      new StaticIdentityProviders([provider]),
      new EndRefusedSignIns(rules, signInSetup, refused, audit, unit),
      refused,
      access,
      events,
    ),
    rule: new StoredSelfApprovalRule(store),
  };
}

describe('GetInstallationSettingsAction', () => {
  it('answers four eyes before any change', async () => {
    const { get } = setup();
    expect(await get.handle({ actor: admin })).toEqual({
      settings: {
        selfApproval: 'never',
        secondFactor: 'optional',
        singleSignOn: 'optional',
        breakGlassUserId: null,
        sessionIdleMinutes: null,
        sessionMaxHours: null,
      },
      version: 0,
      updatedAt: null,
      signIn: {
        singleSignOnAvailable: true,
        breakGlassProblem: null,
        serverSessionIdleMinutes: 480,
        serverSessionMaxHours: 168,
      },
    });
  });

  it('needs admin.roles', async () => {
    const { get } = setup();
    await expect(get.handle({ actor: reviewer })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('UpdateInstallationSettingsAction', () => {
  it('changes the self-approval rule and audits it, from and to', async () => {
    const { update, audit, rule } = setup();
    const written = await update.handle({
      actor: admin,
      changes: { selfApproval: 'review' },
    });
    expect(written.settings.selfApproval).toBe('review');
    expect(written.version).toBe(1);
    expect(await rule.read()).toBe('review');
    expect(audit.events).toMatchObject([
      {
        action: 'settings.self-approval',
        subject: { type: 'settings', id: 'installation' },
        actor: { kind: 'user', id: 'admin' },
        data: { from: 'never', to: 'review' },
      },
    ]);
  });

  it('records nothing when nothing changes', async () => {
    const { update, audit, store } = setup();
    await update.handle({ actor: admin, changes: { selfApproval: 'never' } });
    await update.handle({ actor: admin, changes: {} });
    expect(audit.events).toEqual([]);
    expect(store.stored.version).toBe(0);
    expect(store.locks).toBe(2);
  });

  it('refuses anyone without admin.roles, writing nothing', async () => {
    const { update, audit, store } = setup();
    await expect(
      update.handle({
        actor: reviewer,
        changes: { selfApproval: 'review-and-sign-off' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(audit.events).toEqual([]);
    expect(store.locks).toBe(0);
    expect(store.stored.settings.selfApproval).toBe('never');
  });
});

describe('requiring a second factor (#611)', () => {
  const changes = { secondFactor: 'everyone' } as const;
  const code = (error: unknown) => (error as ConflictError).code;

  it('changes the rule and audits it, from and to, leaving the other settings', async () => {
    const { update, audit, secondFactorRule, store } = setup();
    await update.handle({ actor: admin, changes });
    expect(await secondFactorRule.read()).toBe('everyone');
    expect(store.stored.settings.selfApproval).toBe('never');
    expect(audit.events).toMatchObject([
      {
        action: 'settings.second-factor',
        data: { from: 'optional', to: 'everyone' },
      },
    ]);
    await update.handle({ actor: admin, changes: { secondFactor: 'admins' } });
    await update.handle({
      actor: admin,
      changes: { secondFactor: 'optional' },
    });
    expect(await secondFactorRule.read()).toBe('optional');
  });

  it('locks nobody out: needs the secret key', async () => {
    const { update, store } = setup(
      Object.assign(fakeSealer(1), { available: false }),
    );
    await expect(update.handle({ actor: admin, changes })).rejects.toSatisfy(
      (error) => code(error) === 'second-factor-unavailable',
    );
    expect(store.stored.version).toBe(0);
    // Back to a choice is always allowed.
    await update.handle({
      actor: admin,
      changes: { secondFactor: 'optional' },
    });
  });

  it.each(['password', 'email-code'])(
    'locks nobody out: an admin whose session began with %s has theirs on first',
    async (provider) => {
      const { update, store, factors, unit } = setup();
      const ask = () => update.handle({ actor: admin, provider, changes });
      const refused = (error: unknown) =>
        code(error) === 'second-factor-own-first';
      await expect(ask()).rejects.toSatisfy(refused);
      // Begun is not on.
      await unit.run((tx) => factors.begin(tx, 'admin', 'sealed', new Date()));
      await expect(ask()).rejects.toSatisfy(refused);
      expect(store.stored.version).toBe(0);
      await unit.run((tx) =>
        factors.confirm(tx, 'admin', 'sealed', new Date(), 1, []),
      );
      expect((await ask()).settings.secondFactor).toBe('everyone');
    },
  );

  it('asks nothing of an admin who signs in with a provider', async () => {
    const { update } = setup();
    const written = await update.handle({
      actor: admin,
      provider: 'oidc',
      changes,
    });
    expect(written.settings.secondFactor).toBe('everyone');
  });
});

describe('requiring single sign-on (#378)', () => {
  const changes = { singleSignOn: 'required' } as const;
  const ask = (
    s: ReturnType<typeof setup>,
    input: Partial<Parameters<typeof s.update.handle>[0]>,
  ) => s.update.handle({ actor: admin, provider: 'oidc', changes, ...input });
  const refusedWith = (code: string) => (error: unknown) =>
    (error as ConflictError).code === code;

  it('ends what the old rule refused before it, and what the new one does after', async () => {
    const s = setup();
    s.refused.next = { sessions: 2, secondSteps: 0, links: 1, emailCodes: 0 };
    const written = await ask(s, {
      changes: { ...changes, breakGlassUserId: 'rescue' },
    });
    expect(written.settings.singleSignOn).toBe('required');
    expect(s.refused.asked.map((asked) => asked.allowed)).toEqual([
      'all',
      { providers: ['oidc'], breakGlassUserId: 'rescue' },
    ]);
    expect(s.audit.events).toMatchObject([
      {
        action: 'settings.sign-ins-ended',
        data: { sessions: 2, secondSteps: 0, links: 1, emailCodes: 0 },
      },
      { action: 'settings.single-sign-on' },
      {
        action: 'settings.break-glass',
        data: { from: null, to: 'rescue' },
      },
      { action: 'settings.sign-ins-ended' },
    ]);
  });

  it('ends what the break-glass account’s password opened before, no use of it now', async () => {
    const s = setup();
    await ask(s, { changes: { breakGlassUserId: 'rescue' } });
    expect(s.refused.passwordsOf).toEqual([]);
    await ask(s, { sessionHash: 'another' });
    expect(s.refused.passwordsOf).toEqual([['rescue', 'another']]);
    expect(s.events.used).toEqual([]);
  });

  it('is made only by who still administers access once the provider answered', async () => {
    const s = setup();
    s.provider.begin = () => {
      s.access.putUser({ id: 'admin', name: 'Admin', email: null });
      return Promise.resolve({ authorizationUrl: 'https://x', pending: {} });
    };
    await expect(ask(s, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(s.store.stored.version).toBe(0);
  });

  it('needs a provider that answers now', async () => {
    const s = setup();
    s.provider.begin = () => Promise.reject(new Error('down'));
    await expect(ask(s, {})).rejects.toSatisfy(
      refusedWith('single-sign-on-unavailable'),
    );
    expect(s.store.stored.version).toBe(0);
  });

  it.each([
    ['a password', 'password'],
    ['a code by email', 'email-code'],
    ['nothing (a token)', undefined],
  ])(
    'needs an own session that goes on: not one begun with %s',
    async (_, p) => {
      const s = setup();
      await expect(ask(s, { provider: p })).rejects.toSatisfy(
        refusedWith('single-sign-on-own-first'),
      );
      expect(s.store.stored.version).toBe(0);
    },
  );

  it('takes the break-glass account’s own password session, as a use of it', async () => {
    const s = setup();
    await ask(s, {
      provider: 'password',
      sessionHash: 'own',
      changes: { ...changes, breakGlassUserId: 'admin' },
    });
    // What else its password opened ends.
    expect(s.refused.passwordsOf).toEqual([['admin', 'own']]);
    expect(s.events.used).toEqual(['admin']);
    expect(s.audit.events).toContainEqual(
      expect.objectContaining({ action: 'user.break-glass-sign-in' }),
    );
    // Which it then may not take away, but may turn the rule off.
    await expect(
      ask(s, { provider: 'password', changes: { breakGlassUserId: null } }),
    ).rejects.toSatisfy(refusedWith('single-sign-on-own-first'));
    await ask(s, {
      provider: 'password',
      changes: { singleSignOn: 'optional', breakGlassUserId: null },
    });
    expect(s.store.stored.settings.breakGlassUserId).toBeNull();
  });

  it('refuses a break-glass account that could not be used', async () => {
    const s = setup();
    s.rules.problems.set('rescue', 'no-password');
    const refused = (error: unknown) =>
      refusedWith('break-glass-not-usable')(error) &&
      (error as ConflictError).meta?.['problem'] === 'no-password';
    await expect(
      ask(s, { changes: { breakGlassUserId: 'rescue' } }),
    ).rejects.toSatisfy(refused);
    // Named before, unusable since: not relied on either.
    s.rules.problems.clear();
    await ask(s, { changes: { breakGlassUserId: 'rescue' } });
    s.rules.problems.set('rescue', 'no-password');
    await expect(ask(s, {})).rejects.toSatisfy(refused);
    // But it can be cleared, and everything else changed.
    await ask(s, { changes: { sessionMaxHours: 10 } });
    await ask(s, { changes: { breakGlassUserId: null } });
  });

  it('holds although what it refuses could not be ended; turning it off does not', async () => {
    const s = setup();
    s.refused.failFrom = 1;
    expect((await ask(s, {})).settings.singleSignOn).toBe('required');
    await expect(
      ask(s, { changes: { singleSignOn: 'optional' } }),
    ).rejects.toThrow('interrupted');
    expect(s.store.stored.settings.singleSignOn).toBe('required');
  });

  it('begins anew when another change came between, so what that one refused is ended first', async () => {
    const s = setup();
    const { read } = s.store;
    const between = (times: number) => {
      let left = times;
      s.store.read = async () => {
        const was = await read.call(s.store);
        if (left-- > 0) {
          // Required by someone else, right after it was read as optional.
          s.store.stored = {
            ...was,
            version: was.version + 1,
            settings: { ...was.settings, singleSignOn: 'required' },
          };
        }
        return was;
      };
    };
    between(1);
    await ask(s, { changes: { singleSignOn: 'optional' } });
    expect(s.store.stored.settings.singleSignOn).toBe('optional');
    expect(s.refused.asked[0]?.allowed).toEqual({
      providers: ['oidc'],
      breakGlassUserId: null,
    });
    between(Infinity);
    await expect(
      ask(s, { changes: { singleSignOn: 'optional' } }),
    ).rejects.toSatisfy(refusedWith('lock-contended'));
  });

  it('asks and ends nothing for a change that changes nothing', async () => {
    const s = setup();
    await ask(s, {
      changes: { singleSignOn: 'optional', selfApproval: 'review' },
    });
    expect(s.refused.asked).toEqual([]);
  });
});

describe('session limits (#378)', () => {
  it('audits them as one event, and ends what was past them before', async () => {
    const s = setup();
    await s.update.handle({
      actor: admin,
      changes: { sessionIdleMinutes: 30, sessionMaxHours: 2 },
    });
    expect(s.refused.asked.map((asked) => asked.limits)).toEqual([
      { idleMs: 480 * 60_000, maxMs: 168 * 3_600_000 },
      { idleMs: 30 * 60_000, maxMs: 2 * 3_600_000 },
    ]);
    expect(s.audit.events).toMatchObject([
      {
        action: 'settings.session-limits',
        data: {
          from: { idleMinutes: null, maxHours: null },
          to: { idleMinutes: 30, maxHours: 2 },
        },
      },
    ]);
  });

  it('keeps the idle limit within the lifetime, the server’s own too', async () => {
    const s = setup();
    const crossed = (error: unknown) =>
      (error as ConflictError).code === 'session-limits-crossed';
    for (const changes of [
      { sessionIdleMinutes: 61, sessionMaxHours: 1 },
      { sessionMaxHours: 7 },
    ]) {
      await expect(
        s.update.handle({ actor: admin, changes }),
      ).rejects.toSatisfy(crossed);
    }
    await s.update.handle({ actor: admin, changes: { sessionMaxHours: 8 } });
  });
});

describe('allowsSelf', () => {
  it('lifts the author check for approve with review, for both with review-and-sign-off', () => {
    expect(allowsSelf('never', 'approve')).toBe(false);
    expect(allowsSelf('never', 'sign-off')).toBe(false);
    expect(allowsSelf('review', 'approve')).toBe(true);
    expect(allowsSelf('review', 'sign-off')).toBe(false);
    expect(allowsSelf('review-and-sign-off', 'approve')).toBe(true);
    expect(allowsSelf('review-and-sign-off', 'sign-off')).toBe(true);
  });
});
