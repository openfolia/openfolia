import { matches, parseFilter } from './scim-filter.js';
import type { JsonObject } from './scim-json.js';
import { withBudget } from './scim-work.js';

/** SCIM's paging (RFC 7644, section 3.4.2.4): from `startIndex` (1-based), `count` at most. */
export interface ScimPage {
  readonly startIndex: number;
  readonly count: number;
}

/** A page of a filtered list, and how many matched in all. */
export interface ScimListed<T> {
  readonly total: number;
  readonly startIndex: number;
  readonly items: readonly T[];
}

/** The most resources one page holds (`count` past it is cut to it). */
export const MAX_COUNT = 200;
/** A page's size when `count` is left out. */
export const DEFAULT_COUNT = 100;

/**
 * The items of `all` whose resource (`resourceOf`) matches `filter`, one page of them. 400
 * `scim-invalid-filter` for a filter that does not parse.
 */
export function listPage<T>(
  all: readonly T[],
  resourceOf: (item: T) => JsonObject,
  filter: string | undefined,
  { startIndex, count }: ScimPage,
): ScimListed<T> {
  const parsed = filter === undefined ? undefined : parseFilter(filter);
  const matching = parsed
    ? withBudget(() => all.filter((item) => matches(parsed, resourceOf(item))))
    : all;
  return {
    total: matching.length,
    startIndex,
    items: matching.slice(startIndex - 1, startIndex - 1 + count),
  };
}
