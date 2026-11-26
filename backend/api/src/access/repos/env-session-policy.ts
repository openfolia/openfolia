import type { Transaction } from '../../base/core/unit-of-work.js';
import { sessionLimitsOf } from '../core/refused-sign-ins.js';
import {
  type LinkByEmail,
  type SessionLimits,
  SessionPolicy,
} from '../core/session-policy.js';
import {
  requiresSingleSignOn,
  signInAllowed,
  type SignInRules,
  type SignInSetup,
} from '../core/sign-in-rules.js';

/** The limits of a session that may not go on: it has ended. */
const ENDED: SessionLimits = Object.freeze({ idleMs: 0, maxMs: 0 });

/**
 * The core's session policy (#37): the same limits for everyone, what an administrator set
 * (`SignInRules`, #378) in place of the server's own (`SignInSetup`). With single sign-on required
 * only a provider offered now may be signed in with, and the break-glass account's password
 * (`signInAllowed`); a session begun any other way has ended at its next request, whatever else
 * ended it. A way of signing in turned off (`off`: codes by email while `CCMS_EMAIL_CODE_SIGN_IN`
 * is off, #634) likewise. Linking by email follows `CCMS_OIDC_LINK_BY_EMAIL`.
 */
export class EnvSessionPolicy extends SessionPolicy {
  private readonly off: ReadonlySet<string>;

  constructor(
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
    private readonly settings: {
      readonly linkByEmail: LinkByEmail;
      /** Session providers turned off. */
      readonly off?: readonly string[];
    },
  ) {
    super();
    this.off = new Set(settings.off ?? []);
  }

  async limits(
    userId: string,
    providerId: string,
    tx?: Transaction,
  ): Promise<SessionLimits> {
    if (this.off.has(providerId)) return ENDED;
    // For a session that is there already: only what decides about it.
    const rule = await this.rules.readFor({ userId, providerId }, tx);
    return signInAllowed(rule, this.setup.offered, userId, providerId)
      ? sessionLimitsOf(rule, this.setup)
      : ENDED;
  }

  async maySignIn(
    userId: string,
    providerId: string,
    tx?: Transaction,
  ): Promise<boolean> {
    return (
      !this.off.has(providerId) &&
      signInAllowed(
        // The whole rule, whoever it is: what is looked up before anyone is authenticated never
        // depends on whose account it is.
        await this.rules.read(tx),
        this.setup.offered,
        userId,
        providerId,
      )
    );
  }

  async requiresSingleSignOn(tx?: Transaction): Promise<boolean> {
    return requiresSingleSignOn(await this.rules.read(tx));
  }

  linkByEmail(): LinkByEmail {
    return this.settings.linkByEmail;
  }
}
