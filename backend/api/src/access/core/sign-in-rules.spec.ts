import {
  type BreakGlassProblem,
  DEFAULT_SIGN_IN_RULE,
  sessionLimitOf,
  signInAllowed,
  type SignInRule,
} from './sign-in-rules.js';

const OFFERED = ['oidc', 'saml'];
const required = (over: Partial<SignInRule> = {}): SignInRule => ({
  ...DEFAULT_SIGN_IN_RULE,
  singleSignOn: 'required',
  ...over,
});
const breakGlass = (problem: BreakGlassProblem | null = null) =>
  required({ breakGlass: { userId: 'rescue', problem } });

describe('signInAllowed', () => {
  it('lets everyone in while single sign-on is not required', () => {
    for (const way of ['oidc', 'password', 'email-code', 'a-new-way']) {
      expect(signInAllowed(DEFAULT_SIGN_IN_RULE, OFFERED, 'pat', way)).toBe(
        true,
      );
    }
  });

  it('requires a provider offered now: anything else is refused, a way added later too', () => {
    expect(signInAllowed(required(), OFFERED, 'pat', 'oidc')).toBe(true);
    expect(signInAllowed(required(), OFFERED, 'pat', 'saml')).toBe(true);
    for (const way of ['password', 'email-code', 'a-new-way', '', 'OIDC']) {
      expect(signInAllowed(required(), OFFERED, 'pat', way)).toBe(false);
    }
    // A provider no longer set up.
    expect(signInAllowed(required(), ['saml'], 'pat', 'oidc')).toBe(false);
    expect(signInAllowed(required(), [], 'pat', 'oidc')).toBe(false);
  });

  it('never takes a way that ends here for a provider, whatever is offered', () => {
    for (const way of ['password', 'email-code']) {
      expect(signInAllowed(required(), [way], 'pat', way)).toBe(false);
    }
  });

  it('lets the break-glass account in with its password, and nothing else', () => {
    expect(signInAllowed(breakGlass(), OFFERED, 'rescue', 'password')).toBe(
      true,
    );
    expect(signInAllowed(breakGlass(), [], 'rescue', 'password')).toBe(true);
    expect(signInAllowed(breakGlass(), OFFERED, 'rescue', 'email-code')).toBe(
      false,
    );
    for (const other of ['pat', 'Rescue', 'rescue ', '']) {
      expect(signInAllowed(breakGlass(), OFFERED, other, 'password')).toBe(
        false,
      );
    }
  });

  it('is nobody’s while the account is no longer one: an exception without an admin is none', () => {
    for (const problem of [
      'deactivated',
      'no-admin-role',
      'no-password',
    ] as const) {
      expect(
        signInAllowed(breakGlass(problem), OFFERED, 'rescue', 'password'),
      ).toBe(false);
    }
  });

  it('refuses a rule it does not know, as if required', () => {
    const unknown = {
      ...DEFAULT_SIGN_IN_RULE,
      singleSignOn: 'sometimes',
    } as unknown as SignInRule;
    expect(signInAllowed(unknown, OFFERED, 'pat', 'password')).toBe(false);
    expect(signInAllowed(unknown, OFFERED, 'pat', 'oidc')).toBe(true);
  });
});

describe('sessionLimitOf', () => {
  it('is what an administrator set, longer or shorter, else the server’s', () => {
    expect(sessionLimitOf(null, 480)).toBe(480);
    expect(sessionLimitOf(15, 480)).toBe(15);
    expect(sessionLimitOf(1_000, 480)).toBe(1_000);
  });
});
