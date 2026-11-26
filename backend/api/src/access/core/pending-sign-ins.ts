import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * A sign-in whose first factor was right and whose second is still open (#611): no session, no
 * API access. Its token is `ccms_2fa_<secret>`, the secret 64 lowercase hex digits (256 bits from
 * the CSPRNG); the fixed prefix lets a secret scanner recognise a leaked one. It lives in an
 * HttpOnly cookie, which binds it to the browser that gave the first factor; only its SHA-256 is
 * stored.
 */
export const PENDING_SIGN_IN_PREFIX = 'ccms_2fa_';

/** A whole token: the prefix and 64 hex digits. */
export const PENDING_SIGN_IN_PATTERN = new RegExp(
  `^${PENDING_SIGN_IN_PREFIX}[0-9a-f]{64}$`,
);

/** How long the second step may take. */
export const PENDING_SIGN_IN_MS = 10 * 60_000;

/** At most this many open per person: a new one past it ends the oldest. */
export const MAX_PENDING_SIGN_INS = 20;

/**
 * What the second step is: `verify`, a code for a factor that is on; `set-up`, turning one on
 * first, because the installation requires it.
 */
export const SECOND_STEPS = ['verify', 'set-up'] as const;
export type SecondStep = (typeof SECOND_STEPS)[number];

export function mintPendingSignIn(): {
  readonly token: string;
  readonly hash: string;
} {
  const token = `${PENDING_SIGN_IN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, hash: hashPendingSignIn(token) };
}

/** SHA-256 of a token, lowercase hex: its key in the store. */
export function hashPendingSignIn(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface PendingSignIn {
  readonly hash: string;
  readonly userId: string;
  readonly step: SecondStep;
  /** How the first factor was given: the provider of the session to come, and an email code's `via`. */
  readonly provider: string;
  readonly via: string | null;
  readonly expiresAt: Date;
}

/** Port: the open second steps, in the database: alike on every server and after a restart. */
export abstract class PendingSignIns {
  /** Adds one, in `tx`; the person's expired ones and those past `MAX_PENDING_SIGN_INS` go. */
  abstract create(
    tx: Transaction,
    pending: PendingSignIn,
    now: Date,
  ): Promise<void>;

  /** The one of `hash`, expired or not; undefined for none. */
  abstract find(
    hash: string,
    tx?: Transaction,
  ): Promise<PendingSignIn | undefined>;

  /** Removes the one of `hash`, in `tx`: whether there was one that had not run out at `now`. */
  abstract take(tx: Transaction, hash: string, now: Date): Promise<boolean>;

  /** Removes every one of the person, in `tx` (`WaysIn`). */
  abstract revokeAll(tx: Transaction, userId: string): Promise<void>;
}
