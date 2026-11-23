import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import type { SealedValue } from '../../../base/core/secret-sealer.js';
import {
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
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
  SecretKeySettings,
} from '../secret-key-ports.js';

/** How many stored values of each kind the start tries, when the database has no key check yet. */
export const CHECK_SAMPLE = 5;

export interface OpenedSecretKey {
  /** Undefined only for `origin.kind === 'none'`. */
  readonly key: SecretKey | undefined;
  readonly origin: SecretKeyOrigin;
  /** The key file held a rotation's next key, which opened the stored secrets: it is the file's now. */
  readonly finishedRotation: boolean;
}

const GENERATE_HINT =
  'restore the key file from a backup, or set CCMS_SECRET_KEY to the key the secrets were sealed with';

/**
 * Finds the instance secret key (#470) and checks it against the
 * database before anything is sealed or opened:
 *
 * 1. `CCMS_SECRET_KEY` (or its old name, `CCMS_WEBHOOKS_SECRET_KEY`) when set;
 * 2. else the key file, when there is one;
 * 3. else, with generation on (`CCMS_SECRET_KEY_GENERATE`, the default),
 *    a new key, written as the key file only once the database is seen to
 *    hold nothing sealed (a new key could not open it);
 * 4. else none: nothing can be sealed (webhooks answer `not-configured`).
 *
 * **The key check** (`SecretKeyCheck`): a fixed text sealed under the key,
 * written by the first start that has one. A later start must open it, so
 * a lost key file, another key set, or a second server that made a key of
 * its own (no shared key file) is a `SecretKeyProblem` and the server does
 * not start, rather than seal secrets under a key that cannot open the
 * others. A database from before the check is judged by its sealed values
 * (one of a few tried must open), then gets its check.
 *
 * All of it runs in one transaction under the key's lock, which a rotation
 * holds throughout too: a server starting meanwhile waits for it. A
 * rotation cut off after re-sealing but before its key replaced the file
 * is finished here (`finishedRotation`); one cut off before its commit
 * has its next key set aside (never deleted while it could be needed).
 */
@Injectable()
export class OpenSecretKeyAction implements UnguardedAction {
  /** Acts for nobody: the server's start-up, never a request. */
  readonly policy = 'internal';

  constructor(
    private readonly settings: SecretKeySettings,
    private readonly file: SecretKeyFile,
    private readonly cipher: SecretCipher,
    private readonly sources: SealedSecretSources,
    private readonly check: SecretKeyCheck,
    private readonly unit: UnitOfWork,
  ) {}

  /** `generate: false`: never makes a key (the rotation's command). */
  handle(options: { generate?: boolean } = {}): Promise<OpenedSecretKey> {
    return this.unit.run((tx) => this.openIn(tx, options));
  }

  /** The same within `tx` (the rotation's), taking the key's lock for the rest of it. */
  async openIn(
    tx: Transaction,
    options: { generate?: boolean } = {},
  ): Promise<OpenedSecretKey> {
    await this.check.lock(tx);
    const stored = await this.check.read(tx);
    const samples: SealedValue[] = [];
    if (stored === undefined) {
      for (const source of this.sources.all) {
        samples.push(...(await source.sample(tx, CHECK_SAMPLE)));
      }
    }
    const holdsSecrets = stored !== undefined || samples.length > 0;
    const opens = (key: SecretKey) =>
      stored !== undefined
        ? this.opensAny(key, [{ sealed: stored, context: KEY_CHECK_CONTEXT }])
        : samples.length === 0 || this.opensAny(key, samples);

    const opened = await this.choose(holdsSecrets, opens, options);
    if (opened.key && stored === undefined) {
      await this.check.write(
        tx,
        this.cipher.sealer(opened.key).seal(KEY_CHECK_TEXT, KEY_CHECK_CONTEXT),
      );
    }
    return opened;
  }

  private async choose(
    holdsSecrets: boolean,
    opens: (key: SecretKey) => boolean,
    options: { generate?: boolean },
  ): Promise<OpenedSecretKey> {
    const configured = this.settings.configured;
    if (configured) {
      if (!opens(configured.key)) {
        throw new SecretKeyProblem(
          `${configured.variable} does not open the secrets the database holds (sealed under another key): set it to the key they were sealed with.`,
        );
      }
      return {
        key: configured.key,
        origin: { kind: 'environment', variable: configured.variable },
        finishedRotation: false,
      };
    }

    const path = this.file.path;
    const inFile = await this.file.read();
    if (inFile) {
      const next = await this.file.readNext();
      if (next && holdsSecrets && opens(next)) {
        if (opens(inFile)) {
          throw new SecretKeyProblem(
            `Some stored secrets open with the key file ${path} and some with the next key a rotation left (${path}.next): a server sealed secrets while the rotation ran (every server must be stopped for one). Keep both files, and restore the database from before the rotation.`,
          );
        }
        await this.file.promoteNext(next);
        return {
          key: next,
          origin: { kind: 'file', path, created: false },
          finishedRotation: true,
        };
      }
      if (!opens(inFile)) {
        // `.next` stays where it is: it may be the key of this database's backup.
        throw new SecretKeyProblem(
          `The key file ${path} does not open the secrets the database holds (sealed under another key): ${GENERATE_HINT}.`,
        );
      }
      // A rotation cut off before its commit: the key file opens everything, `.next` nothing.
      if (next) await this.file.discardNext();
      return {
        key: inFile,
        origin: { kind: 'file', path, created: false },
        finishedRotation: false,
      };
    }

    if (holdsSecrets) {
      throw new SecretKeyProblem(
        `The database holds sealed secrets (or the check of the key they are sealed under), but there is no key to open them: no CCMS_SECRET_KEY, and no key file at ${path}. A new key would not open them, so none is made: ${GENERATE_HINT}. Several servers need the same key: set CCMS_SECRET_KEY on each, or share the key file.`,
      );
    }
    if (!(options.generate ?? true) || !this.settings.generate) {
      return {
        key: undefined,
        origin: { kind: 'none' },
        finishedRotation: false,
      };
    }
    const written = await this.file.create(this.cipher.generateKey());
    return {
      key: written.key,
      origin: { kind: 'file', path, created: written.created },
      finishedRotation: false,
    };
  }

  private opensAny(key: SecretKey, samples: readonly SealedValue[]): boolean {
    const sealer = this.cipher.sealer(key);
    return samples.some((value) => {
      try {
        sealer.open(value.sealed, value.context);
        return true;
      } catch {
        return false;
      }
    });
  }
}
