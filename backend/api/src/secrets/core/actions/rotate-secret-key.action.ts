import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import {
  SecretKey,
  type SecretKeyOrigin,
  SecretKeyProblem,
} from '../secret-key.js';
import {
  KEY_CHECK_CONTEXT,
  KEY_CHECK_TEXT,
  SealedSecretSources,
  SecretCipher,
  SecretKeyCheck,
  SecretKeyFile,
} from '../secret-key-ports.js';
import { OpenSecretKeyAction } from './open-secret-key.action.js';

export interface RotatedSecretKey {
  /** Where the key was, and is: the key file now holds the new key; a variable must be changed by the operator. */
  readonly origin: SecretKeyOrigin;
  /**
   * By kind: how many sealed values were re-sealed, and how many did not
   * open with the current key (unreadable already) and were left as they were.
   */
  readonly resealed: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly unreadable: number;
  }>;
}

/**
 * Re-seals every sealed secret the database holds, and the key check,
 * under a new instance key in one transaction (#470), for
 * `rotate-secret-key.main.ts`. The transaction holds the key's lock
 * throughout (`SecretKeyCheck.lock`): a server starting meanwhile waits,
 * and so does a second rotation. The current key is opened and checked
 * in it as at start-up (never made). The new key is `next` (the
 * operator's) or, for the key file, a new one.
 *
 * For the key file the new key is written beside it first
 * (`<file>.next`), the database re-sealed, then (under the lock again)
 * the new key renamed over the file: cut off before the commit, the old
 * key still opens everything (the next start sets `.next` aside); cut off
 * after it, the next start finds that `.next` opens the check and
 * finishes the rename. Either way the key the secrets are sealed under is
 * never lost. A key from a variable is the operator's to change: `next`
 * is required, and they set it afterwards.
 *
 * A value the current key does not open was unreadable already: it is
 * left as it is and counted. Every server must be stopped meanwhile: a
 * running one still holds the old key.
 */
@Injectable()
export class RotateSecretKeyAction implements UnguardedAction {
  /** Acts for nobody: the server's rotation command, never a request. */
  readonly policy = 'internal';

  constructor(
    private readonly openKey: OpenSecretKeyAction,
    private readonly file: SecretKeyFile,
    private readonly cipher: SecretCipher,
    private readonly sources: SealedSecretSources,
    private readonly check: SecretKeyCheck,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(input: { next?: SecretKey } = {}): Promise<RotatedSecretKey> {
    // A failure leaves `.next` where it is, even when the transaction surely
    // rolled back: a commit whose answer was lost looks the same, and then
    // `.next` is the only key that opens the secrets. The next start (or
    // rotation) keeps whichever of the two opens the check.
    const rotated = await this.unit.run(async (tx) => {
      const current = await this.openKey.openIn(tx, { generate: false });
      const { origin } = current;
      if (!current.key || origin.kind === 'none') {
        throw new SecretKeyProblem(
          `There is no key to rotate: no CCMS_SECRET_KEY, and no key file at ${this.file.path}.`,
        );
      }
      if (origin.kind === 'environment' && !input.next) {
        throw new SecretKeyProblem(
          `The key is set by ${origin.variable}: set CCMS_SECRET_KEY_NEW to the new key for the rotation, then CCMS_SECRET_KEY to it once the rotation is done.`,
        );
      }
      const next = input.next ?? this.cipher.generateKey();
      if (next.equals(current.key)) {
        throw new SecretKeyProblem('The new key is the current one.');
      }
      const from = this.cipher.sealer(current.key);
      const to = this.cipher.sealer(next);
      if (origin.kind === 'file') await this.file.writeNext(next);

      const resealed: { name: string; count: number; unreadable: number }[] =
        [];
      for (const source of this.sources.all) {
        let unreadable = 0;
        const count = await source.reseal(tx, (value) => {
          let secret: string;
          try {
            secret = from.open(value.sealed, value.context);
          } catch {
            unreadable++;
            return undefined;
          }
          return to.seal(secret, value.context);
        });
        resealed.push({ name: source.name, count, unreadable });
      }
      // The check opened under the current key (`openIn` wrote it if there was none).
      await this.check.replace(tx, to.seal(KEY_CHECK_TEXT, KEY_CHECK_CONTEXT));
      return { origin, next, resealed };
    });

    if (rotated.origin.kind === 'file') {
      await this.unit.run(async (tx) => {
        await this.check.lock(tx);
        await this.file.promoteNext(rotated.next);
      });
    }
    return { origin: rotated.origin, resealed: rotated.resealed };
  }
}
