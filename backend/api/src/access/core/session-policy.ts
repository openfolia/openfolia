import type { Transaction } from '../../base/core/unit-of-work.js';

/** How long a session may last. */
export interface SessionLimits {
  /** Since its last request: past this, it has ended. */
  readonly idleMs: number;
  /** Since it began, however busy: past this, it has ended. */
  readonly maxMs: number;
}

/**
 * Whether a first sign-in links to an existing user by the email address the
 * provider vouches for (`email_verified`), and to which (#37):
 * - `pending`: only a user who has never signed in with any provider (no
 *   identity at any issuer, and no password, #610): one an admin made or the
 *   seed wrote, waiting for their first sign-in;
 * - `any`: any user without an identity at this issuer yet (for providers
 *   that guarantee nobody can set an address they do not own);
 * - `off`: never; a new user is made.
 */
export const LINK_BY_EMAIL = ['pending', 'off', 'any'] as const;
export type LinkByEmail = (typeof LINK_BY_EMAIL)[number];

/**
 * Port: the rules sessions follow (#37). Asked on every request, so
 * a changed rule applies to sessions already running from their next
 * request. The core's is `repos/env-session-policy.ts`.
 */
export abstract class SessionPolicy {
  /** The limits of a session of `userId` begun with the provider `providerId`. */
  abstract limits(
    userId: string,
    providerId: string,
    tx?: Transaction,
  ): Promise<SessionLimits>;

  /**
   * Whether `userId` may sign in with the provider `providerId`. Decided where every session
   * starts (`beginSession`), in its transaction; asked before it too, for the right refusal.
   */
  abstract maySignIn(
    userId: string,
    providerId: string,
    tx?: Transaction,
  ): Promise<boolean>;

  /**
   * Whether people must sign in with an identity provider (#378): then codes by email, links to
   * set a password and "Forgot password" are refused for every address alike.
   */
  abstract requiresSingleSignOn(tx?: Transaction): Promise<boolean>;

  /** Whether and to whom a first sign-in with `providerId` links by email address. */
  abstract linkByEmail(providerId: string): LinkByEmail;
}
