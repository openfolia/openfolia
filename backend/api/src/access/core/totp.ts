import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), as authenticator apps make them: HMAC-SHA-1, 30 s
 * steps, six digits. These are what every app reads; a different digest or length in the QR code
 * is ignored by some, so they are constants, not settings.
 */
export const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
/** The secret's length: 160 bits, as RFC 4226 recommends for HMAC-SHA-1. */
const TOTP_SECRET_BYTES = 20;
/**
 * How many steps before and after the server's own a code may belong to: one, so a phone's clock
 * may be up to half a minute off, and a code typed as it changes still counts.
 */
const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `bytes` in base32 (RFC 4648) without padding, as authenticator apps take a secret. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let held = 0;
  let text = '';
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += BASE32[(held >>> (bits - 5)) & 31];
      bits -= 5;
    }
    held &= 0xff;
  }
  return bits > 0 ? text + BASE32[(held << (5 - bits)) & 31] : text;
}

function fromBase32(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let held = 0;
  for (const char of text) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error('Not a base32 secret.');
    held = ((held << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((held >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new secret from the CSPRNG, in base32. Given to the person once, stored sealed only. */
export function mintTotpSecret(): string {
  return base32(randomBytes(TOTP_SECRET_BYTES));
}

/** The time step `now` (ms) falls in. */
export function totpStep(now: number): number {
  return Math.floor(now / TOTP_STEP_MS);
}

/** The code of `secret` at `step`. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step within the window of `now` whose code `code` is; undefined for none. Every step is
 * compared, each in constant time. The caller refuses a step used before (`SecondFactors.useStep`).
 */
export function matchingStep(
  secret: string,
  code: string,
  now: number,
): number | undefined {
  const current = totpStep(now);
  const typed = Buffer.from(code);
  let found: number | undefined;
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    const expected = Buffer.from(totpCode(secret, step));
    if (expected.length === typed.length && timingSafeEqual(expected, typed)) {
      found = step;
    }
  }
  return found;
}

/**
 * The address a QR code carries to an authenticator app: `issuer` (the installation's name) and
 * `account` (the person's address) are what the app lists it under. Bounded, so the code stays
 * small enough to scan: an over-long name is left to its default.
 */
export function otpauthUrl(input: {
  readonly secret: string;
  readonly issuer: string;
  readonly account: string;
}): string {
  const encoded = (text: string, instead: string) => {
    // A colon separates issuer and account in the label.
    const safe = encodeURIComponent(text.replaceAll(':', ' ').trim());
    return safe.length > 0 && safe.length <= 240 ? safe : instead;
  };
  const issuer = encoded(input.issuer, 'OpenFolia');
  const account = encoded(input.account, 'account');
  return `otpauth://totp/${issuer}:${account}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_MS / 1000}`;
}
