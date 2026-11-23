import { randomBytes } from 'node:crypto';
import { AesSecretSealer } from '../../base/repos/aes-secret-sealer.js';
import type { SecretSealer } from '../../base/core/secret-sealer.js';
import { SECRET_KEY_BYTES, SecretKey } from '../core/secret-key.js';
import { SecretCipher } from '../core/secret-key-ports.js';

/** `SecretCipher` with AES-256-GCM (`AesSecretSealer`) and keys from the CSPRNG. */
export class AesSecretCipher extends SecretCipher {
  generateKey(): SecretKey {
    return new SecretKey(randomBytes(SECRET_KEY_BYTES));
  }

  sealer(key: SecretKey): SecretSealer {
    return new AesSecretSealer(key.bytes());
  }
}
