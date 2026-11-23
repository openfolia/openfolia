import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Transaction } from '../../base/core/unit-of-work.js';

/** The session provider of a sign-in by email code (`StoredSession.provider`, `SessionPolicy`). */
export const EMAIL_CODE_PROVIDER = 'email-code';

/** A code: six digits, as typed (spaces and dashes between them are dropped first). */
export const EMAIL_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * The token of the link in a code's email (#634): `ccms_ecl_<secret>`, the secret 64 lowercase
 * hex digits (256 bits from the CSPRNG); the fixed prefix lets a secret scanner recognise a
 * leaked one. Only its SHA-256 is stored. The link carries it after `#`, so it is never sent to
 * a server, logged or passed on as a referrer.
 */
// Compatibility: keeps the working name from before the product was named OpenFolia: links already sent stay valid.
export const EMAIL_CODE_LINK_PREFIX = 'ccms_ecl_';

/** A whole link token: the prefix and 64 hex digits. */
export const EMAIL_CODE_LINK_PATTERN = new RegExp(
  `^${EMAIL_CODE_LINK_PREFIX}[0-9a-f]{64}$`,
);

/**
 * Wrong codes one code takes before it is removed (#634), whatever the account's budget
 * (`CCMS_PASSWORD_FAILURES_MAX`, which may be 0: no limit): a million codes, five guesses.
 */
export const EMAIL_CODE_MAX_FAILURES = 5;

/** The editor's page the link opens, under the editor's address; the token follows after `#`. */
export const EMAIL_CODE_PATH = 'sign-in-code';

/** A code as typed: its digits only, when there are six of them; else null. */
export function readEmailCode(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '');
  return EMAIL_CODE_PATTERN.test(digits) ? digits : null;
}

/** A code and a link token just made: shown once, in the email; never stored, logged or audited. */
export interface MintedEmailCode {
  readonly code: string;
  readonly linkToken: string;
  readonly linkHash: string;
}

/** A new code (six digits from the CSPRNG, evenly) and a new link token. */
export function mintEmailCode(): MintedEmailCode {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const linkToken = `${EMAIL_CODE_LINK_PREFIX}${randomBytes(32).toString('hex')}`;
  return { code, linkToken, linkHash: hashEmailCodeLink(linkToken) };
}

/** SHA-256 of a link token, lowercase hex: its key in the store. */
export function hashEmailCodeLink(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The address the link opens: `<base>sign-in-code#<token>`. */
export function emailCodeLinkUrl(base: string, token: string): string {
  return `${base}${EMAIL_CODE_PATH}#${token}`;
}

/**
 * Port: sign-in by email code's settings (#634), as the core needs them. The core's reads
 * `CCMS_EMAIL_CODE_SIGN_IN`, `CCMS_EMAIL_CODE_MINUTES` and `CCMS_PUBLIC_URL`.
 */
export abstract class EmailCodeSignIn {
  /** Whether the settings let people sign in by email code (`emailCodeSignInOn`). */
  abstract readonly enabled: boolean;
  /** How long a code and its link work, in ms. */
  abstract readonly lifetimeMs: number;
  /** The editor's address the email's link starts with, ending in `/`; null: no link, the code only. */
  abstract readonly linkBase: string | null;
}

/**
 * Port: hashes a code for its store (#634). Six digits are a million guesses, so a plain hash
 * would give the code away to anyone reading the table: the core's is an HMAC under a key
 * derived from the instance secret key (`repos/drizzle-email-codes.ts`), the same on every
 * server and after a restart. Bound to the user, so one person's hash never matches another's.
 */
export abstract class EmailCodeHasher {
  /** Whether there is a key to hash with (the instance secret key, which email needs too). */
  abstract readonly available: boolean;

  /** The code's hash for `userId`, lowercase hex. Throws while not `available`. */
  abstract hash(userId: string, code: string): string;
}

/** A person's open code, as stored: its hashes, never the code or the link. */
export interface StoredEmailCode {
  readonly userId: string;
  readonly codeHash: string;
  readonly linkHash: string;
  /** The address it was mailed to (#646). */
  readonly sentTo: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** A code claimed by its person's address, with what signing in needs of them. */
export interface EmailCodeHolder {
  readonly userId: string;
  readonly codeHash: string;
  readonly expiresAt: Date;
  /** The tries counted against it so far, this one included (1 to `EMAIL_CODE_MAX_FAILURES`). */
  readonly tries: number;
  /** Null while the user may act. */
  readonly deactivatedAt: Date | null;
}

/**
 * Port: the open codes by email (#634). A person has at most one: making one replaces the one
 * before it (its code and its link), so a new code revokes the earlier one. Using it, by the
 * code or by the link, removes it in the transaction that signs in, so it works once. Apart from
 * the links to set a password (`SignInLinks`): a code never revokes an invite.
 *
 * **Bound to the address it was mailed to** (#646): a code, and its link, work only while that
 * address (`sentTo`, ignoring case) is still the person's. So a code that reached an old address
 * is dead once the address changes, whichever path changed it and however a request asking for
 * one interleaved with the change (`WaysIn.endMailed` ends the codes it sees; this ends the one
 * stored after it).
 */
export abstract class EmailCodes {
  /**
   * Holds the user, in `tx`, until it ends (#650), before a request for a code reads them: their
   * ways in ending meanwhile (`revokeAll`: a password set or changed, a deactivation, a new
   * address) waits for the request, and so ends the code it stores; one already under way is
   * waited for first, so the request reads the person after it. Nothing for a user who is gone.
   */
  abstract hold(tx: Transaction, userId: string): Promise<void>;

  /**
   * Holds the user, in `tx`, until it ends, as ending their ways in does (#650): waits for the
   * requests for a code that `hold` them, and makes later ones wait. `revokeAll` takes it too;
   * `WaysIn` takes it first, before any link or code, so every transaction that ends ways in
   * takes the person, then their links, then their code, and none waits for another in a
   * cycle. A sign-in by the code or its link takes it first as well (#660), before the code
   * and the invite it closes. Nothing for a user who is gone.
   */
  abstract holdToEnd(tx: Transaction, userId: string): Promise<void>;

  /**
   * Stores `code` for its user, in `tx`, replacing their earlier one, only while `sentTo` is
   * their address now (ignoring case) and they are active; whether it did (false: the address
   * changed, the user was deactivated or is gone meanwhile: then mail nothing). Waits for a change of the user's row in progress.
   */
  abstract replace(
    tx: Transaction,
    code: {
      readonly userId: string;
      readonly codeHash: string;
      readonly linkHash: string;
      readonly sentTo: string;
      readonly expiresAt: Date;
    },
  ): Promise<boolean>;

  /**
   * Counts one try against the code of the user whose address is `email` (ignoring case) and
   * returns it, in one atomic step, while it has not run out at `now`, has had fewer than
   * `EMAIL_CODE_MAX_FAILURES` tries and was mailed to that address; undefined: none (no such
   * address, no code, expired, tried out or mailed to an address they had before). The try is
   * counted before the code is compared, so requests at once never get more than
   * `EMAIL_CODE_MAX_FAILURES` comparisons between them.
   */
  abstract claim(
    email: string,
    now: Date,
  ): Promise<EmailCodeHolder | undefined>;

  /**
   * The code whose link has the hash `linkHash`, expired or not, while the address it was mailed
   * to is still its person's; undefined: none.
   */
  abstract findByLink(linkHash: string): Promise<StoredEmailCode | undefined>;

  /**
   * Removes the user's code, in `tx`, only while it is still the one `which` names (by its code's
   * hash, or its link's), has not run out at `now` and the address it was mailed to is still
   * theirs; whether it did (false: used, replaced, expired or its address changed meanwhile).
   */
  abstract take(
    tx: Transaction,
    userId: string,
    which: { readonly codeHash: string } | { readonly linkHash: string },
    now: Date,
  ): Promise<boolean>;

  /** Removes the user's code if it has had `EMAIL_CODE_MAX_FAILURES` tries (a new one has none). */
  abstract dropSpent(userId: string): Promise<void>;

  /** Removes the code of the user whose address is `email` (ignoring case), if any. */
  abstract revokeByEmail(email: string): Promise<void>;

  /**
   * Removes the user's code, in `tx`, expired or not (#645: their password, address or account
   * changed, `WaysIn`); whether there was one. Holds the user first (`holdToEnd`), after any
   * request for a code that holds them (`hold`): so a code is never stored after this for a
   * request that read them before it.
   */
  abstract revokeAll(tx: Transaction, userId: string): Promise<boolean>;
}
