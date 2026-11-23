import type { TranslatedText } from '@openfolia/ui/i18n';

import type { ApiErrorObject, Schema } from '../../api';

export type BackupSettingsResource = Schema<'BackupSettingsResource'>;
export type BackupSettings = BackupSettingsResource['attributes'];
export type BackupSettingsChanges = NonNullable<
  Schema<'UpdateBackupSettingsDocument'>['data']['attributes']
>;
export type BackupRunItem = Schema<'BackupRunResource'>;
export type BackupKeyItem = Schema<'BackupKeyResource'>;
export type BackupRequestItem = Schema<'BackupRequestResource'>;
export type BackupStatusMeta = Schema<'BackupStatusResource'>['meta'];
export type FrequencyKind = BackupSettings['frequency']['kind'];
export type LocationKind = BackupSettings['location']['kind'];

/** The history's page sizes; the first is the default. */
export const RUN_PAGE_SIZES = [10, 25, 50] as const;

/** How often a request is read again while the backup service works on it, in ms. */
export const REQUEST_POLL_MS = 2_000;

/** What to do with the S3 secret access key on save: it is never shown, only replaced or removed. */
export type SecretChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'remove' };

/** The form: every setting as the fields edit it, the S3 secret write-only. */
export interface SettingsDraft {
  readonly enabled: boolean;
  readonly frequency: FrequencyKind;
  readonly weekday: number;
  readonly every: number;
  readonly expression: string;
  readonly time: string;
  readonly timeZone: string;
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
  readonly location: LocationKind;
  readonly subfolder: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secret: SecretChange;
  readonly verify: boolean;
  readonly verifyByDecrypting: boolean;
}

/** The form's fields; each is fixed by the setting of the backup service's environment named here. */
export const FIXED_BY: Readonly<Record<keyof SettingsDraft, string>> = {
  enabled: 'enabled',
  frequency: 'schedule',
  weekday: 'schedule',
  every: 'schedule',
  expression: 'schedule',
  time: 'schedule',
  timeZone: 'timeZone',
  daily: 'retention.daily',
  weekly: 'retention.weekly',
  monthly: 'retention.monthly',
  location: 'location',
  subfolder: 'location',
  endpoint: 'location',
  region: 'location',
  bucket: 'location',
  prefix: 'location',
  accessKeyId: 'location',
  secret: 'location',
  verify: 'verify',
  verifyByDecrypting: 'verifyByDecrypting',
};

/** The variable that fixes `field`, or null: then the page sets it. */
export function fixedVariable(
  fixed: Readonly<Record<string, string>>,
  field: keyof SettingsDraft,
): string | null {
  return fixed[FIXED_BY[field]] ?? null;
}

/** The form before the settings are read: the API's defaults (never shown, never sent). */
export const EMPTY_DRAFT: SettingsDraft = {
  enabled: false,
  frequency: 'daily',
  weekday: 1,
  every: 6,
  expression: '',
  time: '02:00',
  timeZone: 'UTC',
  daily: 7,
  weekly: 4,
  monthly: 12,
  location: 'local',
  subfolder: '',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: '',
  accessKeyId: '',
  secret: { kind: 'keep' },
  verify: true,
  verifyByDecrypting: true,
};

/** The form for `settings` as saved. */
export function draftOf(settings: BackupSettings): SettingsDraft {
  const f = settings.frequency;
  const l = settings.location;
  return {
    enabled: settings.enabled,
    frequency: f.kind,
    weekday: f.kind === 'weekly' ? f.weekday : 1,
    every: f.kind === 'hours' ? f.every : 6,
    expression: f.kind === 'cron' ? f.expression : '',
    time: settings.time,
    timeZone: settings.timeZone,
    daily: settings.retention.daily,
    weekly: settings.retention.weekly,
    monthly: settings.retention.monthly,
    location: l.kind,
    subfolder: l.kind === 'local' ? l.subfolder : '',
    endpoint: l.kind === 's3' ? (l.endpoint ?? '') : '',
    region: l.kind === 's3' ? l.region : 'us-east-1',
    bucket: l.kind === 's3' ? l.bucket : '',
    prefix: l.kind === 's3' ? l.prefix : '',
    accessKeyId: l.kind === 's3' ? l.accessKeyId : '',
    secret: { kind: 'keep' },
    verify: settings.verify,
    verifyByDecrypting: settings.verifyByDecrypting,
  };
}

function frequencyOf(d: SettingsDraft): BackupSettings['frequency'] {
  switch (d.frequency) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekly':
      return { kind: 'weekly', weekday: d.weekday };
    case 'hours':
      return { kind: 'hours', every: d.every };
    case 'cron':
      return { kind: 'cron', expression: d.expression.trim() };
  }
}

function locationOf(
  d: SettingsDraft,
): NonNullable<BackupSettingsChanges['location']> {
  if (d.location === 'local') {
    return { kind: 'local', subfolder: d.subfolder.trim() };
  }
  const endpoint = d.endpoint.trim();
  return {
    kind: 's3',
    endpoint: endpoint === '' ? null : endpoint,
    region: d.region.trim(),
    bucket: d.bucket.trim(),
    prefix: d.prefix.trim(),
    accessKeyId: d.accessKeyId.trim(),
    ...(d.secret.kind === 'replace' && { secretAccessKey: d.secret.value }),
    ...(d.secret.kind === 'remove' && { secretAccessKey: null }),
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What `PATCH /backup-settings` is sent: each setting that differs from `saved`, and nothing a
 * variable fixes (the API refuses those). The location goes whole, with the secret only when it is
 * replaced or removed.
 */
export function changesOf(
  saved: BackupSettings,
  draft: SettingsDraft,
  fixed: Readonly<Record<string, string>> = {},
): BackupSettingsChanges {
  const changes: BackupSettingsChanges = {};
  const free = (field: keyof SettingsDraft) => !fixedVariable(fixed, field);
  if (free('enabled') && draft.enabled !== saved.enabled) {
    changes.enabled = draft.enabled;
  }
  const frequency = frequencyOf(draft);
  if (free('frequency') && !same(frequency, saved.frequency)) {
    changes.frequency = frequency;
  }
  if (free('time') && draft.time !== saved.time) changes.time = draft.time;
  if (free('timeZone') && draft.timeZone.trim() !== saved.timeZone) {
    changes.timeZone = draft.timeZone.trim();
  }
  const retention = {
    daily: draft.daily,
    weekly: draft.weekly,
    monthly: draft.monthly,
  };
  // Sent whole when a count the page sets changed: a count the environment fixes holds its
  // effective value here, which the API accepts unchanged.
  const retentionChanged = (['daily', 'weekly', 'monthly'] as const).some(
    (count) => free(count) && retention[count] !== saved.retention[count],
  );
  if (retentionChanged) changes.retention = retention;
  const location = locationOf(draft);
  const savedLocation =
    saved.location.kind === 's3'
      ? (({ secretAccessKeySet: _set, ...rest }) => rest)(saved.location)
      : saved.location;
  if (
    free('location') &&
    (!same({ ...location, secretAccessKey: undefined }, savedLocation) ||
      draft.secret.kind !== 'keep')
  ) {
    changes.location = location;
  }
  if (free('verify') && draft.verify !== saved.verify) {
    changes.verify = draft.verify;
  }
  if (
    free('verifyByDecrypting') &&
    draft.verifyByDecrypting !== saved.verifyByDecrypting
  ) {
    changes.verifyByDecrypting = draft.verifyByDecrypting;
  }
  return changes;
}

/**
 * The form after the settings were read again while it had unsaved edits: each field edited
 * (it differs from `base`, the form of the settings it was edited from) stays as edited, every
 * other field takes its value from `next` (another admin's change, say).
 */
export function rebaseDraft(
  base: SettingsDraft,
  edited: SettingsDraft,
  next: SettingsDraft,
): SettingsDraft {
  const out: Record<string, unknown> = { ...next };
  for (const key of Object.keys(edited) as (keyof SettingsDraft)[]) {
    if (!same(edited[key], base[key])) out[key] = edited[key];
  }
  return out as unknown as SettingsDraft;
}

/** The form field an error object points at (`source.pointer`), or null. */
export function fieldOfError(
  error: ApiErrorObject,
): keyof SettingsDraft | null {
  const pointer = error.source?.pointer ?? '';
  const path = pointer.replace(/^\/data\/attributes\/?/, '');
  if (path === pointer) return null;
  const known: Readonly<Record<string, keyof SettingsDraft>> = {
    enabled: 'enabled',
    frequency: 'frequency',
    'frequency/expression': 'expression',
    'frequency/every': 'every',
    'frequency/weekday': 'weekday',
    time: 'time',
    timeZone: 'timeZone',
    retention: 'daily',
    'retention/daily': 'daily',
    'retention/weekly': 'weekly',
    'retention/monthly': 'monthly',
    location: 'location',
    'location/subfolder': 'subfolder',
    'location/endpoint': 'endpoint',
    'location/region': 'region',
    'location/bucket': 'bucket',
    'location/prefix': 'prefix',
    'location/accessKeyId': 'accessKeyId',
    'location/secretAccessKey': 'secret',
    verify: 'verify',
    verifyByDecrypting: 'verifyByDecrypting',
  };
  return known[path] ?? null;
}

/** The refusals the backup screen words itself; anything else says the API's own words. */
const CODES: Readonly<Record<string, string>> = {
  'backup-path-outside-volume': 'editor.admin.backups.errors.outsideVolume',
  'invalid-schedule': 'editor.admin.backups.errors.schedule',
  'invalid-time-zone': 'editor.admin.backups.errors.timeZone',
  'invalid-endpoint': 'editor.admin.backups.errors.endpoint',
  'invalid-bucket': 'editor.admin.backups.errors.bucket',
  'invalid-prefix': 'editor.admin.backups.errors.prefix',
  'secret-required': 'editor.admin.backups.errors.secretRequired',
  'backup-identity-missing': 'editor.admin.backups.errors.identityMissing',
  'backup-setting-fixed-by-environment': 'editor.admin.backups.errors.fixed',
  'backup-service-not-running': 'editor.admin.backups.errors.serviceDown',
  'backup-key-missing': 'editor.admin.backups.errors.keyMissing',
  'backup-key-exists': 'editor.admin.backups.errors.keyExists',
};

/** An error object in words, or null when the screen has no words of its own for it. */
export function backupErrorText(error: ApiErrorObject): TranslatedText | null {
  const key = CODES[error.code ?? ''];
  return key ? { key, params: { ...(error.meta ?? {}) } } : null;
}

/** The reasons a run failed, in words (`error`); `errorDetail` says the rest. */
export const RUN_ERRORS: Readonly<Record<string, string>> = {
  'backup-key-missing': 'editor.admin.backups.runErrors.keyMissing',
  'location-unavailable': 'editor.admin.backups.runErrors.location',
  'database-dump-failed': 'editor.admin.backups.runErrors.dump',
  'archive-failed': 'editor.admin.backups.runErrors.archive',
  'encrypt-failed': 'editor.admin.backups.runErrors.encrypt',
  'upload-failed': 'editor.admin.backups.runErrors.upload',
  'verify-failed': 'editor.admin.backups.runErrors.verify',
  interrupted: 'editor.admin.backups.runErrors.interrupted',
  failed: 'editor.admin.backups.runErrors.failed',
};

/** What the status card says, and how loud. */
export interface StatusSummary {
  readonly tone: 'ok' | 'warning' | 'destructive' | 'muted';
  readonly title: TranslatedText;
  readonly detail: TranslatedText | null;
}

/** `ms` as a relative time in `locale` ("6 hours ago"), rounded to the largest whole unit. */
export function ago(ms: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(ms / 3_600_000);
  if (Math.abs(hours) < 48) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(ms / 86_400_000), 'day');
}

/** The admin overview's line: "Last backup: 6 hours ago, verified", or why not. */
export function statusSummary(
  status: BackupStatusMeta,
  now: Date,
  locale: string,
): StatusSummary {
  const good = status.lastGoodRun;
  const last = good
    ? {
        key: good.attributes.verified
          ? 'editor.admin.backups.status.lastVerified'
          : 'editor.admin.backups.status.lastUnverified',
        params: {
          ago: ago(
            now.getTime() -
              Date.parse(
                good.attributes.finishedAt ?? good.attributes.startedAt,
              ),
            locale,
          ),
        },
      }
    : null;
  switch (status.warning) {
    case 'not-set-up':
      return {
        tone: 'muted',
        title: { key: 'editor.admin.backups.status.notSetUp' },
        detail: { key: 'editor.admin.backups.status.notSetUpDetail' },
      };
    case 'service-not-running':
      return {
        tone: 'warning',
        title: { key: 'editor.admin.backups.status.serviceDown' },
        detail: last ?? { key: 'editor.admin.backups.status.never' },
      };
    case 'failed':
      return {
        tone: 'destructive',
        title: { key: 'editor.admin.backups.status.failed' },
        detail: last ?? { key: 'editor.admin.backups.status.never' },
      };
    case 'overdue':
      return {
        tone: 'warning',
        title: last
          ? { key: 'editor.admin.backups.status.overdue', params: last.params }
          : { key: 'editor.admin.backups.status.never' },
        detail: {
          key: last
            ? 'editor.admin.backups.status.overdueDetail'
            : 'editor.admin.backups.status.neverOverdueDetail',
          params: { hours: status.warnAfterHours },
        },
      };
    default:
      return {
        tone: 'ok',
        title: last ?? { key: 'editor.admin.backups.status.never' },
        detail: null,
      };
  }
}

/** How long a run took, in `locale` ("2 min 5 s"), or null while it runs. */
export function durationOf(run: BackupRunItem): number | null {
  const { startedAt, finishedAt } = run.attributes;
  return finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
}

export function formatDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const unit = (value: number, unit: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
    }).format(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${unit(h, 'hour')} ${unit(m, 'minute')}`;
  if (m > 0) return `${unit(m, 'minute')} ${unit(s, 'second')}`;
  return unit(s, 'second');
}

/** The file "Download" saves: the age identity, with comments `age` and the restore skip. */
export function keyFileText(
  identity: string,
  fingerprint: string,
  createdAt: string,
): string {
  return [
    '# OpenFolia backup key: restore needs it (docker compose run --rm -T restore <name> --key-file - < this file).',
    `# Fingerprint: ${fingerprint}`,
    `# Created: ${createdAt}`,
    '# Keep it apart from the server. Anyone holding it can read every backup made with it.',
    identity,
    '',
  ].join('\n');
}

/** The download's file name: the fingerprint, so several keys stay apart. */
export const keyFileName = (fingerprint: string): string =>
  `openfolia-backup-key-${fingerprint}.txt`;

/** The weekdays as cron numbers them (0 Sunday), in the order a week is shown (Monday first). */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** A weekday's name in `locale` (cron's 0 is Sunday). */
export function weekdayName(day: number, locale: string): string {
  // 2026-11-22 is a Sunday.
  const date = new Date(Date.UTC(2026, 10, 22 + day, 12));
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(date);
}

/** The time zones this browser knows, for the field's suggestions; UTC first. */
export function timeZones(): readonly string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
  return ['UTC', ...known.filter((z) => z !== 'UTC')];
}
