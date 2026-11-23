import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import type { Actor } from '../../access/core/actor.js';
import type { Env } from '../../config/env.js';
import {
  oldPackageSendNames,
  packageSendSettings,
} from '../../config/package-send-env.js';
import {
  PackageSendSettings,
  type PackageSends,
} from '../core/package-sends.js';

const logger = new Logger('PackageSends');

/** `PackageSendSettings` from `CCMS_PACKAGE_SEND_*` (else their old `CCMS_DITA_SEND_*` names, with a warning). */
export const packageSendSettingsProvider: Provider = {
  provide: PackageSendSettings,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PackageSendSettings => {
    const env = {
      CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS: config.get(
        'CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS',
        { infer: true },
      ),
      CCMS_PACKAGE_SEND_TIMEOUT_MS: config.get('CCMS_PACKAGE_SEND_TIMEOUT_MS', {
        infer: true,
      }),
      CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND: config.get(
        'CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND',
        { infer: true },
      ),
      CCMS_PACKAGE_SENDS_PER_ACTOR: config.get('CCMS_PACKAGE_SENDS_PER_ACTOR', {
        infer: true,
      }),
      CCMS_DITA_SEND_IDLE_TIMEOUT_MS: config.get(
        'CCMS_DITA_SEND_IDLE_TIMEOUT_MS',
        { infer: true },
      ),
      CCMS_DITA_SEND_TIMEOUT_MS: config.get('CCMS_DITA_SEND_TIMEOUT_MS', {
        infer: true,
      }),
      CCMS_DITA_SEND_MIN_BYTES_PER_SECOND: config.get(
        'CCMS_DITA_SEND_MIN_BYTES_PER_SECOND',
        { infer: true },
      ),
      CCMS_DITA_SENDS_PER_ACTOR: config.get('CCMS_DITA_SENDS_PER_ACTOR', {
        infer: true,
      }),
    };
    const old = oldPackageSendNames(env);
    if (old.length > 0) {
      logger.warn(
        `${old.join(', ')}: deprecated, the old name${old.length === 1 ? '' : 's'} of the CCMS_PACKAGE_SEND* settings, which apply to every package download; rename ${old.length === 1 ? 'it' : 'them'}.`,
      );
    }
    return packageSendSettings(env);
  },
};

/** What a package route sends: its bytes, made as they are read. */
export interface PackageToSend {
  stream(): AsyncIterable<Uint8Array>;
}

/**
 * A package made, then its turn to be sent taken: `undefined` when the
 * client left while it was made (no turn is taken then), else the package
 * and the body to send. Past a bound of `sends` it throws, as 429
 * `rate-limited`, so the caller sets the file's headers only after it.
 * The body ends when the client leaves, freeing its turn, and a timeout
 * cuts the connection: no short file passes for a whole one.
 */
export async function takeSendTurn<T extends PackageToSend>(
  res: Response,
  sends: PackageSends,
  actor: Actor,
  make: () => Promise<T>,
): Promise<{ readonly made: T; readonly body: Readable } | undefined> {
  let gone = false;
  const left = () => {
    gone = true;
  };
  res.once('close', left);
  let made: T;
  try {
    made = await make();
  } finally {
    res.off('close', left);
  }
  // `res.destroyed`: a client gone before the handler ran.
  if (gone || res.destroyed) return undefined;
  const body = sends.send(actor, made.stream(), {
    onCut: () => res.destroy(),
  });
  res.once('close', () => body.destroy());
  return { made, body };
}
