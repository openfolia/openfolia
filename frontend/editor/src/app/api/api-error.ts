import { HttpErrorResponse } from '@angular/common/http';
import type { Schema } from './api-types';

/** One member of the API's JSON:API error document. */
export type ApiErrorObject = Schema<'ErrorObject'>;

/**
 * What the shared states and toasts switch on, so a screen never reads status codes:
 * `unauthorized` (missing or wrong token), `not-found`, `invalid` (a bad parameter or
 * unreadable content), `unavailable` (busy or down: retry later), `network` (no answer),
 * `unknown`.
 */
export type ApiErrorKind =
  | 'unauthorized'
  | 'not-found'
  | 'invalid'
  | 'unavailable'
  | 'network'
  | 'unknown';

/** A failed API call. The only error type the editor's API layer throws. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly kind: ApiErrorKind,
    /** The HTTP status, 0 when there was no answer. */
    readonly status: number,
    /** The API's stable, kebab-case `code` (`not-found`, `invalid-parameter`, …); `network` or `unknown` otherwise. */
    readonly code: string,
    /** For people: the API's `detail`, or a generic sentence. */
    message: string,
    /** The query or path parameter at fault (`source.parameter`). */
    readonly parameter?: string,
    /** Seconds to wait before retrying (`meta.retryAfter` or the `Retry-After` header). */
    readonly retryAfter?: number,
    /** Every error object of the document, when the API sent one. */
    readonly errors: readonly ApiErrorObject[] = [],
  ) {
    super(message);
  }
}

const kindOf = (status: number): ApiErrorKind => {
  if (status === 0) return 'network';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 429 || status >= 500) return 'unavailable';
  if (status >= 400) return 'invalid';
  return 'unknown';
};

const isErrorObject = (value: unknown): value is ApiErrorObject =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ApiErrorObject).code === 'string';

const errorObjects = (body: unknown): ApiErrorObject[] => {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? errors.filter(isErrorObject) : [];
};

const seconds = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The one place a failed HTTP call becomes an `ApiError`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (!(error instanceof HttpErrorResponse)) {
    return new ApiError('unknown', 0, 'unknown', 'Something went wrong.');
  }
  const status = error.status;
  const [first, ...rest] = errorObjects(error.error);
  const retryAfter =
    seconds(first?.meta?.['retryAfter']) ??
    seconds(error.headers?.get('Retry-After'));
  if (!first) {
    return new ApiError(
      kindOf(status),
      status,
      status === 0 ? 'network' : 'unknown',
      status === 0
        ? 'The server did not answer.'
        : `The request failed (${status}).`,
      undefined,
      retryAfter,
    );
  }
  return new ApiError(
    kindOf(status),
    status,
    first.code,
    first.detail || `The request failed (${status}).`,
    first.source?.parameter,
    retryAfter,
    [first, ...rest],
  );
}
