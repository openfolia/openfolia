import { isTimeZone, nextDigestAt } from './notification-settings.js';

describe('nextDigestAt', () => {
  it('is the next time the clock in the zone reads the hour', () => {
    // 10:30 in Vienna (UTC+1 in January): tomorrow 08:00 there, 07:00 UTC.
    expect(
      nextDigestAt(new Date('2026-01-14T09:30:00Z'), 8, 'Europe/Vienna'),
    ).toEqual(new Date('2026-01-15T07:00:00Z'));
    // 06:00 in Vienna: today 08:00.
    expect(
      nextDigestAt(new Date('2026-01-14T05:00:00Z'), 8, 'Europe/Vienna'),
    ).toEqual(new Date('2026-01-14T07:00:00Z'));
    // In summer (UTC+2).
    expect(
      nextDigestAt(new Date('2026-07-01T12:00:00Z'), 8, 'Europe/Vienna'),
    ).toEqual(new Date('2026-07-02T06:00:00Z'));
  });

  it('works across a change to summer time and in UTC', () => {
    // The night of 29 March 2026: 02:00 does not exist in Vienna; 08:00 is 06:00 UTC.
    expect(
      nextDigestAt(new Date('2026-03-28T22:00:00Z'), 8, 'Europe/Vienna'),
    ).toEqual(new Date('2026-03-29T06:00:00Z'));
    expect(nextDigestAt(new Date('2026-03-29T08:00:00Z'), 8, 'UTC')).toEqual(
      new Date('2026-03-30T08:00:00Z'),
    );
    // A zone west of UTC, past midnight UTC: 22:00 the evening before there.
    expect(
      nextDigestAt(new Date('2026-01-15T03:00:00Z'), 23, 'America/New_York'),
    ).toEqual(new Date('2026-01-15T04:00:00Z'));
  });

  it('knows a time zone from a made-up one', () => {
    expect(isTimeZone('Europe/Vienna')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('../etc')).toBe(false);
  });
});
