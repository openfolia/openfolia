import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretSealer } from '../core/secret-sealer.js';

const VERSION = 'v1';

/**
 * What a sealed value is bound to: this software, and the caller's context. Compatibility: keeps the working name from before the product was named OpenFolia:
 * a sealed value only opens with the same context.
 */
const aad = (context: string) => Buffer.from(`ccms:${context}`);

/**
 * `SecretSealer` with AES-256-GCM under a 32-byte key:
 * `v1.<iv>.<ciphertext>.<tag>`, each part base64url, a fresh 96-bit IV per
 * seal, the context (`ccms:<context>`) as additional authenticated data. A
 * value changed in the database, sealed under another key or for another
 * context fails its tag and does not open. The format of the webhook
 * secrets sealed before #470 (`ccms:webhook-secret:v1:<ID>`), so they
 * still open.
 */
export class AesSecretSealer extends SecretSealer {
  readonly available = true;
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    super();
    if (key.length !== 32) throw new Error('The secret key must be 32 bytes.');
    this.#key = Buffer.from(key);
  }

  seal(secret: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(aad(context));
    const sealed = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      sealed.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(sealed: string, context: string): string {
    const [version, iv, data, tag, ...rest] = sealed.split('.');
    if (
      version !== VERSION ||
      iv === undefined ||
      data === undefined ||
      tag === undefined ||
      rest.length > 0
    ) {
      throw new Error('Not a sealed secret.');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(iv, 'base64url'),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The sealed secret does not open with this key.');
    }
  }
}
