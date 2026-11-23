import {
  type LinkByEmail,
  type SessionLimits,
  SessionPolicy,
} from '../core/session-policy.js';

/** The limits of a session begun with a provider turned off: it has ended. */
const ENDED: SessionLimits = Object.freeze({ idleMs: 0, maxMs: 0 });

/**
 * The core's session policy (#37): the same limits for everyone, from the
 * settings (`CCMS_SESSION_IDLE_MINUTES`, `CCMS_SESSION_MAX_HOURS`), and any
 * provider offered may be used by anyone; linking by email follows
 * `CCMS_OIDC_LINK_BY_EMAIL`. A way of signing in turned off (`off`: codes by
 * email while `CCMS_EMAIL_CODE_SIGN_IN` is off, #634) may not be signed in
 * with, and its sessions end at their next request. Enforced single
 * sign-on (#378) will replace it.
 */
export class EnvSessionPolicy extends SessionPolicy {
  private readonly fixed: SessionLimits;

  private readonly linking: LinkByEmail;

  private readonly off: ReadonlySet<string>;

  constructor(settings: {
    idleMinutes: number;
    maxHours: number;
    linkByEmail: LinkByEmail;
    /** Session providers turned off. */
    off?: readonly string[];
  }) {
    super();
    this.linking = settings.linkByEmail;
    this.off = new Set(settings.off ?? []);
    this.fixed = {
      idleMs: settings.idleMinutes * 60_000,
      maxMs: settings.maxHours * 3_600_000,
    };
  }

  limits(_userId: string, providerId: string): SessionLimits {
    return this.off.has(providerId) ? ENDED : this.fixed;
  }

  maySignIn(_userId: string, providerId: string): Promise<boolean> {
    return Promise.resolve(!this.off.has(providerId));
  }

  linkByEmail(): LinkByEmail {
    return this.linking;
  }
}
