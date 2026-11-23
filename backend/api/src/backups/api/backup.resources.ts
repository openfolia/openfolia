import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type {
  BackupKeyView,
  BackupSettingsView,
  BackupStatus,
  MadeBackupKey,
} from '../core/actions/manage-backups.action.js';
import type { BackupKey } from '../core/backup-ports.js';
import {
  BACKUP_ERRORS,
  type BackupRequest,
  type BackupRun,
} from '../core/backup-run.js';
import { Frequency, Retention, TimeOfDay } from '../core/backup-settings.js';

const Time = z.iso.datetime({ offset: true });
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

const LocalLocation = z.object({
  kind: z.literal('local'),
  subfolder: z
    .string()
    .describe(
      'A folder inside the backup volume (`/backups` in the backup service), `/`-separated; empty for the volume itself. Never an absolute path or `..`.',
    ),
});

const S3Location = z.object({
  kind: z.literal('s3'),
  endpoint: z
    .string()
    .nullable()
    .describe(
      'The S3-compatible service’s URL (http or https); null for AWS itself. With an endpoint, path-style addresses are used.',
    ),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string().describe('Prepended to every object name; may be empty.'),
  accessKeyId: z.string(),
  secretAccessKeySet: z
    .boolean()
    .describe(
      'Whether a secret key is set. The key itself is never answered: replace it, or remove it.',
    ),
});

const FrequencySchema = Frequency.describe(
  '`daily`; `weekly` with `weekday` (0 Sunday … 6 Saturday); `hours` with `every` (1–23, from the set time each day); or `cron` with a five-field `expression` (minute hour day month weekday), read in the time zone.',
);

export const BackupSettingsResource = resourceObject('BackupSettings', {
  attributes: z.object({
    enabled: z.boolean().describe('Whether scheduled backups run.'),
    frequency: FrequencySchema,
    time: TimeOfDay.describe('The time of day (HH:MM) in `timeZone`.'),
    timeZone: z
      .string()
      .describe('The instance’s time zone for backups (an IANA name).'),
    retention: Retention.describe(
      'How many daily, weekly and monthly backups are kept (the newest of each day, ISO week and month); the newest backup is always kept.',
    ),
    location: z.discriminatedUnion('kind', [LocalLocation, S3Location]),
    verify: z
      .boolean()
      .describe(
        'Whether each run is checked: the dump restored into a throwaway database (migrations and row counts), `git fsck` on the content, the blob hashes.',
      ),
    verifyByDecrypting: z
      .boolean()
      .describe(
        'Whether the check decrypts the written backup, which needs the key’s identity kept sealed on the server. Off: the server keeps no identity and checks what it encrypts before encrypting it, the encrypted file by its size and SHA-256.',
      ),
  }),
  meta: z.object({
    fixed: z
      .record(z.string(), z.string())
      .describe(
        'Per setting the backup service’s environment fixes (`enabled`, `schedule` for the frequency and time, `timeZone`, `retention.daily` …, `location`, `verify`, `verifyByDecrypting`, `key`), the variable fixing it. Those are read-only here (409 `backup-setting-fixed-by-environment`).',
      ),
    schedule: z.string().describe('The cron expression in force.'),
    nextRuns: z
      .array(Time)
      .describe('The next three scheduled runs; none while backups are off.'),
    service: z.object({
      running: z
        .boolean()
        .describe(
          'Whether the backup process sent a heartbeat in the last minute.',
        ),
      lastSeenAt: Time.nullable(),
    }),
    key: z
      .object({
        fingerprint: z.string(),
        recipient: z
          .string()
          .nullable()
          .describe('The age recipient backups are encrypted to (public).'),
        createdAt: Time.nullable(),
        identityKept: z
          .boolean()
          .describe(
            'Whether the server keeps the identity sealed, to verify by decrypting.',
          ),
        fixedBy: z
          .string()
          .nullable()
          .describe(
            'The variable setting the key, when the environment does (`CCMS_BACKUP_KEY_FILE`).',
          ),
      })
      .nullable()
      .describe(
        'The key in force; null until one is made. Never its identity.',
      ),
    updatedAt: Time.nullable(),
  }),
})
  .describe(
    'The instance’s backup settings (#529), as the page sets them and with what the backup service’s environment fixes in their place.',
  )
  .meta({ id: 'BackupSettingsResource' });

export const BackupSettingsDocument = singleDocument(
  BackupSettingsResource,
).meta({
  id: 'BackupSettingsDocument',
});

const keyMeta = (key: BackupKeyView) => ({
  fingerprint: key.fingerprint,
  recipient: key.recipient,
  createdAt: iso(key.createdAt),
  identityKept: key.identityKept,
  fixedBy: key.fixedBy,
});

export function toBackupSettingsResource(
  view: BackupSettingsView,
): z.infer<typeof BackupSettingsResource> {
  const { settings } = view;
  return {
    type: 'BackupSettings',
    id: 'instance',
    attributes: {
      enabled: settings.enabled,
      frequency: settings.frequency,
      time: settings.time,
      timeZone: settings.timeZone,
      retention: settings.retention,
      location:
        settings.location.kind === 's3'
          ? { ...settings.location, secretAccessKeySet: view.s3SecretSet }
          : settings.location,
      verify: settings.verify,
      verifyByDecrypting: settings.verifyByDecrypting,
    },
    meta: {
      fixed: { ...view.fixed },
      schedule: view.schedule,
      nextRuns: view.nextRuns.map((d) => d.toISOString()),
      service: {
        running: view.service.running,
        lastSeenAt: iso(view.service.lastSeenAt),
      },
      key: view.key ? keyMeta(view.key) : null,
      updatedAt: iso(view.updatedAt),
    },
  };
}

const LocationChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local'), subfolder: z.string().max(400) }),
  z.strictObject({
    kind: z.literal('s3'),
    endpoint: z.string().max(500).nullable(),
    region: z.string().trim().min(1).max(100),
    bucket: z.string().max(100),
    prefix: z.string().max(600).default(''),
    accessKeyId: z.string().trim().min(1).max(200),
    secretAccessKey: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .optional()
      .describe(
        'Write-only: a value sets or replaces it, null removes it, left out keeps it (only for the same endpoint, bucket and access key: 422 `secret-required` otherwise).',
      ),
  }),
]);

export const UpdateBackupSettingsDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('BackupSettings'),
      id: z.literal('instance'),
      attributes: z
        .strictObject({
          enabled: z.boolean().optional(),
          frequency: Frequency.optional(),
          time: TimeOfDay.optional(),
          timeZone: z.string().max(64).optional(),
          retention: Retention.optional(),
          location: LocationChange.optional(),
          verify: z.boolean().optional(),
          verifyByDecrypting: z.boolean().optional(),
        })
        .optional(),
    }),
  })
  .meta({ id: 'UpdateBackupSettingsDocument' });
export type UpdateBackupSettingsDocument = z.output<
  typeof UpdateBackupSettingsDocument
>;

export const BackupRunResource = resourceObject('BackupRun', {
  attributes: z.object({
    trigger: z.enum(['schedule', 'manual', 'command']),
    status: z.enum(['running', 'succeeded', 'failed']),
    scheduledFor: Time.nullable(),
    startedAt: Time,
    finishedAt: Time.nullable(),
    sizeBytes: z
      .number()
      .int()
      .nullable()
      .describe('The encrypted file’s size.'),
    sha256: z
      .string()
      .nullable()
      .describe('The encrypted file’s SHA-256 (hex).'),
    location: z
      .string()
      .nullable()
      .describe(
        '`local:<subfolder>` or `s3:<bucket>/<prefix>`; never a credential.',
      ),
    name: z.string().nullable().describe('Its file or object name there.'),
    keyFingerprint: z
      .string()
      .nullable()
      .describe(
        'The fingerprint of the key it was encrypted to: restoring it needs that key.',
      ),
    verified: z
      .boolean()
      .nullable()
      .describe(
        'True: checked and good; false: the check failed; null: not checked.',
      ),
    verifyMode: z.enum(['decrypted', 'before-encryption']).nullable(),
    error: z.enum(BACKUP_ERRORS).nullable(),
    errorDetail: z
      .string()
      .nullable()
      .describe('The exact error, for an operator.'),
  }),
})
  .describe('A backup run (#529).')
  .meta({ id: 'BackupRunResource' });

export const BackupRunPageDocument = pagedDocument(BackupRunResource).meta({
  id: 'BackupRunPageDocument',
});

export function toBackupRunResource(
  run: BackupRun,
): z.infer<typeof BackupRunResource> {
  return {
    type: 'BackupRun',
    id: run.id,
    attributes: {
      trigger: run.trigger,
      status: run.status,
      scheduledFor: iso(run.scheduledFor),
      startedAt: run.startedAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      sizeBytes: run.sizeBytes,
      sha256: run.sha256,
      location: run.location,
      name: run.name,
      keyFingerprint: run.keyFingerprint,
      verified: run.verified,
      verifyMode: run.verifyMode,
      error: run.error,
      errorDetail: run.errorDetail,
    },
  };
}

export const BackupKeyResource = resourceObject('BackupKey', {
  attributes: z.object({
    fingerprint: z.string(),
    recipient: z.string().describe('The age recipient (public).'),
    createdAt: Time,
    retiredAt: Time.nullable().describe(
      'When a rotation replaced it; null for the current key.',
    ),
  }),
  meta: z.object({
    identityKept: z
      .boolean()
      .describe('Whether the server keeps its identity sealed.'),
  }),
})
  .describe('A backup key, by fingerprint; never its identity.')
  .meta({ id: 'BackupKeyResource' });

export const BackupKeyPageDocument = pagedDocument(BackupKeyResource).meta({
  id: 'BackupKeyPageDocument',
});

export function toBackupKeyResource(
  key: BackupKey,
): z.infer<typeof BackupKeyResource> {
  return {
    type: 'BackupKey',
    id: key.id,
    attributes: {
      fingerprint: key.fingerprint,
      recipient: key.recipient,
      createdAt: key.createdAt.toISOString(),
      retiredAt: iso(key.retiredAt),
    },
    meta: { identityKept: key.identitySealed !== null },
  };
}

export const CreateBackupKeyDocument = z
  .strictObject({
    meta: z
      .strictObject({
        rotate: z
          .boolean()
          .optional()
          .describe('True to replace the current key (an explicit rotation).'),
      })
      .optional(),
  })
  .meta({ id: 'CreateBackupKeyDocument' });
export type CreateBackupKeyDocument = z.output<typeof CreateBackupKeyDocument>;

export const MadeBackupKeyDocument = z
  .object({
    data: z.object({
      type: z.literal('BackupKey'),
      id: z.literal('current'),
      attributes: z.object({
        fingerprint: z.string(),
        recipient: z.string(),
        createdAt: Time,
      }),
    }),
    meta: z.object({
      identity: z
        .string()
        .describe(
          'The key’s identity (`AGE-SECRET-KEY-1…`), shown only in this answer. Without it no backup can be restored: download or copy it now and keep it away from the backups.',
        ),
      rotated: z.boolean(),
      identityKept: z.boolean(),
    }),
  })
  .meta({ id: 'MadeBackupKeyDocument' });

export function toMadeBackupKeyDocument(
  made: MadeBackupKey,
): z.infer<typeof MadeBackupKeyDocument> {
  return {
    data: {
      type: 'BackupKey',
      id: 'current',
      attributes: {
        fingerprint: made.key.fingerprint,
        recipient: made.key.recipient ?? '',
        createdAt: (made.key.createdAt ?? new Date()).toISOString(),
      },
    },
    meta: {
      identity: made.identity,
      rotated: made.rotated,
      identityKept: made.key.identityKept,
    },
  };
}

export const BackupRequestResource = resourceObject('BackupRequest', {
  attributes: z.object({
    kind: z.enum(['run', 'test-location']),
    status: z
      .enum(['pending', 'running', 'done', 'failed'])
      .describe(
        '`pending` until the backup process takes it (within seconds).',
      ),
    createdAt: Time,
    finishedAt: Time.nullable(),
    runId: z.string().nullable().describe('The run it started (`run`).'),
    error: z
      .string()
      .nullable()
      .describe(
        '`location-test-failed`, `backup-running`, `interrupted`, or the run’s error code.',
      ),
    errorDetail: z.string().nullable().describe('The exact error.'),
  }),
})
  .describe(
    'A request to the backup process: back up now, or test the location.',
  )
  .meta({ id: 'BackupRequestResource' });

export const BackupRequestDocument = singleDocument(BackupRequestResource).meta(
  {
    id: 'BackupRequestDocument',
  },
);

export const CreateBackupRequestDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('BackupRequest'),
      attributes: z.strictObject({ kind: z.enum(['run', 'test-location']) }),
    }),
  })
  .meta({ id: 'CreateBackupRequestDocument' });
export type CreateBackupRequestDocument = z.output<
  typeof CreateBackupRequestDocument
>;

export function toBackupRequestResource(
  request: BackupRequest,
): z.infer<typeof BackupRequestResource> {
  return {
    type: 'BackupRequest',
    id: request.id,
    attributes: {
      kind: request.kind,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
      finishedAt: iso(request.finishedAt),
      runId: request.runId,
      error: request.error,
      errorDetail: request.errorDetail,
    },
  };
}

export const BackupStatusResource = resourceObject('BackupStatus', {
  attributes: z.object({}),
  meta: z.object({
    enabled: z.boolean(),
    keySet: z.boolean(),
    service: z.object({ running: z.boolean(), lastSeenAt: Time.nullable() }),
    lastRun: BackupRunResource.nullable(),
    lastGoodRun: BackupRunResource.nullable().describe(
      'The newest run that succeeded and whose check did not fail.',
    ),
    warning: z
      .enum(['not-set-up', 'service-not-running', 'failed', 'overdue'])
      .nullable()
      .describe(
        '`not-set-up`: off or without a key; `service-not-running`: no heartbeat from the backup process; `failed`: the last run failed; `overdue`: no good backup for longer than `warnAfterHours`. Null: all well.',
      ),
    warnAfterHours: z.number().int(),
  }),
})
  .describe('Whether the instance is backed up, for the admin overview (#529).')
  .meta({ id: 'BackupStatusResource' });

export const BackupStatusDocument = singleDocument(BackupStatusResource).meta({
  id: 'BackupStatusDocument',
});

export function toBackupStatusResource(
  status: BackupStatus,
): z.infer<typeof BackupStatusResource> {
  return {
    type: 'BackupStatus',
    id: 'instance',
    attributes: {},
    meta: {
      enabled: status.enabled,
      keySet: status.keySet,
      service: {
        running: status.service.running,
        lastSeenAt: iso(status.service.lastSeenAt),
      },
      lastRun: status.lastRun ? toBackupRunResource(status.lastRun) : null,
      lastGoodRun: status.lastGoodRun
        ? toBackupRunResource(status.lastGoodRun)
        : null,
      warning: status.warning,
      warnAfterHours: status.warnAfterHours,
    },
  };
}
