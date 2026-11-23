import { backupName, backupTimeOf } from './backup-paths.js';
import { retained, type StoredBackup } from './retention.js';

const at = (iso: string): StoredBackup => {
  const d = new Date(iso);
  return {
    name: backupName(d, `${d.getTime().toString(16).padStart(8, '0')}`),
    at: d,
  };
};

/** One backup a day at 01:00 UTC from `from` for `days` days. */
const daily = (from: string, days: number): StoredBackup[] =>
  Array.from({ length: days }, (_, i) =>
    at(new Date(new Date(from).getTime() + i * 86_400_000).toISOString()),
  );

describe('retention (grandfather-father-son)', () => {
  it('keeps the default 7 daily, 4 weekly and 12 monthly of a year of nightly backups', () => {
    const backups = daily('2025-11-21T01:00:00Z', 365);
    const now = new Date('2026-11-20T12:00:00Z');
    const { keep, prune } = retained(
      backups,
      { daily: 7, weekly: 4, monthly: 12 },
      'UTC',
      now,
    );
    expect(keep.length + prune.length).toBe(365);
    const days = keep.map((b) => b.at.toISOString().slice(0, 10)).sort();
    // The last 7 days.
    for (let d = 14; d <= 20; d++) expect(days).toContain(`2026-11-${d}`);
    // The newest of each of the last 4 ISO weeks (Sundays, and this week's newest).
    expect(days).toEqual(
      expect.arrayContaining(['2026-11-15', '2026-11-08', '2026-11-01']),
    );
    expect(days).not.toContain('2026-10-25');
    // The newest of each of the last 12 months (month ends).
    expect(days).toEqual(
      expect.arrayContaining([
        '2026-10-31',
        '2026-09-30',
        '2026-01-31',
        '2025-12-31',
      ]),
    );
    expect(days).not.toContain('2025-11-30');
    expect(keep.length).toBeLessThanOrEqual(7 + 4 + 12);
  });

  it('always keeps the newest, also with every count at 0', () => {
    const backups = daily('2026-11-10T01:00:00Z', 5);
    const { keep } = retained(
      backups,
      { daily: 0, weekly: 0, monthly: 0 },
      'UTC',
      new Date('2026-11-20T00:00:00Z'),
    );
    expect(keep.map((b) => b.name)).toEqual([backups[4]!.name]);
  });

  it('reads the day in the time zone: two backups either side of midnight in Berlin are two days', () => {
    const a = at('2026-11-19T22:30:00Z'); // 23:30 in Berlin, the 19th
    const b = at('2026-11-19T23:30:00Z'); // 00:30 in Berlin, the 20th
    const kept = (tz: string) =>
      retained(
        [a, b],
        { daily: 2, weekly: 0, monthly: 0 },
        tz,
        new Date('2026-11-20T12:00:00Z'),
      ).keep.length;
    expect(kept('Europe/Berlin')).toBe(2);
    expect(kept('UTC')).toBe(1);
  });

  it('keeps a backup from the future (a clock set back) and counts it for nothing', () => {
    const future = at('2027-01-01T00:00:00Z');
    const past = daily('2026-11-10T01:00:00Z', 3);
    const { keep } = retained(
      [...past, future],
      { daily: 1, weekly: 0, monthly: 0 },
      'UTC',
      new Date('2026-11-20T00:00:00Z'),
    );
    expect(keep.map((b) => b.name).sort()).toEqual(
      [past[2]!.name, future.name].sort(),
    );
  });
});

describe('backup names', () => {
  it('carry the time they were made, which retention reads back', () => {
    const name = backupName(
      new Date('2026-11-20T01:02:03.456Z'),
      '72ad5ad9-4440-4e94-831f-6d86e183c2ff',
    );
    expect(name).toBe('openfolia-backup-20261120T010203Z-72ad5ad9.tar.age');
    expect(backupTimeOf(name)).toEqual(new Date('2026-11-20T01:02:03Z'));
    expect(backupTimeOf('something-else.tar.age')).toBeUndefined();
    expect(
      backupTimeOf('../openfolia-backup-20261120T010203Z-72ad5ad9.tar.age'),
    ).toBeUndefined();
  });
});
