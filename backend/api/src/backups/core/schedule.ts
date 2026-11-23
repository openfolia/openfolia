import { Cron } from 'croner';
import type { Frequency } from './backup-settings.js';

/**
 * The cron expression (five fields: minute hour day month weekday) a
 * frequency and a time of day stand for. "Every N hours" runs at the set
 * time and every N hours after it, until the day ends (`M H-23/N * * *`).
 */
export function cronOf(frequency: Frequency, time: string): string {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  switch (frequency.kind) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${frequency.weekday}`;
    case 'hours':
      return `${minute} ${hour}-23/${frequency.every} * * *`;
    case 'cron':
      return frequency.expression.trim().replace(/\s+/g, ' ');
  }
}

/**
 * Why `expression` is no schedule this server runs, or undefined when it
 * is one: five fields, which the cron library reads, and that ever runs.
 */
export function scheduleProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return 'A schedule has five fields: minute, hour, day of the month, month and weekday.';
  }
  try {
    const cron = new Cron(fields.join(' '), { paused: true, timezone: 'UTC' });
    if (cron.nextRun(new Date()) === null) {
      return 'This schedule never runs.';
    }
    return undefined;
  } catch (error) {
    return `Not a cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The next `count` times `expression` runs after `after` (not at it), read
 * in `timeZone`.
 */
export function nextRuns(
  expression: string,
  timeZone: string,
  after: Date,
  count: number,
): Date[] {
  const cron = new Cron(expression, { paused: true, timezone: timeZone });
  return cron.nextRuns(count, after);
}

/** The first time `expression` runs after `after`, or undefined when it never does. */
export function nextRun(
  expression: string,
  timeZone: string,
  after: Date,
): Date | undefined {
  return nextRuns(expression, timeZone, after, 1)[0];
}
