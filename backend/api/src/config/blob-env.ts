import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { field, flag, text } from './fields.js';

/** An `http://` or `https://` URL; the message never repeats the value. */
const endpoint = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  }, 'must be an http:// or https:// URL without credentials');

/** S3's bucket naming rules (3–63 lowercase letters, digits, dots and dashes). */
const bucket = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    'must be an S3 bucket name: 3-63 lowercase letters, digits, dots and dashes',
  );

/**
 * The blob store's settings (`BlobStore`, `src/blobs/`): part of `Env`.
 * Which fields are required depends on the driver; `checkBlobEnv` says so.
 */
export const BlobEnv = z.object({
  /** `s3` (any S3-compatible service) or `fs` (a local folder). */
  CCMS_BLOB_DRIVER: field(
    z
      .string()
      .trim()
      .pipe(z.enum(['s3', 'fs'], 'must be s3 or fs')),
  ),
  CCMS_BLOB_FS_ROOT: field(
    text
      .refine((value) => isAbsolute(value), 'must be an absolute path')
      .optional(),
  ),
  CCMS_S3_ENDPOINT: field(endpoint.optional()),
  CCMS_S3_REGION: field(text.default('us-east-1')),
  CCMS_S3_BUCKET: field(bucket.optional()),
  CCMS_S3_ACCESS_KEY_ID: field(text.optional()),
  CCMS_S3_SECRET_ACCESS_KEY: field(text.optional()),
  CCMS_S3_FORCE_PATH_STYLE: field(flag.default(false)),
});
export type BlobSettings = z.infer<typeof BlobEnv>;

/** The checks across fields, for `Env.superRefine`: what the chosen driver needs. */
export function checkBlobEnv(env: BlobSettings, ctx: z.RefinementCtx): void {
  const need = (name: keyof BlobSettings, message: string) =>
    ctx.addIssue({ code: 'custom', path: [name], message });
  if (env.CCMS_BLOB_DRIVER === 'fs' && !env.CCMS_BLOB_FS_ROOT) {
    need('CCMS_BLOB_FS_ROOT', 'is required when CCMS_BLOB_DRIVER is fs');
  }
  if (env.CCMS_BLOB_DRIVER === 's3') {
    if (!env.CCMS_S3_BUCKET) {
      need('CCMS_S3_BUCKET', 'is required when CCMS_BLOB_DRIVER is s3');
    }
    if (!env.CCMS_S3_ACCESS_KEY_ID !== !env.CCMS_S3_SECRET_ACCESS_KEY) {
      need(
        env.CCMS_S3_ACCESS_KEY_ID
          ? 'CCMS_S3_SECRET_ACCESS_KEY'
          : 'CCMS_S3_ACCESS_KEY_ID',
        'set both CCMS_S3_ACCESS_KEY_ID and CCMS_S3_SECRET_ACCESS_KEY, or neither',
      );
    }
  }
}
