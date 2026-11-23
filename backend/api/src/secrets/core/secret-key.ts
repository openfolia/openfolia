import { inspect } from 'node:util';
import { timingSafeEqual } from 'node:crypto';

/** How many bytes the instance secret key has (AES-256). */
export const SECRET_KEY_BYTES = 32;

const REDACTED = '[secret key]';

/**
 * The instance secret key (#470): 32 bytes. Its bytes are reached only
 * through `bytes()`; printed, logged or serialised it is `[secret key]`,
 * so a log line or an error that takes it by mistake never shows it.
 */
export class SecretKey {
  readonly #bytes: Buffer;

  constructor(bytes: Uint8Array) {
    if (bytes.length !== SECRET_KEY_BYTES) {
      throw new Error(`A secret key has ${SECRET_KEY_BYTES} bytes.`);
    }
    this.#bytes = Buffer.from(bytes);
  }

  /** A copy of the key's bytes, for the cipher. */
  bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  equals(other: SecretKey): boolean {
    return timingSafeEqual(this.#bytes, other.#bytes);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Which variable set the key: the name, or its old one (deprecated). */
export type SecretKeyVariable = 'CCMS_SECRET_KEY' | 'CCMS_WEBHOOKS_SECRET_KEY';

/**
 * Where the instance's key came from: a variable the operator set, the key
 * file (`created`: this start wrote it), or nowhere (generation turned off
 * and none set: nothing can be sealed).
 */
export type SecretKeyOrigin =
  | { readonly kind: 'environment'; readonly variable: SecretKeyVariable }
  | { readonly kind: 'file'; readonly path: string; readonly created: boolean }
  | { readonly kind: 'none' };

/**
 * The key cannot be used as it is: the server must not start (or the
 * rotation not run). The message says what to do; it names variables and
 * the key file's path, never a key.
 */
export class SecretKeyProblem extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretKeyProblem';
  }
}
