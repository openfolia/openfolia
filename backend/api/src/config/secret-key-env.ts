import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { field, flag, text } from './fields.js';

/**
 * The key file's name, in the folder that holds the content repository (`defaultSecretKeyFile`).
 * Compatibility: keeps the working name from before the product was named OpenFolia: an
 * installation's key is already at this path, and a new name would make a new key.
 */
export const SECRET_KEY_FILE_NAME = 'ccms-secret.key';

/**
 * 32 bytes, as base64 (44 characters, or 43 without the padding; base64url
 * too) or hex (64 digits). The message never repeats the value.
 */
export const secretKeyBytes = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const bytes = parseSecretKey(value);
    if (!bytes) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be 32 bytes as base64 or 64 hex digits',
      });
      return z.NEVER;
    }
    return bytes;
  });

/** The 32 bytes `value` spells (base64, base64url or hex), or undefined. */
export function parseSecretKey(value: string): Buffer | undefined {
  const trimmed = value.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : /^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)
      ? Buffer.from(
          trimmed,
          trimmed.includes('-') || trimmed.includes('_')
            ? 'base64url'
            : 'base64',
        )
      : undefined;
  return bytes?.length === 32 ? bytes : undefined;
}

/**
 * The instance secret key's settings (#470): part of `Env`. The key seals
 * every secret the instance stores (webhook signing secrets, later header
 * and client secrets); it is never stored in the database.
 */
export const SecretKeyEnv = z.object({
  /** The key, set by the operator (32 bytes as base64 or hex). Unset: the key file. Never logged. */
  CCMS_SECRET_KEY: field(secretKeyBytes.optional()),
  /** The old name of `CCMS_SECRET_KEY` (#42), still read; deprecated. */
  CCMS_WEBHOOKS_SECRET_KEY: field(secretKeyBytes.optional()),
  /** Where the key is kept when no variable sets it (default: `defaultSecretKeyFile`). */
  CCMS_SECRET_KEY_FILE: field(
    text
      .refine((value) => isAbsolute(value), 'must be an absolute path')
      .optional(),
  ),
  /** Whether the API makes the key file on its first start when there is none (default true). */
  CCMS_SECRET_KEY_GENERATE: field(flag.default(true)),
});
export type SecretKeySettings = z.infer<typeof SecretKeyEnv>;

/**
 * The default key file: `ccms-secret.key` in the folder that holds the
 * content repository (`CCMS_CONTENT_DIR`). That folder is the one local,
 * writable place every installation has, whichever blob store it uses (the
 * blob folder exists only with `CCMS_BLOB_DRIVER=fs`), and the one already
 * backed up with the content; beside the repository, not in it, so Git
 * never carries the key with a clone or a push.
 */
export function defaultSecretKeyFile(contentDir: string): string {
  return join(dirname(resolve(contentDir)), SECRET_KEY_FILE_NAME);
}

/** The checks across fields, for `Env.superRefine`: the old name agrees with the new one. */
export function checkSecretKeyEnv(
  env: SecretKeySettings,
  ctx: z.RefinementCtx,
): void {
  const { CCMS_SECRET_KEY: key, CCMS_WEBHOOKS_SECRET_KEY: old } = env;
  if (key && old && !key.equals(old)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_WEBHOOKS_SECRET_KEY'],
      message:
        'differs from CCMS_SECRET_KEY: it is the old name of the same key, so remove it',
    });
  }
}
