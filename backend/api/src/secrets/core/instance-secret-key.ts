import { hkdfSync } from 'node:crypto';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import type { SecretKeyOrigin } from './secret-key.js';
import type { OpenedSecretKey } from './actions/open-secret-key.action.js';
import type { SecretCipher } from './secret-key-ports.js';

/**
 * The instance's `SecretSealer`: unavailable until the key has been opened
 * and checked as the server starts (`OpenSecretKeyAction`, run by
 * `SecretKeyGate`), then sealing under it. Requests and jobs come only
 * after that.
 */
export class InstanceSecretKey extends SecretSealer {
  private sealer: SecretSealer | undefined;
  private opened: OpenedSecretKey | undefined;

  constructor(private readonly cipher: SecretCipher) {
    super();
  }

  /** Takes the key the start opened, once. */
  use(opened: OpenedSecretKey): void {
    if (this.opened) throw new Error('The secret key is set already.');
    this.opened = opened;
    this.sealer = opened.key ? this.cipher.sealer(opened.key) : undefined;
  }

  /** Where the key came from; `none` before the start opened it. */
  get origin(): SecretKeyOrigin {
    return this.opened?.origin ?? { kind: 'none' };
  }

  get available(): boolean {
    return this.sealer !== undefined;
  }

  /**
   * A 32-byte key of its own for `info` (HKDF-SHA256 from the instance key; #610: the password
   * lockout's HMAC key), the same on every server sharing the key and after a restart;
   * undefined without a key. Never the instance key itself.
   */
  derive(info: string): Buffer | undefined {
    const key = this.opened?.key;
    if (!key) return undefined;
    return Buffer.from(
      hkdfSync('sha256', key.bytes(), Buffer.alloc(0), info, 32),
    );
  }

  seal(secret: string, context: string): string {
    return this.ready().seal(secret, context);
  }

  open(sealed: string, context: string): string {
    return this.ready().open(sealed, context);
  }

  private ready(): SecretSealer {
    if (!this.sealer) {
      throw new Error('There is no secret key: nothing can be sealed.');
    }
    return this.sealer;
  }
}
