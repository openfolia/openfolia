import {
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, map, throwError, type Observable } from 'rxjs';
import {
  API_BASE_URL,
  API_DEMO_USER,
  API_UNAUTHORIZED,
  DEMO_USER_HEADER,
  JSON_API,
  REQUEST_HEADER,
} from './api-config';
import { ApiError, toApiError } from './api-error';
import { ReadRef } from './read-ref';

const isApiCall = (url: string, base: string) =>
  url === base || url.startsWith(`${base}/`);

/** Adds the demo identity header to API calls, when a user is set. */
export const demoUserInterceptor: HttpInterceptorFn = (req, next) => {
  const user = inject(API_DEMO_USER, { optional: true })?.();
  if (!user || !isApiCall(req.url, inject(API_BASE_URL))) return next(req);
  return next(req.clone({ setHeaders: { [DEMO_USER_HEADER]: user } }));
};

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every state-changing API call (any method but GET, HEAD and OPTIONS) carries what a cross-site
 * form cannot send, or the API refuses it (`CrossSiteRequestGuard`): `Content-Type:
 * application/vnd.api+json`, also without a body; a `FormData` body (an upload, whose
 * `multipart/form-data` type the browser sets) `X-Ccms-Request` instead.
 */
export const stateChangeInterceptor: HttpInterceptorFn = (req, next) => {
  if (READS.has(req.method) || !isApiCall(req.url, inject(API_BASE_URL))) {
    return next(req);
  }
  if (req.body instanceof FormData) {
    return next(req.clone({ setHeaders: { [REQUEST_HEADER]: '1' } }));
  }
  // A type the caller chose stays (the API refuses any but JSON:API, visibly).
  return req.headers.has('Content-Type')
    ? next(req)
    : next(req.clone({ setHeaders: { 'Content-Type': JSON_API } }));
};

/**
 * A failed call that asked for a Blob (a file download) has its JSON:API error body as a Blob
 * too: read as JSON, so its `code` reaches the `ApiError`. Anything else is left as it is.
 */
function withJsonBody(error: HttpErrorResponse): Observable<HttpErrorResponse> {
  const body: unknown = error.error;
  if (!(body instanceof Blob) || !/json/i.test(body.type)) {
    return from([error]);
  }
  return from(
    body.text().then(
      (text) => {
        try {
          return new HttpErrorResponse({
            error: JSON.parse(text) as unknown,
            headers: error.headers,
            status: error.status,
            statusText: error.statusText,
            url: error.url ?? undefined,
          });
        } catch {
          return error;
        }
      },
      () => error,
    ),
  );
}

/** Turns every failed API call into an `ApiError`; a 401 (but `/me`'s own) tells `API_UNAUTHORIZED`. */
export const apiErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(API_BASE_URL);
  const apiCall = isApiCall(req.url, base);
  const unauthorized = inject(API_UNAUTHORIZED, { optional: true });
  return next(req).pipe(
    catchError((error: unknown) => {
      if (!apiCall || !(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }
      if (error.status === 401 && req.url !== `${base}/me`) unauthorized?.();
      return withJsonBody(error).pipe(
        map((readable) => {
          throw toApiError(readable);
        }),
      );
    }),
  );
};

/** The code a read at a change set's branch answers when that branch is gone (#317). */
export const BRANCH_MISSING = 'change-set-branch-missing';

/**
 * A read that answers `change-set-branch-missing` for the branch reads follow now tells
 * `ReadRef.missing`, so every screen learns at once that the chosen change set's branch is gone,
 * even when the change-set list was read before it went. The error goes on to the caller as it
 * is. Runs outside `apiErrorInterceptor`, so it sees the `ApiError`.
 */
export const missingBranchInterceptor: HttpInterceptorFn = (req, next) => {
  const readRef = inject(ReadRef);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (error instanceof ApiError && error.code === BRANCH_MISSING) {
        const branch = error.errors[0]?.meta?.['branch'];
        if (typeof branch === 'string' && branch === readRef.ref()) {
          readRef.missing.set(branch);
        }
      }
      return throwError(() => error);
    }),
  );
};
