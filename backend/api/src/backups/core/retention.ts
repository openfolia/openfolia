import type { Retention } from './backup-settings.js';

/** A backup at its location, by name and when it was made. */
export interface StoredBackup {
  readonly name: string;
  readonly at: Date;
}

/** The calendar parts of `at` in `timeZone`. */
function partsOf(
  at: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The ISO week (`YYYY-Www`) of a calendar day. */
function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil((date.getTime() - yearStart) / 86_400_000 / 7 + 1 / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which backups retention keeps (grandfather-father-son): the newest of
 * each of the last `daily` days that have one, of the last `weekly` ISO
 * weeks and of the last `monthly` months, the days read in `timeZone`;
 * and always the newest backup, whatever the counts. Every other one is
 * to be deleted. Backups in the future of `now` (a clock set back) are
 * kept and count for nothing.
 */
export function retained(
  backups: readonly StoredBackup[],
  retention: Retention,
  timeZone: string,
  now: Date,
): { keep: StoredBackup[]; prune: StoredBackup[] } {
  const past = [...backups]
    .filter((b) => b.at.getTime() <= now.getTime())
    .sort(
      (a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1),
    );
  const keep = new Set<string>();
  if (past[0]) keep.add(past[0].name);
  const bucket = (period: (b: StoredBackup) => string, count: number) => {
    const seen = new Set<string>();
    for (const backup of past) {
      if (seen.size >= count) break;
      const key = period(backup);
      if (seen.has(key)) continue;
      seen.add(key);
      keep.add(backup.name);
    }
  };
  bucket((b) => {
    const p = partsOf(b.at, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
  }, retention.daily);
  bucket((b) => {
    const p = partsOf(b.at, timeZone);
    return isoWeek(p.year, p.month, p.day);
  }, retention.weekly);
  bucket((b) => {
    const p = partsOf(b.at, timeZone);
    return `${p.year}-${p.month}`;
  }, retention.monthly);
  const future = backups.filter((b) => b.at.getTime() > now.getTime());
  for (const b of future) keep.add(b.name);
  return {
    keep: backups.filter((b) => keep.has(b.name)),
    prune: backups.filter((b) => !keep.has(b.name)),
  };
}
