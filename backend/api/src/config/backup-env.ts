import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { endpointProblem } from '../backups/core/backup-endpoint.js';
import { DatabaseEnv } from './database-env.js';
import { field, flag, text, wholeNumber } from './fields.js';
import { checkSecretKeyEnv, SecretKeyEnv } from './secret-key-env.js';

const absolute = text.refine(
  (value) => isAbsolute(value),
  'must be an absolute path',
);

/**
 * The file the backup loop records each heartbeat that reached the database in, and the
 * image's health check reads (#813, `backups/repos/health-file.ts`). Unset: none.
 */
export const BackupHealthEnv = z.object({
  CCMS_BACKUP_HEALTH_FILE: field(absolute.optional()),
});

/**
 * What the backup process reads (#529, `CCMS_ROLE=backup`,
 * `backup.main.ts`): the database, the data it archives, the instance
 * secret key (to open the sealed S3 secret and backup key; never made
 * here), and the `CCMS_BACKUP_*` settings. Each of those fixes its setting
 * in Admin → Backups, read-only there; unset, the page decides
 * (`.env.example`, "Backups").
 */
export const BackupEnv = DatabaseEnv.pick({ CCMS_DATABASE_URL: true })
  .extend(SecretKeyEnv.shape)
  .extend(BackupHealthEnv.shape)
  .extend({
    CCMS_CONTENT_DIR: field(text),
    CCMS_BLOB_DRIVER: field(z.enum(['s3', 'fs']).default('fs')),
    CCMS_BLOB_FS_ROOT: field(absolute.optional()),
    /** The backup volume: local backups. */
    CCMS_BACKUP_DIR: field(absolute.default('/backups')),
    /**
     * Where a run stages its unencrypted parts (a dump, the bundle, a check's unpacked copy):
     * never inside the backup volume, which is copied off the host. Emptied at every start.
     * Default: `openfolia-backup-staging` in the system's temporary folder.
     */
    CCMS_BACKUP_STAGING_DIR: field(absolute.optional()),
    /** How often the process looks for requests and due runs (ms). */
    CCMS_BACKUP_POLL_MS: field(wholeNumber(1_000, 600_000).default(5_000)),
    /** Where throwaway databases for the check are made; default the instance's server. */
    CCMS_BACKUP_VERIFY_DATABASE_URL: field(
      DatabaseEnv.shape.CCMS_DATABASE_URL.optional(),
    ),
    CCMS_BACKUP_WARN_AFTER_HOURS: field(wholeNumber(1, 8_760).default(26)),
    CCMS_BACKUP_ENABLED: field(flag.optional()),
    CCMS_BACKUP_SCHEDULE: field(text.optional()),
    CCMS_BACKUP_TIME_ZONE: field(text.optional()),
    CCMS_BACKUP_RETENTION_DAILY: field(wholeNumber(0, 366).optional()),
    CCMS_BACKUP_RETENTION_WEEKLY: field(wholeNumber(0, 520).optional()),
    CCMS_BACKUP_RETENTION_MONTHLY: field(wholeNumber(0, 1_200).optional()),
    CCMS_BACKUP_LOCATION: field(z.enum(['local', 's3']).optional()),
    CCMS_BACKUP_LOCAL_SUBFOLDER: field(text.optional()),
    CCMS_BACKUP_S3_ENDPOINT: field(
      text
        .refine((value) => endpointProblem(value) === undefined, {
          message:
            'an http or https URL without user name, password, query or fragment, not a link-local or metadata address',
        })
        .optional(),
    ),
    /**
     * Lets the backup service connect to an S3 endpoint on a private or loopback address (an
     * S3 server on the same network, as in deploy/smoke-s3.yaml). Link-local and cloud metadata
     * addresses stay refused. Default: false.
     */
    CCMS_BACKUP_S3_ALLOW_PRIVATE: field(flag.default(false)),
    CCMS_BACKUP_S3_REGION: field(text.default('us-east-1')),
    CCMS_BACKUP_S3_BUCKET: field(text.optional()),
    CCMS_BACKUP_S3_PREFIX: field(z.string().optional()),
    CCMS_BACKUP_S3_ACCESS_KEY_ID: field(text.optional()),
    CCMS_BACKUP_S3_SECRET_ACCESS_KEY: field(text.optional()),
    CCMS_BACKUP_VERIFY: field(flag.optional()),
    CCMS_BACKUP_VERIFY_BY_DECRYPTING: field(flag.optional()),
    /** An age identity file (`age-keygen`): backups are encrypted to its recipient. */
    CCMS_BACKUP_KEY_FILE: field(absolute.optional()),
  })
  .superRefine(checkSecretKeyEnv)
  .superRefine((env, ctx) => {
    const endpoint = env.CCMS_BACKUP_S3_ENDPOINT;
    if (
      endpoint !== undefined &&
      endpointProblem(endpoint) === undefined &&
      endpointProblem(endpoint, env.CCMS_BACKUP_S3_ALLOW_PRIVATE) !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_BACKUP_S3_ENDPOINT'],
        message:
          'a private or loopback address: allowed only with CCMS_BACKUP_S3_ALLOW_PRIVATE=true',
      });
    }
    if (env.CCMS_BACKUP_LOCATION === 's3') {
      for (const name of [
        'CCMS_BACKUP_S3_BUCKET',
        'CCMS_BACKUP_S3_ACCESS_KEY_ID',
        'CCMS_BACKUP_S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (env[name] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'required with CCMS_BACKUP_LOCATION=s3',
          });
        }
      }
    }
    if (env.CCMS_BLOB_DRIVER === 'fs' && env.CCMS_BLOB_FS_ROOT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_BLOB_FS_ROOT'],
        message: 'required with CCMS_BLOB_DRIVER=fs',
      });
    }
  });
export type BackupEnv = z.infer<typeof BackupEnv>;
