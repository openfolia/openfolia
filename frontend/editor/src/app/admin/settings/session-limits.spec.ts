import type { SettingsItem } from './installation-choice.component';
import {
  crosses,
  offeredFor,
  SESSION_LIMITS,
  spanText,
} from './session-limits';

const [idle, max] = SESSION_LIMITS as [
  (typeof SESSION_LIMITS)[number],
  (typeof SESSION_LIMITS)[number],
];
const settings = (
  sessionIdleMinutes: number | null = null,
  sessionMaxHours: number | null = null,
) =>
  ({
    attributes: { sessionIdleMinutes, sessionMaxHours },
    meta: { serverSessionIdleMinutes: 480, serverSessionMaxHours: 168 },
  }) as unknown as SettingsItem;

describe('session limits (#378)', () => {
  it('says a span in its largest whole unit, in the language', () => {
    expect(spanText(45, 'en')).toBe('45 minutes');
    expect(spanText(480, 'en')).toBe('8 hours');
    expect(spanText(1440, 'en')).toBe('1 day');
    expect(spanText(2160 * 60, 'de')).toBe('90 Tage');
  });

  it('offers the value set when it is no usual one, in order', () => {
    expect(offeredFor(idle, settings(45))).toEqual([
      15, 30, 45, 60, 120, 240, 480, 720, 1440, 4320, 10_080,
    ]);
    expect(offeredFor(max, settings())).toBe(max.offered);
  });

  it('keeps the idle limit within the lifetime, the server’s own too', () => {
    expect(crosses(idle, settings(null, 8), 720)).toBe(true);
    expect(crosses(idle, settings(null, 8), 480)).toBe(false);
    expect(crosses(max, settings(1440), 12)).toBe(true);
    expect(crosses(max, settings(1440), null)).toBe(false);
    // The server's own idle limit is 8 hours.
    expect(crosses(idle, settings(60, 4), null)).toBe(true);
  });
});
