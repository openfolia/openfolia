import { describe, expect, it } from 'vitest';

import {
  hourLabel,
  KIND_GROUPS,
  KIND_TEXTS,
  missedAlerts,
  timeZones,
  type NotificationSettings,
} from './notification-settings-model';

const settings = (
  choices: Partial<NotificationSettings['choices']>,
): NotificationSettings =>
  ({
    choices: {
      'backup.failed': 'email',
      'backup.overdue': 'email',
      'release.output-failed': 'email',
      ...choices,
    },
    emailPaused: false,
    allOff: false,
    digestHour: null,
    timeZone: null,
    language: null,
  }) as NotificationSettings;

describe('the notification settings', () => {
  it('show every kind once, each with its words', () => {
    const kinds = KIND_GROUPS.flatMap((g) => g.kinds);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.sort()).toEqual(Object.keys(KIND_TEXTS).sort());
  });

  it('warn of the admin alerts turned off, not of those in the app only', () => {
    expect(
      missedAlerts(
        settings({ 'backup.failed': 'off', 'backup.overdue': 'app' }),
      ),
    ).toEqual(['backup.failed']);
    expect(missedAlerts(settings({}))).toEqual([]);
  });

  it('name an hour as a time of day', () => {
    expect(hourLabel(8, 'de')).toBe('08:00');
    expect(hourLabel(0, 'de')).toBe('00:00');
  });

  it('list the time zones sorted, UTC and the person’s own among them', () => {
    const zones = timeZones('Europe/Vienna');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Vienna');
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });
});
