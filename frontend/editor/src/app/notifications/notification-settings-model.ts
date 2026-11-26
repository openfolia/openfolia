import type { Schema } from '../api';

/** The person's notification settings, as `GET /me/preferences` has them (#884). */
export type NotificationSettings =
  Schema<'PreferencesResource'>['attributes']['notifications'];
/** A kind a person chooses how to hear of; nothing is chosen about the others. */
export type ChosenKind = keyof NotificationSettings['choices'];
export type DeliveryChoice = NotificationSettings['choices'][ChosenKind];
/** Why no email can reach the person; null when one can. */
export type EmailUnavailable =
  Schema<'PreferencesResource'>['meta']['notifications']['emailUnavailable'];

/** The choices a kind offers, in the order the select lists them. */
export const DELIVERY_CHOICES: readonly DeliveryChoice[] = [
  'off',
  'app',
  'email',
  'digest',
];

/** A group of kinds as the page shows it: its heading, and each kind's label key. */
export interface KindGroup {
  readonly id: 'review' | 'releases' | 'translations' | 'admin';
  readonly kinds: readonly ChosenKind[];
}

/** The kinds by group, in the page's order (the API's `NOTIFICATION_GROUPS`). */
export const KIND_GROUPS: readonly KindGroup[] = [
  {
    id: 'review',
    kinds: [
      'change-set.submit',
      'change-set.return',
      'change-set.approve',
      'change-set.sign-off',
      'change-set.merge',
      'lock.break',
    ],
  },
  { id: 'releases', kinds: ['release.published', 'release.output-recovered'] },
  {
    id: 'translations',
    kinds: ['translation.imported', 'translation.import-failed'],
  },
  {
    id: 'admin',
    kinds: ['release.output-failed', 'backup.failed', 'backup.overdue'],
  },
];

/** What the page says of a kind: its label, a line on it, and (an admin alert) what turning it off misses. */
export interface KindTexts {
  readonly label: string;
  readonly text: string;
  readonly missed?: string;
}

export const KIND_TEXTS: Readonly<Record<ChosenKind, KindTexts>> = {
  'change-set.submit': {
    label: 'editor.notificationSettings.kinds.changeSetSubmit.label',
    text: 'editor.notificationSettings.kinds.changeSetSubmit.text',
  },
  'change-set.return': {
    label: 'editor.notificationSettings.kinds.changeSetReturn.label',
    text: 'editor.notificationSettings.kinds.changeSetReturn.text',
  },
  'change-set.approve': {
    label: 'editor.notificationSettings.kinds.changeSetApprove.label',
    text: 'editor.notificationSettings.kinds.changeSetApprove.text',
  },
  'change-set.sign-off': {
    label: 'editor.notificationSettings.kinds.changeSetSignOff.label',
    text: 'editor.notificationSettings.kinds.changeSetSignOff.text',
  },
  'change-set.merge': {
    label: 'editor.notificationSettings.kinds.changeSetMerge.label',
    text: 'editor.notificationSettings.kinds.changeSetMerge.text',
  },
  'lock.break': {
    label: 'editor.notificationSettings.kinds.lockBreak.label',
    text: 'editor.notificationSettings.kinds.lockBreak.text',
  },
  'release.published': {
    label: 'editor.notificationSettings.kinds.releasePublished.label',
    text: 'editor.notificationSettings.kinds.releasePublished.text',
  },
  'release.output-recovered': {
    label: 'editor.notificationSettings.kinds.releaseOutputRecovered.label',
    text: 'editor.notificationSettings.kinds.releaseOutputRecovered.text',
  },
  'translation.imported': {
    label: 'editor.notificationSettings.kinds.translationImported.label',
    text: 'editor.notificationSettings.kinds.translationImported.text',
  },
  'translation.import-failed': {
    label: 'editor.notificationSettings.kinds.translationImportFailed.label',
    text: 'editor.notificationSettings.kinds.translationImportFailed.text',
  },
  'release.output-failed': {
    label: 'editor.notificationSettings.kinds.releaseOutputFailed.label',
    text: 'editor.notificationSettings.kinds.releaseOutputFailed.text',
    missed: 'editor.notificationSettings.kinds.releaseOutputFailed.missed',
  },
  'backup.failed': {
    label: 'editor.notificationSettings.kinds.backupFailed.label',
    text: 'editor.notificationSettings.kinds.backupFailed.text',
    missed: 'editor.notificationSettings.kinds.backupFailed.missed',
  },
  'backup.overdue': {
    label: 'editor.notificationSettings.kinds.backupOverdue.label',
    text: 'editor.notificationSettings.kinds.backupOverdue.text',
    missed: 'editor.notificationSettings.kinds.backupOverdue.missed',
  },
};

export const GROUP_TEXTS: Readonly<
  Record<KindGroup['id'], { readonly title: string; readonly text: string }>
> = {
  review: {
    title: 'editor.notificationSettings.groups.review.title',
    text: 'editor.notificationSettings.groups.review.text',
  },
  releases: {
    title: 'editor.notificationSettings.groups.releases.title',
    text: 'editor.notificationSettings.groups.releases.text',
  },
  translations: {
    title: 'editor.notificationSettings.groups.translations.title',
    text: 'editor.notificationSettings.groups.translations.text',
  },
  admin: {
    title: 'editor.notificationSettings.groups.admin.title',
    text: 'editor.notificationSettings.groups.admin.text',
  },
};

export const CHOICE_LABELS: Readonly<Record<DeliveryChoice, string>> = {
  off: 'editor.notificationSettings.choices.off',
  app: 'editor.notificationSettings.choices.app',
  email: 'editor.notificationSettings.choices.email',
  digest: 'editor.notificationSettings.choices.digest',
};

/** Why email is off for the person, in words. */
export const EMAIL_OFF_TEXTS: Readonly<
  Record<NonNullable<EmailUnavailable>, string>
> = {
  off: 'editor.notificationSettings.emailOff.off',
  'no-secret-key': 'editor.notificationSettings.emailOff.no-secret-key',
  'no-public-url': 'editor.notificationSettings.emailOff.no-public-url',
  'no-address': 'editor.notificationSettings.emailOff.no-address',
};

/** The admin alerts the person turned off: what the page warns of. */
export function missedAlerts(
  settings: NotificationSettings,
): ChosenKind[] {
  const admin = KIND_GROUPS.find((g) => g.id === 'admin')!.kinds;
  return admin.filter((k) => settings.choices[k] === 'off');
}

/** The time zones this browser knows, the person's own first; UTC when it lists none. */
export function timeZones(own: string | null): string[] {
  let zones: string[];
  try {
    zones = (
      Intl as unknown as { supportedValuesOf(key: string): string[] }
    ).supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const all = new Set(['UTC', ...zones]);
  if (own) all.add(own);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** This browser's time zone; null when it names none. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** An hour as a time of day in `locale`: 8 is "08:00" (or "8 AM"). */
export function hourLabel(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(Date.UTC(2000, 0, 1, hour));
}
