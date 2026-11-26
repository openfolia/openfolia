import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { EMAIL_CODE_PROVIDER } from './email-codes.js';
import { PASSWORD_PROVIDER } from './passwords.js';

/** Who must sign in with a second factor (#611), as the installation settings say it. */
export const SECOND_FACTOR_RULES = ['optional', 'admins', 'everyone'] as const;
export type SecondFactorRuleValue = (typeof SECOND_FACTOR_RULES)[number];

/** What an installation that changed nothing has: each person's own choice. */
export const DEFAULT_SECOND_FACTOR_RULE: SecondFactorRuleValue = 'optional';

/** Port: the installation's rule (`settings`), read in the transaction of the sign-in. */
export abstract class SecondFactorRule {
  abstract read(tx?: Transaction): Promise<SecondFactorRuleValue>;
}

/**
 * The ways in the second factor covers (#611): those that end here, with a password or a code by
 * email. A provider's sign-in (OpenID Connect, SAML) is the provider's to secure.
 */
export function coveredBySecondFactor(provider: string | undefined): boolean {
  return provider === PASSWORD_PROVIDER || provider === EMAIL_CODE_PROVIDER;
}

/** A set-up begun must be confirmed within this time; then it is begun again. */
export const SECOND_FACTOR_SET_UP_MS = 10 * 60_000;

/** How many recovery codes a person gets, each for one sign-in without their phone. */
export const RECOVERY_CODES = 10;
/** Crockford's base32: no letter that reads as another, so a printed code can be typed. */
const RECOVERY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** 16 characters, 80 bits: too many to guess even from the stored hashes. */
const RECOVERY_LENGTH = 16;
const RECOVERY_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;

/** New recovery codes from the CSPRNG, as shown (`xxxx-xxxx-xxxx-xxxx`), once. */
export function mintRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () =>
    Array.from(
      randomBytes(RECOVERY_LENGTH),
      (byte) => RECOVERY_ALPHABET[byte & 31],
    )
      .join('')
      .replace(/.{4}(?=.)/g, '$&-'),
  );
}

/** A recovery code's hash for `userId`, lowercase hex: all that is stored of it. */
export function hashRecoveryCode(userId: string, code: string): string {
  return createHash('sha256')
    .update(`${userId}\n${code.replaceAll('-', '')}`, 'utf8')
    .digest('hex');
}

/** What was typed: an app's code, a recovery code (its look-alikes read back), or neither. */
export function readSecondFactorCode(
  typed: string,
):
  | { readonly kind: 'totp'; readonly code: string }
  | { readonly kind: 'recovery-code'; readonly code: string }
  | undefined {
  const bare = typed.replace(/[\s-]/g, '').toLowerCase();
  if (/^[0-9]{6}$/.test(bare)) return { kind: 'totp', code: bare };
  const code = bare.replaceAll('o', '0').replace(/[il]/g, '1');
  return RECOVERY_PATTERN.test(code)
    ? { kind: 'recovery-code', code }
    : undefined;
}

/** A person's second factor as stored: the secret sealed, the recovery codes hashed. */
export interface SecondFactor {
  readonly userId: string;
  /** Sealed for `secondFactorContext(userId)`. */
  readonly sealedSecret: string;
  readonly begunAt: Date;
  /** Null while its set-up is not confirmed with a code: it counts for nothing then. */
  readonly confirmedAt: Date | null;
  readonly recoveryCodesLeft: number;
}

/** What a person's secret is sealed for (`SecretSealer`). */
export const secondFactorContext = (userId: string): string =>
  `second-factor:v1:${userId}`;

/**
 * Port: people's second factors (#611), one per person at most. A set-up begun is stored
 * unconfirmed and counts for nothing until a code from the app confirms it.
 */
export abstract class SecondFactors {
  /** The person's, confirmed or not; undefined for none. */
  abstract find(
    userId: string,
    tx?: Transaction,
  ): Promise<SecondFactor | undefined>;

  /**
   * Begins a set-up at `at`, replacing one not confirmed yet; false (nothing written) when the
   * person has a confirmed one.
   */
  abstract begin(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
  ): Promise<boolean>;

  /**
   * Confirms the set-up begun with `sealedSecret`, at `at`, with the time step of the code that
   * did (used up with it) and the recovery codes' hashes; false when it is not the one begun.
   */
  abstract confirm(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
    step: number,
    recoveryHashes: readonly string[],
  ): Promise<boolean>;

  /**
   * Uses up the time step `step` of a confirmed factor: false when it, or a later one, was used
   * before. One step, so two requests with one code at once get one yes.
   */
  abstract useStep(
    tx: Transaction,
    userId: string,
    step: number,
  ): Promise<boolean>;

  /** Uses up the recovery code of `hash`: false when the person has none of it (any more). */
  abstract useRecoveryCode(
    tx: Transaction,
    userId: string,
    hash: string,
  ): Promise<boolean>;

  /** Replaces every recovery code of the person by these. */
  abstract replaceRecoveryCodes(
    tx: Transaction,
    userId: string,
    hashes: readonly string[],
  ): Promise<void>;

  /** Removes the person's, with its recovery codes; whether there was a confirmed one. */
  abstract remove(tx: Transaction, userId: string): Promise<boolean>;
}
