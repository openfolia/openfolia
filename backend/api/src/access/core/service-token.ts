import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A service account's API token: `ccms_sat_<id>_<secret>`, where `id` is
 * 16 lowercase hex digits (64 random bits; public, the token's name in
 * lists and the audit log) and `secret` 64 (256 random bits, from the
 * operating system's CSPRNG). The fixed prefix lets secret scanners
 * recognise a leaked token (`SERVICE_TOKEN_PATTERN`). Only the SHA-256 of
 * the whole token is stored; a token of this much entropy needs no slow
 * hash, as nobody can guess one to test against it.
 */
// Compatibility: keeps the working name from before the product was named OpenFolia: tokens already issued stay valid, and secret scanners keep finding them.
export const SERVICE_TOKEN_PREFIX = 'ccms_sat_';

/** A whole token, for secret scanners: `ccms_sat_` + 16 hex + `_` + 64 hex. */
export const SERVICE_TOKEN_PATTERN = /^ccms_sat_([0-9a-f]{16})_[0-9a-f]{64}$/;

/** A token's ID: 16 lowercase hex digits. */
export const SERVICE_TOKEN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** A token just made: the token itself, to show once, its ID and its hash. */
export interface MintedToken {
  readonly id: string;
  /** Shown once, to whoever issued it; never stored, logged or audited. */
  readonly token: string;
  /** SHA-256 of `token`, lowercase hex: what is stored. */
  readonly secretHash: string;
}

/** Makes a new token from the CSPRNG. */
export function mintServiceToken(): MintedToken {
  const id = randomBytes(8).toString('hex');
  const token = `${SERVICE_TOKEN_PREFIX}${id}_${randomBytes(32).toString('hex')}`;
  return { id, token, secretHash: hashServiceToken(token) };
}

/** Whether `bearer` looks like a service token at all (its prefix). */
export const isServiceToken = (bearer: string): boolean =>
  bearer.startsWith(SERVICE_TOKEN_PREFIX);

/** The ID of a well-formed token; undefined for anything else. */
export function serviceTokenId(token: string): string | undefined {
  return SERVICE_TOKEN_PATTERN.exec(token)?.[1];
}

/** SHA-256 of `token`, lowercase hex. */
export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether `token` hashes to `secretHash`, compared in constant time (both
 * are 32-byte digests, so their lengths never differ). A stored hash that
 * is not 64 hex digits matches nothing.
 */
export function serviceTokenMatches(
  token: string,
  secretHash: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(secretHash)) return false;
  return timingSafeEqual(
    createHash('sha256').update(token, 'utf8').digest(),
    Buffer.from(secretHash, 'hex'),
  );
}
