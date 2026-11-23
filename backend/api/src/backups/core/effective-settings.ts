import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type BackupLocation,
  type BackupOverrides,
  type BackupSettings,
  isTimeZone,
  OVERRIDABLE,
  type Overridable,
  Retention,
} from './backup-settings.js';
import { scheduleProblem } from './schedule.js';

/** A key's fingerprint: the first 16 hex digits of its recipient's SHA-256, in groups of four. */
export function fingerprintOf(recipient: string): string {
  const hex = createHash('sha256').update(recipient).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)!.join('-');
}

const LocationValue: z.ZodType<BackupLocation> = z.union([
  z.strictObject({ kind: z.literal('local'), subfolder: z.string().max(200) }),
  z.strictObject({
    kind: z.literal('s3'),
    endpoint: z.string().max(500).nullable(),
    region: z.string().max(100),
    bucket: z.string().max(100),
    prefix: z.string().max(500),
    accessKeyId: z.string().max(200),
  }),
]);

/** The value an override may carry, per setting; anything else is ignored. */
const VALUES: Record<Overridable, z.ZodType> = {
  enabled: z.boolean(),
  schedule: z
    .string()
    .refine((s) => scheduleProblem(s) === undefined, 'a schedule'),
  timeZone: z.string().refine(isTimeZone, 'a time zone'),
  'retention.daily': Retention.shape.daily,
  'retention.weekly': Retention.shape.weekly,
  'retention.monthly': Retention.shape.monthly,
  location: LocationValue,
  verify: z.boolean(),
  verifyByDecrypting: z.boolean(),
  key: z.string().optional(),
};

const Variable = z.string().regex(/^CCMS_BACKUP_[A-Z0-9_]+$/);

/**
 * The overrides as the backup process reported them, checked: an entry
 * with an unknown setting, a variable not named `CCMS_BACKUP_*` or a value
 * of the wrong shape is dropped, so a stored heartbeat never makes the
 * settings malformed.
 */
export function checkedOverrides(reported: unknown): BackupOverrides {
  if (typeof reported !== 'object' || reported === null) return {};
  const out: BackupOverrides = {};
  for (const name of OVERRIDABLE) {
    const entry = (reported as Record<string, unknown>)[name];
    if (typeof entry !== 'object' || entry === null) continue;
    const { variable, value } = entry as {
      variable?: unknown;
      value?: unknown;
    };
    if (!Variable.safeParse(variable).success) continue;
    const parsed = VALUES[name].safeParse(value);
    if (!parsed.success) continue;
    out[name] = {
      variable: variable as string,
      ...(parsed.data !== undefined && { value: parsed.data }),
    };
  }
  return out;
}

/** `stored`, with what the environment fixes in its place. */
export function effectiveSettings(
  stored: BackupSettings,
  overrides: BackupOverrides,
): BackupSettings {
  const value = <T>(name: Overridable, fallback: T): T =>
    overrides[name] && overrides[name].value !== undefined
      ? (overrides[name].value as T)
      : fallback;
  const schedule = overrides.schedule?.value as string | undefined;
  return {
    enabled: value('enabled', stored.enabled),
    frequency:
      schedule !== undefined
        ? { kind: 'cron', expression: schedule }
        : stored.frequency,
    time: stored.time,
    timeZone: value('timeZone', stored.timeZone),
    retention: {
      daily: value('retention.daily', stored.retention.daily),
      weekly: value('retention.weekly', stored.retention.weekly),
      monthly: value('retention.monthly', stored.retention.monthly),
    },
    location: value('location', stored.location),
    verify: value('verify', stored.verify),
    verifyByDecrypting: value('verifyByDecrypting', stored.verifyByDecrypting),
  };
}

/** Per setting, the variable fixing it. */
export function fixedBy(overrides: BackupOverrides): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides).map(([name, o]) => [name, o.variable]),
  );
}
