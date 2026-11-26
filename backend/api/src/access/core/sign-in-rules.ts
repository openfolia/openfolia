import { ForbiddenError } from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { EMAIL_CODE_PROVIDER } from './email-codes.js';
import { PASSWORD_PROVIDER } from './passwords.js';

/** Whether people must sign in through an identity provider (#378). */
export const SINGLE_SIGN_ON_RULES = ['optional', 'required'] as const;
export type SingleSignOnRule = (typeof SINGLE_SIGN_ON_RULES)[number];

/** The bounds a session limit is set within (#378), as `CCMS_SESSION_*` has them. */
export const SESSION_IDLE_MINUTES = { min: 5, max: 43_200 } as const;
export const SESSION_MAX_HOURS = { min: 1, max: 8_760 } as const;

/**
 * Why the break-glass account named in the settings cannot be one now: what happened to its
 * person since never leaves the exception to someone who is no administrator any more.
 */
export const BREAK_GLASS_PROBLEMS = [
  /** The person is deactivated. */
  'deactivated',
  /** They hold no role with `admin.roles` given directly: a group's goes as the provider says. */
  'no-admin-role',
  /** They have no password to sign in with. */
  'no-password',
  /** Signing in with a password is off on this server (`CCMS_PASSWORD_SIGN_IN`). */
  'password-sign-in-off',
] as const;
export type BreakGlassProblem = (typeof BREAK_GLASS_PROBLEMS)[number];

/** What an administrator set about signing in (#378), as the installation settings hold it. */
export interface SignInRule {
  readonly singleSignOn: SingleSignOnRule;
  /** The one account that may sign in with its password all the same; null for none. */
  readonly breakGlass: {
    readonly userId: string;
    /** Why it may not now; null when it may. */
    readonly problem: BreakGlassProblem | null;
  } | null;
  /** A session's idle time, in minutes; null: the server's (`CCMS_SESSION_IDLE_MINUTES`). */
  readonly sessionIdleMinutes: number | null;
  /** A session's longest lifetime, in hours; null: the server's (`CCMS_SESSION_MAX_HOURS`). */
  readonly sessionMaxHours: number | null;
}

/** An installation that changed nothing: any way in, the server's own limits. */
export const DEFAULT_SIGN_IN_RULE: SignInRule = {
  singleSignOn: 'optional',
  breakGlass: null,
  sessionIdleMinutes: null,
  sessionMaxHours: null,
};

/** A session: whose, and by which way in. */
export interface BegunSession {
  readonly userId: string;
  readonly providerId: string;
}

/**
 * Port: the installation's rule about signing in (`settings`). Read on every request a session
 * makes, never cached, so a change applies from the next request on every server. In a
 * transaction it is held as read until that ends (a change of it waits, and is waited for).
 */
export abstract class SignInRules {
  abstract read(tx?: Transaction): Promise<SignInRule>;

  /**
   * `read`, to ask about one session that is there already (`signInAllowed`): whether the
   * break-glass account can be used is looked up only when the answer rests on it (its own password
   * session, single sign-on required), and nobody is it otherwise. So a request costs one read of
   * the settings row. Never for a sign-in, where the lookups must not depend on whose it is.
   */
  abstract readFor(
    session: BegunSession,
    tx?: Transaction,
  ): Promise<SignInRule>;

  /**
   * Why `userId` could not be the break-glass account now; null when they could. Worked out from
   * the rows as they are, in the sign-in's transaction, never kept. `admin.roles` is a global
   * permission, as the policy of the settings asks it (`ANYWHERE`): a role's scope (languages,
   * module types) does not narrow it.
   */
  abstract breakGlassProblem(
    userId: string,
    tx?: Transaction,
  ): Promise<BreakGlassProblem | 'no-such-user' | null>;
}

/** Port: what the server is set up with, which the rule works on. Read once, at start. */
export abstract class SignInSetup {
  /** Its own session limits (`CCMS_SESSION_IDLE_MINUTES`, `CCMS_SESSION_MAX_HOURS`). */
  abstract readonly sessionIdleMinutes: number;
  abstract readonly sessionMaxHours: number;
  /** The IDs of the identity providers offered (`IdentityProviders`). */
  abstract readonly offered: readonly string[];
}

/** 403 `sign-in-not-allowed`: the session policy refuses this way of signing in for them. */
export class SignInNotAllowedError extends ForbiddenError {
  override readonly code = 'sign-in-not-allowed';

  constructor() {
    super('Signing in this way is not allowed for you.');
  }
}

/** Whether single sign-on is required. A rule this does not know requires it: it fails closed. */
export function requiresSingleSignOn(rule: SignInRule): boolean {
  return rule.singleSignOn !== 'optional';
}

/** The ways in that end here: no identity provider, whatever is offered. */
const HERE: ReadonlySet<string> = new Set([
  PASSWORD_PROVIDER,
  EMAIL_CODE_PROVIDER,
]);

/**
 * Whether `userId` may have a session begun with `providerId` (#378). With single sign-on
 * required, an allow-list: a provider offered now, or the break-glass account's password. So a
 * way in added later is refused until it is let in here, and so is a rule this does not know.
 */
export function signInAllowed(
  rule: SignInRule,
  offered: Iterable<string>,
  userId: string,
  providerId: string,
): boolean {
  const allowed = allowedSignIns(rule, offered);
  if (allowed === 'all') return true;
  if (allowed.providers.includes(providerId)) return true;
  return (
    providerId === PASSWORD_PROVIDER &&
    allowed.breakGlassUserId !== null &&
    allowed.breakGlassUserId === userId
  );
}

/** What `signInAllowed` lets in, as a list: for the query that ends everything else (#378). */
export type AllowedSignIns =
  | 'all'
  | {
      /** The providers whose sessions may go on, anyone's. */
      readonly providers: readonly string[];
      /** Whose password may be signed in with; null: nobody's. */
      readonly breakGlassUserId: string | null;
    };

export function allowedSignIns(
  rule: SignInRule,
  offered: Iterable<string>,
): AllowedSignIns {
  if (!requiresSingleSignOn(rule)) return 'all';
  return {
    providers: [...offered].filter((id) => !HERE.has(id)),
    breakGlassUserId:
      rule.breakGlass?.problem === null ? rule.breakGlass.userId : null,
  };
}

/**
 * A session limit: what an administrator set (`set`), else the server's. The server's is a
 * default, no ceiling; to make it one, take the smaller here.
 */
export function sessionLimitOf(set: number | null, server: number): number {
  return set ?? server;
}
