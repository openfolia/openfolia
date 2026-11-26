import {
  FakeSignInRules,
  FakeSignInSetup,
} from '../../../tests/fakes/fake-sign-in.js';
import {
  DEFAULT_SIGN_IN_RULE,
  type SignInRule,
} from '../core/sign-in-rules.js';
import { EnvSessionPolicy } from './env-session-policy.js';

const ENDED = { idleMs: 0, maxMs: 0 };

describe('EnvSessionPolicy', () => {
  const policy = (set: Partial<SignInRule> = {}, off: string[] = []) => {
    const rules = new FakeSignInRules();
    rules.rule = { ...DEFAULT_SIGN_IN_RULE, ...set };
    return new EnvSessionPolicy(rules, new FakeSignInSetup(), {
      linkByEmail: 'pending',
      off,
    });
  };

  it('has the server’s limits while an administrator set none', async () => {
    expect(await policy().limits('pat', 'oidc')).toEqual({
      idleMs: 8 * 3_600_000,
      maxMs: 7 * 24 * 3_600_000,
    });
  });

  it('has what an administrator set in their place, each on its own', async () => {
    expect(
      await policy({ sessionIdleMinutes: 15 }).limits('pat', 'password'),
    ).toEqual({ idleMs: 15 * 60_000, maxMs: 7 * 24 * 3_600_000 });
    expect(await policy({ sessionMaxHours: 12 }).limits('pat', 'oidc')).toEqual(
      { idleMs: 8 * 3_600_000, maxMs: 12 * 3_600_000 },
    );
  });

  it('ends a session of a way of signing in turned off, whatever is set', async () => {
    const off = policy({ sessionIdleMinutes: 60 }, ['email-code']);
    expect(await off.limits('pat', 'email-code')).toEqual(ENDED);
    expect(await off.maySignIn('pat', 'email-code')).toBe(false);
  });

  it('with single sign-on required has ended a session begun any other way (#378)', async () => {
    const required = policy({
      singleSignOn: 'required',
      breakGlass: { userId: 'rescue', problem: null },
      sessionIdleMinutes: 15,
    });
    expect(await required.requiresSingleSignOn()).toBe(true);
    for (const [userId, provider, allowed] of [
      ['pat', 'oidc', true],
      ['rescue', 'password', true],
      ['rescue', 'email-code', false],
      ['pat', 'password', false],
      ['pat', 'email-code', false],
      // A provider no longer offered, and a way in nobody knows.
      ['pat', 'saml', false],
      ['pat', 'something-new', false],
    ] as const) {
      const limits = await required.limits(userId, provider);
      expect([userId, provider, limits.idleMs > 0]).toEqual([
        userId,
        provider,
        allowed,
      ]);
      expect(await required.maySignIn(userId, provider)).toBe(allowed);
    }
    expect(await policy().requiresSingleSignOn()).toBe(false);
  });

  it('rejects when the rule cannot be read: no limits are made up', async () => {
    const rules = new FakeSignInRules();
    rules.read = () => Promise.reject(new Error('database down'));
    const broken = new EnvSessionPolicy(rules, new FakeSignInSetup(), {
      linkByEmail: 'pending',
    });
    await expect(broken.limits('pat', 'oidc')).rejects.toThrow('database down');
    await expect(broken.maySignIn('pat', 'oidc')).rejects.toThrow(
      'database down',
    );
  });
});
