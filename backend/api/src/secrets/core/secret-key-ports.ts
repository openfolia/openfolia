import type {
  SealedSecretSource,
  SecretSealer,
} from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { SecretKey, SecretKeyVariable } from './secret-key.js';

/**
 * The key's settings (`CCMS_SECRET_KEY*`): the key a variable sets, if
 * any; where the key file is; whether the server may make it.
 */
export abstract class SecretKeySettings {
  abstract readonly configured:
    | { readonly key: SecretKey; readonly variable: SecretKeyVariable }
    | undefined;
  /** The key file's path (`CCMS_SECRET_KEY_FILE`, or beside the content repository). */
  abstract readonly file: string;
  /** `CCMS_SECRET_KEY_GENERATE`: the server makes the key file when there is none. */
  abstract readonly generate: boolean;
}

/**
 * Port: the key file, and the next key a rotation writes beside it until
 * the database has been re-sealed under it (`<file>.next`). Every read
 * throws `SecretKeyProblem` for a file that is there but cannot be read
 * or holds no key; nothing ever logs or throws the key.
 */
export abstract class SecretKeyFile {
  abstract readonly path: string;

  /** The key in the file; undefined when there is no file. */
  abstract read(): Promise<SecretKey | undefined>;

  /**
   * Writes `key` as the file (mode 0600, whole or not at all) unless a file
   * is there already, and answers the file's key: `key` (`created`), or the
   * one another server starting at the same time wrote first.
   */
  abstract create(
    key: SecretKey,
  ): Promise<{ readonly key: SecretKey; readonly created: boolean }>;

  /** The next key a rotation left, if any. */
  abstract readNext(): Promise<SecretKey | undefined>;

  /** Writes `key` as the next key (mode 0600), replacing one left before. */
  abstract writeNext(key: SecretKey): Promise<void>;

  /**
   * Makes `key`, the next key, the file's (one atomic rename). Done already
   * (the file holds `key`, another server finished it): nothing to do.
   * `.next` holding another key (another rotation's) is a `SecretKeyProblem`,
   * and nothing is moved.
   */
  abstract promoteNext(key: SecretKey): Promise<void>;

  /**
   * Sets the next key aside (`<file>.next.discarded.<time>.<id>`, a name
   * of its own each time), if there is one: never deleted, in case it is needed.
   */
  abstract discardNext(): Promise<void>;
}

/** Port: the cipher behind `SecretSealer` (AES-256-GCM), and making keys. */
export abstract class SecretCipher {
  /** A new key, 32 bytes from the CSPRNG. */
  abstract generateKey(): SecretKey;

  /** A sealer under `key`. */
  abstract sealer(key: SecretKey): SecretSealer;
}

/** The text the key check seals, and its context (`SecretKeyCheck`). */
// Compatibility: keeps the working name from before the product was named OpenFolia: the check stored with
// an installation's key opens to this text.
export const KEY_CHECK_TEXT = 'ccms-secret-key-check';
export const KEY_CHECK_CONTEXT = 'secret-key-check:v1';

/**
 * Port: the instance key's lock and its check in the database (#470): a
 * fixed text sealed under the key (`KEY_CHECK_TEXT`), never the key. The
 * lock (a transaction-scoped one, all servers) is held by every start
 * while it opens the key and by a rotation throughout, so neither ever
 * sees the other half done.
 */
export abstract class SecretKeyCheck {
  /** Takes the key's lock until `tx` ends, waiting for whoever holds it. */
  abstract lock(tx: Transaction): Promise<void>;
  /** The sealed check, if the database has one. */
  abstract read(tx: Transaction): Promise<string | undefined>;
  /** Writes the check (there is none yet: `read` said so under the lock). */
  abstract write(tx: Transaction, sealed: string): Promise<void>;
  /** Replaces the check with `sealed` (a rotation). */
  abstract replace(tx: Transaction, sealed: string): Promise<void>;
}

/** Every kind of sealed secret the database holds (`src/secrets/sealed-secret-sources.ts`). */
export class SealedSecretSources {
  constructor(readonly all: readonly SealedSecretSource[]) {}
}
