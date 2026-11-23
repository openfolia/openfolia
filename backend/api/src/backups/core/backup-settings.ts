import { z } from 'zod';

/**
 * The backup settings (#529), as an admin sets them in Admin → Backups and
 * as the backup process applies them. An environment variable may fix any
 * of them (`BackupOverrides`); otherwise the page's value counts, else the
 * default here.
 */

/** How often a scheduled backup runs. */
export const Frequency = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily') }),
  z.strictObject({
    kind: z.literal('weekly'),
    /** 0 Sunday … 6 Saturday, as in cron. */
    weekday: z.number().int().min(0).max(6),
  }),
  z.strictObject({
    kind: z.literal('hours'),
    /** Every so many hours, from the set time on each day. */
    every: z.number().int().min(1).max(23),
  }),
  z.strictObject({
    kind: z.literal('cron'),
    /** Five fields (minute hour day month weekday), read in the time zone. */
    expression: z.string().trim().min(1).max(200),
  }),
]);
export type Frequency = z.infer<typeof Frequency>;

/** `HH:MM`, 24 hours. */
export const TimeOfDay = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'a time of day as HH:MM');

/** How many backups of each kind are kept (grandfather-father-son). */
export const Retention = z.strictObject({
  daily: z.number().int().min(0).max(366),
  weekly: z.number().int().min(0).max(520),
  monthly: z.number().int().min(0).max(1200),
});
export type Retention = z.infer<typeof Retention>;

/** The most characters of a local subfolder. */
export const MAX_SUBFOLDER = 200;

/** Where backups go: a folder inside the backup volume, or an S3-compatible bucket. */
export type BackupLocation =
  | { readonly kind: 'local'; readonly subfolder: string }
  | {
      readonly kind: 's3';
      readonly endpoint: string | null;
      readonly region: string;
      readonly bucket: string;
      readonly prefix: string;
      readonly accessKeyId: string;
    };

export interface BackupSettings {
  readonly enabled: boolean;
  readonly frequency: Frequency;
  /** When on each day it runs (daily, weekly, every N hours from then). */
  readonly time: string;
  /** IANA name; the time and the schedule are read in it. */
  readonly timeZone: string;
  readonly retention: Retention;
  readonly location: BackupLocation;
  /** Whether each run is checked by restoring it (default on). */
  readonly verify: boolean;
  /**
   * Whether the check decrypts the written backup (default on), which
   * needs the key's identity kept sealed on the server. Off: the server
   * keeps no identity, checks what it encrypts before encrypting it, and
   * checks the encrypted file by its size and SHA-256 only.
   */
  readonly verifyByDecrypting: boolean;
}

/** The stored settings, with whether an S3 secret key is set (never the key). */
export interface StoredBackupSettings extends BackupSettings {
  /** The S3 secret key, sealed; null when none is set. */
  readonly s3SecretSealed: string | null;
  readonly updatedAt: Date | null;
}

export const DEFAULT_RETENTION: Retention = Object.freeze({
  daily: 7,
  weekly: 4,
  monthly: 12,
});

/** What holds before anyone sets anything: off, daily at 02:00 UTC, local, verified. */
export const DEFAULT_SETTINGS: StoredBackupSettings = Object.freeze({
  enabled: false,
  frequency: Object.freeze({ kind: 'daily' }) as Frequency,
  time: '02:00',
  timeZone: 'UTC',
  retention: DEFAULT_RETENTION,
  location: Object.freeze({ kind: 'local', subfolder: '' }),
  verify: true,
  verifyByDecrypting: true,
  s3SecretSealed: null,
  updatedAt: null,
});

/** Whether `name` is a time zone this runtime knows (an IANA name, or `UTC`). */
export function isTimeZone(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** What the S3 secret key of the backup location is sealed for. */
export const S3_SECRET_CONTEXT = 'backup-s3-secret:v1';

/** What a backup key's identity is sealed for. */
export const backupIdentityContext = (keyId: string): string =>
  `backup-key:v1:${keyId}`;

/**
 * The settings an environment variable may fix, by the name the API and
 * the page use for them.
 */
export const OVERRIDABLE = [
  'enabled',
  'schedule',
  'timeZone',
  'retention.daily',
  'retention.weekly',
  'retention.monthly',
  'location',
  'verify',
  'verifyByDecrypting',
  'key',
] as const;
export type Overridable = (typeof OVERRIDABLE)[number];

/**
 * What the environment of the backup process fixes: per setting, the
 * variable, and its value (never a secret's). `schedule` covers the
 * frequency and the time (a cron expression); `location` the whole
 * location; `key` the backup key (`CCMS_BACKUP_KEY_FILE`).
 */
export type BackupOverrides = Partial<
  Record<Overridable, { readonly variable: string; readonly value?: unknown }>
>;
