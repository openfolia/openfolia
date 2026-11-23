import { z } from 'zod';
import {
  DEFAULT_SEND_IDLE_TIMEOUT_MS,
  DEFAULT_SEND_MIN_BYTES_PER_SECOND,
  DEFAULT_SEND_TIMEOUT_MS,
  DEFAULT_SENDS_PER_ACTOR,
  MAX_PACKAGE_SENDS_PER_ACTOR,
  type PackageSendSettings,
} from '../base/core/package-sends.js';
import { field, wholeNumber } from './fields.js';

const idle = () => field(wholeNumber(1_000, 3_600_000).optional());
const total = () => field(wholeNumber(1_000, 86_400_000).optional());
const pace = () => field(wholeNumber(1, 1024 * 1024 * 1024).optional());
const perActor = () =>
  field(wholeNumber(1, MAX_PACKAGE_SENDS_PER_ACTOR).optional());

/**
 * How package files (iiRDS, DITA) are sent (#654): part of `Env`. Unset
 * here, so that an old name is read in a new one's place; the defaults come
 * in `packageSendSettings`.
 */
export const PackageSendEnv = z.object({
  /** A package download no byte of which is read for this long is cut, freeing its turn (ms, 1,000 to 3,600,000, default a minute). */
  CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS: idle(),
  /** A package download still going after this long is cut (ms, 1,000 to 86,400,000, default half an hour). */
  CCMS_PACKAGE_SEND_TIMEOUT_MS: total(),
  /** A package download read more slowly than this on average, past its first idle timeout, is cut (bytes a second, default 16384). */
  CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND: pace(),
  /** How many of the server's downloads at once of one kind of package one reader may hold (1 to 3, default 1). */
  CCMS_PACKAGE_SENDS_PER_ACTOR: perActor(),
  /** The old name of `CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS` (#433), still read; deprecated. */
  CCMS_DITA_SEND_IDLE_TIMEOUT_MS: idle(),
  /** The old name of `CCMS_PACKAGE_SEND_TIMEOUT_MS` (#433), still read; deprecated. */
  CCMS_DITA_SEND_TIMEOUT_MS: total(),
  /** The old name of `CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND` (#433), still read; deprecated. */
  CCMS_DITA_SEND_MIN_BYTES_PER_SECOND: pace(),
  /** The old name of `CCMS_PACKAGE_SENDS_PER_ACTOR` (#433), still read; deprecated. */
  CCMS_DITA_SENDS_PER_ACTOR: perActor(),
});
export type PackageSendValues = z.infer<typeof PackageSendEnv>;

/** Each setting's name, its old name and its default. */
const NAMES = [
  [
    'idleTimeoutMs',
    'CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS',
    'CCMS_DITA_SEND_IDLE_TIMEOUT_MS',
    DEFAULT_SEND_IDLE_TIMEOUT_MS,
  ],
  [
    'sendTimeoutMs',
    'CCMS_PACKAGE_SEND_TIMEOUT_MS',
    'CCMS_DITA_SEND_TIMEOUT_MS',
    DEFAULT_SEND_TIMEOUT_MS,
  ],
  [
    'minBytesPerSecond',
    'CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND',
    'CCMS_DITA_SEND_MIN_BYTES_PER_SECOND',
    DEFAULT_SEND_MIN_BYTES_PER_SECOND,
  ],
  [
    'perActor',
    'CCMS_PACKAGE_SENDS_PER_ACTOR',
    'CCMS_DITA_SENDS_PER_ACTOR',
    DEFAULT_SENDS_PER_ACTOR,
  ],
] as const satisfies readonly (readonly [
  keyof PackageSendSettings,
  keyof PackageSendValues,
  keyof PackageSendValues,
  number,
])[];

/** The checks across fields, for `Env.superRefine`: an old name set beside its new one agrees with it. */
export function checkPackageSendEnv(
  env: PackageSendValues,
  ctx: z.RefinementCtx,
): void {
  for (const [, name, old] of NAMES) {
    const value = env[name];
    const oldValue = env[old];
    if (value !== undefined && oldValue !== undefined && value !== oldValue) {
      ctx.addIssue({
        code: 'custom',
        path: [old],
        message: `differs from ${name}: it is the old name of the same setting, so remove it`,
      });
    }
  }
}

/** The old names set, to warn of at start-up. */
export function oldPackageSendNames(env: PackageSendValues): string[] {
  return NAMES.filter(([, , old]) => env[old] !== undefined).map(
    ([, , old]) => old,
  );
}

/** The settings: each new name, else its old one, else its default. */
export function packageSendSettings(
  env: PackageSendValues,
): PackageSendSettings {
  const settings: Record<keyof PackageSendSettings, number> = {
    idleTimeoutMs: DEFAULT_SEND_IDLE_TIMEOUT_MS,
    sendTimeoutMs: DEFAULT_SEND_TIMEOUT_MS,
    minBytesPerSecond: DEFAULT_SEND_MIN_BYTES_PER_SECOND,
    perActor: DEFAULT_SENDS_PER_ACTOR,
  };
  for (const [key, name, old, fallback] of NAMES) {
    settings[key] = env[name] ?? env[old] ?? fallback;
  }
  return settings;
}
