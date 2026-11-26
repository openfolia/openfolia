import { z } from 'zod';
import {
  CHOSEN_KINDS,
  ChosenKind,
  type NotificationKind,
} from '../../notifications/core/notification.js';

/**
 * How a person hears of one kind of notification (#884): `off` (neither the bell nor email),
 * `app` (the bell only), `email` (the bell and an email at once) or `digest` (the bell and the
 * daily summary email).
 */
export const DELIVERY_CHOICES = ['off', 'app', 'email', 'digest'] as const;
export const DeliveryChoice = z.enum(DELIVERY_CHOICES);
export type DeliveryChoice = z.infer<typeof DeliveryChoice>;

/** The groups the settings page shows the kinds in, in order. */
export const NOTIFICATION_GROUPS = {
  review: [
    'change-set.submit',
    'change-set.return',
    'change-set.approve',
    'change-set.sign-off',
    'change-set.merge',
    'lock.break',
  ],
  releases: ['release.published', 'release.output-recovered'],
  translations: ['translation.imported', 'translation.import-failed'],
  // The alerts an administrator acts on.
  admin: ['release.output-failed', 'backup.failed', 'backup.overdue'],
} as const satisfies Record<string, readonly ChosenKind[]>;

/**
 * What a person who chose nothing gets: what is addressed to them in review (a request, a
 * decision on their change set) by email at once; releases and translations in the daily
 * summary; alerts an administrator acts on (a release's file failed, a backup failed or is
 * overdue) by email at once. The fan-out sends those only to people who hold the permission.
 */
export const DEFAULT_CHOICES: Readonly<Record<ChosenKind, DeliveryChoice>> = {
  'change-set.submit': 'email',
  'change-set.return': 'email',
  'change-set.approve': 'email',
  'change-set.sign-off': 'email',
  'change-set.merge': 'email',
  'lock.break': 'app',
  'release.published': 'digest',
  'release.output-failed': 'email',
  'release.output-recovered': 'digest',
  'translation.imported': 'digest',
  'translation.import-failed': 'digest',
  'backup.failed': 'email',
  'backup.overdue': 'email',
};

/** The languages a person's email is written in: the editor's. */
export const NotificationLanguage = z.enum(['en', 'de']);
export type NotificationLanguage = z.infer<typeof NotificationLanguage>;

/** Whether `value` names a time zone this server knows (IANA: `Europe/Vienna`, `UTC`). */
export function isTimeZone(value: string): boolean {
  if (value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimeZone = z
  .string()
  .refine(isTimeZone, 'an IANA time zone, e.g. "Europe/Vienna"');

/** An hour of the day, 0 to 23: when the daily summary goes out. */
export const DigestHour = z.number().int().min(0).max(23);

/** A person's notification settings (#884), as stored: what they chose, nothing derived. */
export interface NotificationSettings {
  /** The kinds the person chose for; the others follow `DEFAULT_CHOICES`. */
  readonly choices: Readonly<Partial<Record<ChosenKind, DeliveryChoice>>>;
  /** "Pause all email": every kind that would email stays in the app only. */
  readonly emailPaused: boolean;
  /** "Turn off all notifications": nothing, neither the bell nor email. */
  readonly allOff: boolean;
  /** The summary's hour in the person's time zone; null: the installation's default. */
  readonly digestHour: number | null;
  /** The person's time zone; null: UTC. */
  readonly timeZone: string | null;
  /** The language their email is written in (the editor's); null: the installation's. */
  readonly language: NotificationLanguage | null;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  choices: {},
  emailPaused: false,
  allOff: false,
  digestHour: null,
  timeZone: null,
  language: null,
};

/** A change of notification settings: what is left out stays; `choices` merge kind by kind. */
export type NotificationSettingsChanges = {
  readonly [K in keyof NotificationSettings]?: NotificationSettings[K];
};

/** What the person chose for `kind`, or its default. */
export function chosen(
  settings: NotificationSettings,
  kind: ChosenKind,
): DeliveryChoice {
  return settings.choices[kind] ?? DEFAULT_CHOICES[kind];
}

/**
 * How `kind` reaches the person now: "Turn off all notifications" wins, then the kind's
 * choice, with "Pause all email" keeping an emailing kind in the app. A kind nobody chooses about
 * is in the app whatever they set.
 */
export function deliveryOf(
  settings: NotificationSettings,
  kind: NotificationKind,
): DeliveryChoice {
  const asked = ChosenKind.safeParse(kind);
  if (!asked.success) return 'app';
  if (settings.allOff) return 'off';
  const choice = chosen(settings, asked.data);
  if (settings.emailPaused && (choice === 'email' || choice === 'digest')) {
    return 'app';
  }
  return choice;
}

/** Every kind with its choice (the defaults filled in), in catalogue order. */
export function allChoices(
  settings: NotificationSettings,
): Record<ChosenKind, DeliveryChoice> {
  return Object.fromEntries(
    CHOSEN_KINDS.map((kind) => [kind, chosen(settings, kind)]),
  ) as Record<ChosenKind, DeliveryChoice>;
}

/** The parts of `at` as a clock in `timeZone` shows them. */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** How far `timeZone`'s clock is ahead of UTC at `at`, in milliseconds. */
function offsetAt(at: Date, timeZone: string): number {
  const c = wallClock(at, timeZone);
  return (
    Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) -
    Math.floor(at.getTime() / 1000) * 1000
  );
}

/**
 * The first moment after `after` at which the clock in `timeZone` reads `hour`:00: when a
 * summary of what came at `after` goes out. On a day the clock skips that hour (summer time),
 * the moment it would have been.
 */
export function nextDigestAt(
  after: Date,
  hour: number,
  timeZone: string,
): Date {
  const local = wallClock(after, timeZone);
  for (let days = 0; days <= 2; days++) {
    const wall = Date.UTC(local.year, local.month - 1, local.day + days, hour);
    // The wall time's instant: its offset read twice, so a change of offset between the guess
    // and the answer (a summer-time switch) is taken into account.
    let instant = wall - offsetAt(new Date(wall), timeZone);
    instant = wall - offsetAt(new Date(instant), timeZone);
    if (instant > after.getTime()) return new Date(instant);
  }
  // Unreachable: two days on, the hour has come.
  return new Date(after.getTime() + 86_400_000);
}
