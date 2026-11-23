import { DELIVERY_ACCESS } from '@openfolia/content-model';
import { z } from 'zod';

/** `CCMS_DELIVERY_IGNORED_QUERY`'s default: the common campaign parameters. */
export const DEFAULT_IGNORED_QUERY: readonly string[] = ['utm_*'];

/**
 * `CCMS_DELIVERY_PER_MINUTE`'s default (#574): pages, PDFs and QR codes one client may ask a
 * server for in a minute under `/d/`.
 */
export const DEFAULT_DELIVERY_PER_MINUTE = 60;

/** The most patterns `CCMS_DELIVERY_IGNORED_QUERY` takes. */
export const MAX_IGNORED_QUERY = 100;

/** One pattern: a parameter name (letters, digits, `_`, `-`, `.`), `*` at the end for a prefix. */
const PATTERN = /^[A-Za-z0-9_.-]{1,64}\*?$/;

/**
 * `CCMS_DELIVERY_IGNORED_QUERY` (#553): the query parameters a stable address ignores, so a
 * link shared with tracking parameters still opens. Comma-separated; each a name, or a prefix
 * ending in `*` (`utm_*`); `none` for no parameter at all. A bare `*` is refused: an address
 * still refuses parameters nobody listed.
 */
export const ignoredQuery = z
  .string()
  .trim()
  .transform((value) =>
    value === 'none'
      ? []
      : value
          .split(',')
          .map((pattern) => pattern.trim())
          .filter((pattern) => pattern !== ''),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(
            PATTERN,
            'each must be a parameter name, or a prefix ending in * (utm_*)',
          ),
      )
      .max(MAX_IGNORED_QUERY, `at most ${MAX_IGNORED_QUERY} patterns`),
  );

/**
 * `CCMS_DELIVERY_MAX_ACCESS` (#553): the most a project's `delivery.access` may open its
 * stable addresses on this deployment, `public` (default: no cap), `signed-in` or `off`.
 */
export const maxAccess = z
  .string()
  .trim()
  .pipe(z.enum(DELIVERY_ACCESS, 'must be public, signed-in or off'));
