import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { BackupEnv } from '../../config/backup-env.js';
import { normalSubfolder, subfolderProblem } from '../core/backup-paths.js';
import { type BackupOverrides, isTimeZone } from '../core/backup-settings.js';
import { BackupEnvironment } from '../core/actions/run-backup.action.js';
import { scheduleProblem } from '../core/schedule.js';

/** A setting of the environment that cannot be used, named by its variable. */
export class BackupEnvProblem extends Error {}

/**
 * What the backup process's environment fixes (#529): each `CCMS_BACKUP_*`
 * setting that is set overrides the page's value, and shows read-only
 * there (the process reports them in its heartbeat; never a secret's
 * value). Precedence: the environment, then the page, then the defaults.
 */
export function overridesOf(
  env: BackupEnv,
  keyFingerprint: string | undefined,
): BackupOverrides {
  const o: BackupOverrides = {};
  if (env.CCMS_BACKUP_ENABLED !== undefined) {
    o.enabled = {
      variable: 'CCMS_BACKUP_ENABLED',
      value: env.CCMS_BACKUP_ENABLED,
    };
  }
  if (env.CCMS_BACKUP_SCHEDULE !== undefined) {
    const problem = scheduleProblem(env.CCMS_BACKUP_SCHEDULE);
    if (problem) throw new BackupEnvProblem(`CCMS_BACKUP_SCHEDULE: ${problem}`);
    o.schedule = {
      variable: 'CCMS_BACKUP_SCHEDULE',
      value: env.CCMS_BACKUP_SCHEDULE.trim().replace(/\s+/g, ' '),
    };
  }
  if (env.CCMS_BACKUP_TIME_ZONE !== undefined) {
    if (!isTimeZone(env.CCMS_BACKUP_TIME_ZONE)) {
      throw new BackupEnvProblem(
        'CCMS_BACKUP_TIME_ZONE: not a time zone (an IANA name such as Europe/Berlin).',
      );
    }
    o.timeZone = {
      variable: 'CCMS_BACKUP_TIME_ZONE',
      value: env.CCMS_BACKUP_TIME_ZONE,
    };
  }
  for (const [name, variable] of [
    ['retention.daily', 'CCMS_BACKUP_RETENTION_DAILY'],
    ['retention.weekly', 'CCMS_BACKUP_RETENTION_WEEKLY'],
    ['retention.monthly', 'CCMS_BACKUP_RETENTION_MONTHLY'],
  ] as const) {
    if (env[variable] !== undefined)
      o[name] = { variable, value: env[variable] };
  }
  if (env.CCMS_BACKUP_LOCATION === 'local') {
    const subfolder = normalSubfolder(env.CCMS_BACKUP_LOCAL_SUBFOLDER ?? '');
    const problem = subfolderProblem(subfolder);
    if (problem)
      throw new BackupEnvProblem(`CCMS_BACKUP_LOCAL_SUBFOLDER: ${problem}`);
    o.location = {
      variable: 'CCMS_BACKUP_LOCATION',
      value: { kind: 'local', subfolder },
    };
  } else if (env.CCMS_BACKUP_LOCATION === 's3') {
    o.location = {
      variable: 'CCMS_BACKUP_LOCATION',
      value: {
        kind: 's3',
        endpoint: env.CCMS_BACKUP_S3_ENDPOINT ?? null,
        region: env.CCMS_BACKUP_S3_REGION,
        bucket: env.CCMS_BACKUP_S3_BUCKET!,
        prefix: env.CCMS_BACKUP_S3_PREFIX ?? '',
        accessKeyId: env.CCMS_BACKUP_S3_ACCESS_KEY_ID!,
      },
    };
  }
  if (env.CCMS_BACKUP_VERIFY !== undefined) {
    o.verify = {
      variable: 'CCMS_BACKUP_VERIFY',
      value: env.CCMS_BACKUP_VERIFY,
    };
  }
  if (env.CCMS_BACKUP_VERIFY_BY_DECRYPTING !== undefined) {
    o.verifyByDecrypting = {
      variable: 'CCMS_BACKUP_VERIFY_BY_DECRYPTING',
      value: env.CCMS_BACKUP_VERIFY_BY_DECRYPTING,
    };
  }
  if (env.CCMS_BACKUP_KEY_FILE !== undefined) {
    o.key = {
      variable: 'CCMS_BACKUP_KEY_FILE',
      ...(keyFingerprint !== undefined && { value: keyFingerprint }),
    };
  }
  return o;
}

/** `BackupEnvironment` from the process's settings. */
export class EnvBackupEnvironment extends BackupEnvironment {
  readonly processId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  readonly overrides: BackupOverrides;
  readonly s3Secret: string | undefined;
  readonly warnAfterHours: number;

  constructor(
    env: BackupEnv,
    readonly identity: string | undefined,
    keyFingerprint: string | undefined,
  ) {
    super();
    this.overrides = overridesOf(env, keyFingerprint);
    this.s3Secret = env.CCMS_BACKUP_S3_SECRET_ACCESS_KEY;
    this.warnAfterHours = env.CCMS_BACKUP_WARN_AFTER_HOURS;
  }
}
