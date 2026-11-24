// The proof of work a browser does before a sandbox starts: no third-party service, a few hundred
// thousand hashes, so starting sandboxes in bulk costs a script real CPU time while a visitor
// waits about a second. The launcher issues a challenge bound to the visitor's address and to a
// time, signed with a key only it holds; the browser finds a nonce whose SHA-256 of
// `<challenge>:<nonce>` starts with `bits` zero bits; each challenge counts once.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
/** A challenge is good for this long after it was issued. */
export const CHALLENGE_TTL_MS = 2 * 60_000;
/** A nonce is a decimal counter: what the browser's worker counts up. */
const NONCE = /^\d{1,16}$/;

export type PowRefusal =
  'malformed' | 'forged' | 'expired' | 'other-address' | 'used' | 'unsolved';

export class ProofOfWork {
  /** Challenges already redeemed, until they would have expired anyway. */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly key: Buffer,
    readonly bits: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** A challenge for the visitor at `addressKey`. */
  issue(addressKey: string): {
    challenge: string;
    bits: number;
    expiresAt: number;
  } {
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    const body = [
      VERSION,
      String(expiresAt),
      String(this.bits),
      randomBytes(12).toString('hex'),
      this.tag(addressKey),
    ].join('.');
    return {
      challenge: `${body}.${this.mac(body)}`,
      bits: this.bits,
      expiresAt,
    };
  }

  /** Checks a solution and redeems the challenge: undefined when it holds, else why not. */
  redeem(
    challenge: unknown,
    nonce: unknown,
    addressKey: string,
  ): PowRefusal | undefined {
    if (typeof challenge !== 'string' || typeof nonce !== 'string')
      return 'malformed';
    if (challenge.length > 200 || !NONCE.test(nonce)) return 'malformed';
    const parts = challenge.split('.');
    if (parts.length !== 6 || parts[0] !== VERSION) return 'malformed';
    const [, expires, bits, , tag, mac] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const body = parts.slice(0, 5).join('.');
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return 'forged';
    const now = this.now();
    if (!(Number(expires) > now)) return 'expired';
    if (tag !== this.tag(addressKey)) return 'other-address';
    if (this.used.has(challenge)) return 'used';
    if (
      leadingZeroBits(sha256(`${challenge}:${nonce}`)) <
      Math.max(Number(bits), this.bits)
    )
      return 'unsolved';
    this.prune(now);
    this.used.set(challenge, Number(expires));
    return undefined;
  }

  private prune(now: number): void {
    for (const [challenge, expires] of this.used)
      if (expires <= now) this.used.delete(challenge);
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key)
      .update(`pow:${body}`)
      .digest('base64url')
      .slice(0, 32);
  }

  private tag(addressKey: string): string {
    return createHmac('sha256', this.key)
      .update(`addr:${addressKey}`)
      .digest('base64url')
      .slice(0, 16);
  }
}

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Solves a challenge here (tests, and the end-to-end check): what the browser's worker does. */
export function solve(challenge: string, bits: number): string {
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(sha256(`${challenge}:${nonce}`)) >= bits)
      return String(nonce);
  }
}
