import type { SettingsItem } from './installation-choice.component';

/** A session limit of the settings (#378), with the values offered for it. */
export interface SessionLimit {
  readonly setting: 'sessionIdleMinutes' | 'sessionMaxHours';
  readonly server: 'serverSessionIdleMinutes' | 'serverSessionMaxHours';
  /** Minutes in one of the setting's units. */
  readonly minutes: number;
  readonly offered: readonly number[];
  readonly label: string;
  readonly hint: string;
}

export const SESSION_LIMITS: readonly SessionLimit[] = [
  {
    setting: 'sessionIdleMinutes',
    server: 'serverSessionIdleMinutes',
    minutes: 1,
    offered: [15, 30, 60, 120, 240, 480, 720, 1440, 4320, 10_080],
    label: 'editor.admin.settings.singleSignOn.idle',
    hint: 'editor.admin.settings.singleSignOn.idleHint',
  },
  {
    setting: 'sessionMaxHours',
    server: 'serverSessionMaxHours',
    minutes: 60,
    offered: [8, 12, 24, 72, 168, 336, 720, 2160],
    label: 'editor.admin.settings.singleSignOn.max',
    hint: 'editor.admin.settings.singleSignOn.maxHint',
  },
];

/** The values to offer: the usual ones, and the one set when it is another. */
export function offeredFor(
  limit: SessionLimit,
  settings: SettingsItem,
): readonly number[] {
  const set = settings.attributes[limit.setting];
  return set === null || limit.offered.includes(set)
    ? limit.offered
    : [...limit.offered, set].sort((a, b) => a - b);
}

/** The minutes a limit has now: what is set, else the server's own. */
function minutesOf(
  limit: SessionLimit,
  settings: SettingsItem,
  value: number | null = settings.attributes[limit.setting],
): number {
  return (value ?? settings.meta[limit.server]) * limit.minutes;
}

/** Whether `value` (null: the server's own) would leave the idle limit longer than the lifetime. */
export function crosses(
  limit: SessionLimit,
  settings: SettingsItem,
  value: number | null,
): boolean {
  const [idle, max] = SESSION_LIMITS.map((l) =>
    minutesOf(l, settings, l === limit ? value : undefined),
  );
  return (idle ?? 0) > (max ?? 0);
}

/** A time span in the largest unit that says it whole: "45 minutes", "8 hours", "7 days". */
export function spanText(minutes: number, locale: string): string {
  const [value, unit] =
    minutes % 1440 === 0
      ? [minutes / 1440, 'day']
      : minutes % 60 === 0
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}
