import { BackupEnv } from '../../config/backup-env.js';
import { DEFAULT_SETTINGS } from '../core/backup-settings.js';
import {
  checkedOverrides,
  effectiveSettings,
  fixedBy,
} from '../core/effective-settings.js';
import {
  BackupEnvProblem,
  EnvBackupEnvironment,
  overridesOf,
} from './env-backup-environment.js';

const base = {
  CCMS_DATABASE_URL: 'postgres://u:p@db:5432/openfolia',
  CCMS_CONTENT_DIR: '/data/content.git',
  CCMS_BLOB_FS_ROOT: '/data/blobs',
};
const parse = (extra: Record<string, string>) =>
  BackupEnv.parse({ ...base, ...extra });

describe('the backup settings the environment fixes', () => {
  it('fixes nothing when no CCMS_BACKUP_* is set', () => {
    expect(overridesOf(parse({}), undefined)).toEqual({});
  });

  it('wins over the page, names its variable, and survives the trip through the heartbeat', () => {
    const env = parse({
      CCMS_BACKUP_ENABLED: 'true',
      CCMS_BACKUP_SCHEDULE: '30 1 * * *',
      CCMS_BACKUP_TIME_ZONE: 'Europe/Berlin',
      CCMS_BACKUP_RETENTION_DAILY: '3',
      CCMS_BACKUP_LOCATION: 'local',
      CCMS_BACKUP_LOCAL_SUBFOLDER: 'nightly',
    });
    const overrides = overridesOf(env, undefined);
    expect(fixedBy(overrides)).toEqual({
      enabled: 'CCMS_BACKUP_ENABLED',
      schedule: 'CCMS_BACKUP_SCHEDULE',
      timeZone: 'CCMS_BACKUP_TIME_ZONE',
      'retention.daily': 'CCMS_BACKUP_RETENTION_DAILY',
      location: 'CCMS_BACKUP_LOCATION',
    });
    const settings = effectiveSettings(
      DEFAULT_SETTINGS,
      checkedOverrides(JSON.parse(JSON.stringify(overrides))),
    );
    expect(settings).toMatchObject({
      enabled: true,
      frequency: { kind: 'cron', expression: '30 1 * * *' },
      timeZone: 'Europe/Berlin',
      retention: { daily: 3, weekly: 4, monthly: 12 },
      location: { kind: 'local', subfolder: 'nightly' },
    });
  });

  it('never puts the S3 secret into what it reports', () => {
    const env = parse({
      CCMS_BACKUP_LOCATION: 's3',
      CCMS_BACKUP_S3_BUCKET: 'b',
      CCMS_BACKUP_S3_ACCESS_KEY_ID: 'k',
      CCMS_BACKUP_S3_SECRET_ACCESS_KEY: 'env-secret-value-123',
    });
    const environment = new EnvBackupEnvironment(env, undefined, undefined);
    expect(environment.s3Secret).toBe('env-secret-value-123');
    expect(JSON.stringify(environment.overrides)).not.toContain(
      'env-secret-value-123',
    );
  });

  it('refuses a schedule, time zone or subfolder that is wrong, and S3 without its settings', () => {
    expect(() =>
      overridesOf(parse({ CCMS_BACKUP_SCHEDULE: 'nightly' }), undefined),
    ).toThrow(BackupEnvProblem);
    expect(() =>
      overridesOf(parse({ CCMS_BACKUP_TIME_ZONE: 'Nowhere/Else' }), undefined),
    ).toThrow(BackupEnvProblem);
    expect(() =>
      overridesOf(
        parse({
          CCMS_BACKUP_LOCATION: 'local',
          CCMS_BACKUP_LOCAL_SUBFOLDER: '../x',
        }),
        undefined,
      ),
    ).toThrow(BackupEnvProblem);
    expect(
      BackupEnv.safeParse({ ...base, CCMS_BACKUP_LOCATION: 's3' }).success,
    ).toBe(false);
  });

  it('drops what a heartbeat reports that is not a setting or not a backup variable', () => {
    expect(
      checkedOverrides({
        enabled: { variable: 'CCMS_BACKUP_ENABLED', value: 'yes' },
        verify: { variable: 'PATH', value: true },
        nonsense: { variable: 'CCMS_BACKUP_X', value: 1 },
      }),
    ).toEqual({});
  });
});
