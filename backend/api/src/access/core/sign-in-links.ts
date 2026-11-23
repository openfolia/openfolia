import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * A one-time link to set a password (#610): an invite (a new person's first password) or a
 * reset. Its token is `ccms_pwl_<secret>`, the secret 64 lowercase hex digits (256 bits from the
 * CSPRNG); the fixed prefix lets a secret scanner recognise a leaked one
 * (`SIGN_IN_LINK_PATTERN`). Only its SHA-256 is stored. The link carries it after `#`, so it is
 * never sent to a server, logged or passed on as a referrer. The working name in it is this one
 * constant's (#372).
 */
// Compatibility: keeps the working name from before the product was named OpenFolia: links already sent stay valid.
export const SIGN_IN_LINK_PREFIX = 'ccms_pwl_';

/** A whole link token: the prefix and 64 hex digits. */
export const SIGN_IN_LINK_PATTERN = new RegExp(
  `^${SIGN_IN_LINK_PREFIX}[0-9a-f]{64}$`,
);

/** What a link is for. */
export const SIGN_IN_LINK_KINDS = ['invite', 'reset'] as const;
export type SignInLinkKind = (typeof SIGN_IN_LINK_KINDS)[number];

/** A reset link is valid for one hour; an invite for `PasswordSignIn.inviteMs`. */
export const RESET_LINK_MS = 60 * 60 * 1000;

/** "Forgot password" makes at most one reset link per person per this time. */
export const RESET_REQUEST_INTERVAL_MS = 60 * 1000;

/** The editor's page a link opens, under the editor's address; the token follows after `#`. */
export const SET_PASSWORD_PATH = 'set-password';

/** A link token just made, and its hash (what is stored). */
export interface MintedLink {
  /** Shown once (to the admin, in an email); never stored, logged or audited. */
  readonly token: string;
  readonly hash: string;
}

export function mintSignInLinkToken(): MintedLink {
  const token = `${SIGN_IN_LINK_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, hash: hashSignInLinkToken(token) };
}

/** SHA-256 of `token`, lowercase hex: a link's key in the store. */
export function hashSignInLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The address a link opens: `<base>set-password#<token>`. */
export function signInLinkUrl(base: string, token: string): string {
  return `${base}${SET_PASSWORD_PATH}#${token}`;
}

/** A link as stored. */
export interface StoredSignInLink {
  readonly hash: string;
  readonly userId: string;
  readonly kind: SignInLinkKind;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Port: the links to set a password (#610). A person has at most one: making one removes the
 * ones before it, so a new invite or reset revokes the earlier link. Using one removes it, in
 * the transaction that sets the password, so it works once.
 */
export abstract class SignInLinks {
  /**
   * Adds `link` for its user, in `tx`, removing every earlier link of theirs; answers how many
   * it removed.
   */
  abstract replace(
    tx: Transaction,
    link: {
      readonly hash: string;
      readonly userId: string;
      readonly kind: SignInLinkKind;
      readonly expiresAt: Date;
    },
  ): Promise<number>;

  /** The link of `hash`, expired or not; undefined for none. */
  abstract find(hash: string): Promise<StoredSignInLink | undefined>;

  /** Removes the link of `hash`, in `tx`, and answers it (expired or not); undefined for none. */
  abstract take(
    tx: Transaction,
    hash: string,
  ): Promise<StoredSignInLink | undefined>;

  /** Removes every link of `userId` (of `kind` only, when given), in `tx`; answers how many. */
  abstract revokeAll(
    tx: Transaction,
    userId: string,
    kind?: SignInLinkKind,
  ): Promise<number>;

  /** The user's link, read in `tx`; undefined for none. */
  abstract linkOf(
    tx: Transaction,
    userId: string,
  ): Promise<StoredSignInLink | undefined>;
}
