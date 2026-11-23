import { inject, Pipe, type PipeTransform } from '@angular/core';

import { LanguageService } from './language.service';

type DateInput = Date | string | number;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formatters by locale and options: building one is the expensive part. */
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();
function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(
  key: string,
  make: () => T,
): T {
  let formatter = cache.get(key) as T | undefined;
  if (!formatter) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter;
}

/** A date (and time) in the UI language: `{{ changed | ofDate }}`, options as for `Intl.DateTimeFormat`. */
@Pipe({ name: 'ofDate', pure: false })
export class DatePipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(
    value: DateInput | null | undefined,
    options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  ): string {
    const date = value === null || value === undefined ? null : toDate(value);
    if (!date) return '';
    const locale = this.language.locale();
    return cached(
      `d|${locale}|${JSON.stringify(options)}`,
      () => new Intl.DateTimeFormat(locale, options),
    ).format(date);
  }
}

/** A number in the UI language (`1,000` / `1.000`), options as for `Intl.NumberFormat`. */
@Pipe({ name: 'ofNumber', pure: false })
export class NumberPipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(
    value: number | null | undefined,
    options: Intl.NumberFormatOptions = {},
  ): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    const locale = this.language.locale();
    return cached(
      `n|${locale}|${JSON.stringify(options)}`,
      () => new Intl.NumberFormat(locale, options),
    ).format(value);
  }
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** How long ago (or ahead) `value` is from `now`, in the largest whole unit: "3 days ago", "vor 3 Tagen". */
export function relativeTime(value: Date, now: Date, locale: string): string {
  const seconds = Math.round((value.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return format.format(Math.trunc(seconds / size), unit);
    }
  }
  return format.format(0, 'second');
}

/** A relative time in the UI language: `{{ changed | ofRelativeTime }}`. */
@Pipe({ name: 'ofRelativeTime', pure: false })
export class RelativeTimePipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(
    value: DateInput | null | undefined,
    now: Date = new Date(),
  ): string {
    const date = value === null || value === undefined ? null : toDate(value);
    return date ? relativeTime(date, now, this.language.locale()) : '';
  }
}
