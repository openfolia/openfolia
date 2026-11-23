import type { Transaction } from '../../base/core/unit-of-work.js';
import { UnprocessableError } from '../../base/core/errors.js';
import { COMMON_PASSWORDS, SEQUENCES } from './common-passwords.js';

/** A password's fewest characters (#610): length is what makes one hard to guess. */
export const PASSWORD_MIN_LENGTH = 12;
/** A password's most characters: hashing a longer one is work for nothing. */
export const PASSWORD_MAX_LENGTH = 256;

/** The session provider of a password sign-in (`StoredSession.provider`, `SessionPolicy`). */
export const PASSWORD_PROVIDER = 'password';

/**
 * A password as it is hashed and compared: Unicode NFC, so the same characters typed on two
 * systems (a precomposed "ä" or "a" with a combining mark) are one password.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** Its length in characters (code points), as people count them. */
export function passwordLength(password: string): number {
  return [...normalizePassword(password)].length;
}

/** Why a new password is refused. */
export type PasswordProblem =
  'password-too-short' | 'password-too-long' | 'password-too-common';

/** Look-alike digits and symbols, read back as the letters they stand for. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  '@': 'a',
  '4': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g',
  '!': 'i',
  '1': 'i',
  '|': 'l',
  '0': 'o',
  $: 's',
  '5': 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};

/** The readings of `password` worth looking up: as typed, without its ends, the look-alikes read back. */
function readings(password: string): Set<string> {
  const lower = normalizePassword(password).toLowerCase();
  const found = new Set<string>();
  for (const text of [
    lower,
    lower.replace(/[^\p{L}]+$/u, ''),
    lower.replace(/^[^\p{L}]+/u, ''),
    lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''),
  ]) {
    found.add(text);
    found.add(text.replace(/\s+/g, ''));
    const unleet = [...text].map((c) => LOOK_ALIKES[c] ?? c).join('');
    found.add(unleet);
    found.add(unleet.replace(/[^\p{L}]+$/u, ''));
  }
  found.delete('');
  return found;
}

/** `text` made of one short piece over and over (`abcabcabcabc`), and that piece. */
function repeatedUnit(text: string): string | undefined {
  const chars = [...text];
  for (let size = 1; size <= chars.length / 2; size++) {
    if (chars.length % size !== 0) continue;
    const unit = chars.slice(0, size).join('');
    if (unit.repeat(chars.length / size) === text) return unit;
  }
  return undefined;
}

/** Whether `text` runs along a keyboard row or the alphabet, either way. */
function isSequence(text: string): boolean {
  if (text.length < 4) return false;
  return SEQUENCES.some((row) => {
    // Around the end and on (`…7890123`): a run may wrap, more than once in a long one.
    const around = row.repeat(Math.ceil(text.length / row.length) + 1);
    const reversed = [...around].reverse().join('');
    return around.includes(text) || reversed.includes(text);
  });
}

/**
 * Why `password` may not be set (#610), or undefined when it may: at least
 * `PASSWORD_MIN_LENGTH` and at most `PASSWORD_MAX_LENGTH` characters, and none of the bundled
 * common passwords (`common-passwords.ts`), with digits or symbols around it, look-alike
 * characters for letters, or repeated; no run along a keyboard row or the alphabet; not the
 * person's own email address or its local part. No composition rules (a digit, a capital):
 * they make passwords harder to remember, not to guess.
 */
export function passwordProblem(
  password: string,
  person: { readonly email?: string | null } = {},
): PasswordProblem | undefined {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) return 'password-too-short';
  if (length > PASSWORD_MAX_LENGTH) return 'password-too-long';
  const email = person.email?.toLowerCase();
  const own = email ? [email, email.split('@')[0] ?? ''] : [];
  for (const reading of readings(password)) {
    if (COMMON_PASSWORDS.has(reading) || own.includes(reading)) {
      return 'password-too-common';
    }
    if (isSequence(reading)) return 'password-too-common';
    const unit = repeatedUnit(reading);
    if (
      unit !== undefined &&
      (unit.length <= 4 || COMMON_PASSWORDS.has(unit) || isSequence(unit))
    ) {
      return 'password-too-common';
    }
  }
  return undefined;
}

const PROBLEM_TEXT: Readonly<Record<PasswordProblem, string>> = {
  'password-too-short': `A password needs at least ${PASSWORD_MIN_LENGTH} characters.`,
  'password-too-long': `A password has at most ${PASSWORD_MAX_LENGTH} characters.`,
  'password-too-common':
    'This password is too common or too easy to guess; choose another.',
};

/**
 * Refuses a new password with 422 and its problem's code (`password-too-short`,
 * `password-too-long`, `password-too-common`; `meta.minLength`, `meta.maxLength`).
 */
export function checkNewPassword(
  password: string,
  person: { readonly email?: string | null } = {},
): void {
  const problem = passwordProblem(password, person);
  if (problem === undefined) return;
  const meta = {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  };
  switch (problem) {
    case 'password-too-short':
      throw new UnprocessableError(
        'password-too-short',
        PROBLEM_TEXT[problem],
        meta,
      );
    case 'password-too-long':
      throw new UnprocessableError(
        'password-too-long',
        PROBLEM_TEXT[problem],
        meta,
      );
    case 'password-too-common':
      throw new UnprocessableError(
        'password-too-common',
        PROBLEM_TEXT[problem],
        meta,
      );
  }
}

/**
 * Port: hashes and checks passwords (#610). The core's is argon2id
 * (`repos/argon2-password-hasher.ts`), its parameters in one place; a hash records the
 * parameters it was made with, so a stored one keeps verifying after they change, and is
 * replaced at the next sign-in (`needsRehash`).
 */
export abstract class PasswordHasher {
  /** A new hash of `password` (normalised), with a fresh salt. */
  abstract hash(password: string): Promise<string>;

  /** Whether `password` is the one `stored` was made from; false for a malformed hash. */
  abstract verify(stored: string, password: string): Promise<boolean>;

  /** Whether `stored` was made with other parameters than the current ones. */
  abstract needsRehash(stored: string): boolean;

  /**
   * Takes as long as `verify` of a real hash and answers nothing: run for an address that
   * has no password, so the answer comes in the same time as for a wrong one.
   */
  abstract verifyNothing(password: string): Promise<void>;
}

/** What signing in with a password checks: whose address it is, and their hash. */
export interface PasswordCredentials {
  readonly userId: string;
  readonly email: string;
  readonly hash: string;
  /** Null while the user may act. */
  readonly deactivatedAt: Date | null;
}

/**
 * Port: users' password hashes (#610), one per user at most, never the password. A user
 * without one cannot sign in with a password (made by an admin and not yet invited, or one
 * who signs in with a provider only).
 */
export abstract class PasswordStore {
  /** The credentials of the user whose email address is `email` (ignoring case); undefined: none, or no password. */
  abstract findByEmail(email: string): Promise<PasswordCredentials | undefined>;

  /** The user's hash (read in `tx` when given); undefined for none. */
  abstract hashOf(
    userId: string,
    tx?: Transaction,
  ): Promise<string | undefined>;

  /** Sets (or replaces) the user's hash, in `tx`. */
  abstract set(tx: Transaction, userId: string, hash: string): Promise<void>;

  /**
   * Replaces the user's hash with `next` only while it is still `previous` (a rehash at
   * sign-in, a change: a password set meanwhile is kept); whether it did.
   */
  abstract replaceIf(
    tx: Transaction,
    userId: string,
    previous: string,
    next: string,
  ): Promise<boolean>;
}

/**
 * Port: password sign-in's settings (#610), as the core needs them. The core's reads
 * `CCMS_PASSWORD_SIGN_IN`, `CCMS_INVITE_DAYS`, `CCMS_PUBLIC_URL` and `CCMS_EDITOR_URL`.
 */
export abstract class PasswordSignIn {
  /** Whether people may sign in with a password (never in demo mode). */
  abstract readonly enabled: boolean;
  /** How long an invite link is valid, in ms. */
  abstract readonly inviteMs: number;
  /**
   * The editor's address a copied link starts with (`CCMS_PUBLIC_URL`, else `CCMS_EDITOR_URL`),
   * ending in `/`; null when neither is set (the editor then uses its own).
   */
  abstract readonly linkBase: string | null;
}
