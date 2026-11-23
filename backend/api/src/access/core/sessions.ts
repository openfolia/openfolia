import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * A person's session (#37): `ccms_ses_<secret>`, the secret 64 lowercase
 * hex digits (256 bits from the CSPRNG). The fixed prefix lets a secret
 * scanner recognise a leaked one (`SESSION_TOKEN_PATTERN`). Only its
 * SHA-256 is stored. The working name in it is this one constant's (#372).
 */
// Compatibility: keeps the working name from before the product was named OpenFolia: the
// tokens of sessions already open still parse (their cookie's name changed: one more sign-in).
export const SESSION_TOKEN_PREFIX = 'ccms_ses_';

/** A whole session token: the prefix and 64 hex digits. */
export const SESSION_TOKEN_PATTERN = new RegExp(
  `^${SESSION_TOKEN_PREFIX}[0-9a-f]{64}$`,
);

/** A session token just made, and its hash (what is stored). */
export interface MintedSession {
  /** Given to the browser once (a cookie); never stored, logged or audited. */
  readonly token: string;
  readonly hash: string;
}

/** Makes a new session token from the CSPRNG. */
export function mintSessionToken(): MintedSession {
  const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, hash: hashSessionToken(token) };
}

/** SHA-256 of `token`, lowercase hex: a session's key in the store. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A session as stored. */
export interface StoredSession {
  readonly hash: string;
  readonly userId: string;
  /** The identity provider it began with (`IdentityProvider.id`). */
  readonly provider: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  /** Null while it may act. */
  readonly revokedAt: Date | null;
}

/** At most this many sessions per user: a new sign-in past it ends the oldest. */
export const MAX_SESSIONS_PER_USER = 20;

/**
 * Port: people's sessions. Looked up by the token's hash on every request,
 * never cached, so ending one (signing out, deactivating the user) applies
 * to the very next request.
 */
export abstract class SessionStore {
  /** The session of `hash`; undefined when there is none. */
  abstract find(hash: string): Promise<StoredSession | undefined>;

  /**
   * Adds a session for `userId`, in `tx`. Also removes the user's sessions
   * that have ended (revoked, or begun before `endedBefore`) and, past
   * `MAX_SESSIONS_PER_USER`, ends the oldest, so a user's sessions stay few.
   */
  abstract create(
    tx: Transaction,
    session: {
      readonly hash: string;
      readonly userId: string;
      readonly provider: string;
      readonly endedBefore: Date;
    },
  ): Promise<void>;

  /** Records a request of the session `hash` at `at`. */
  abstract touch(hash: string, at: Date): Promise<void>;

  /** Ends the session `hash`; false when there is none, or it had ended. */
  abstract revoke(hash: string, tx?: Transaction): Promise<boolean>;

  /**
   * Ends every session of `userId`, in `tx`, but the one of `exceptHash` (when given: the
   * request's own, after a password change); answers how many.
   */
  abstract revokeAllOf(
    tx: Transaction,
    userId: string,
    exceptHash?: string,
  ): Promise<number>;
}
