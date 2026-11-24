import {
  HttpClient,
  HttpParams,
  type HttpEvent,
  type HttpResponse,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { defer, finalize, type Observable } from 'rxjs';
import { API_BASE_URL, JSON_API } from './api-config';
import type {
  ActionBody,
  ActionPathParams,
  ActionResponse,
  DeletePath,
  DeleteBody,
  DeletePathParams,
  DeleteQuery,
  JsonActionPath,
  JsonGetPath,
  JsonPatchPath,
  JsonPostPath,
  JsonPutPath,
  PatchBody,
  PatchPathParams,
  PatchResponse,
  PathParams,
  PostBody,
  PostPathParams,
  PostResponse,
  PutBody,
  PutPathParams,
  PutQuery,
  PutResponse,
  Query,
  Response,
  Schema,
} from './api-types';
import { ReadRef, REF_ROUTES } from './read-ref';

/** What a call to route `P` may take: its path and query parameters, as the document names them. */
export type RequestOptions<P extends JsonGetPath> = ([PathParams<P>] extends [
  never,
]
  ? { path?: undefined }
  : { path: PathParams<P> }) & {
  query?: Query<P>;
};

/** The widths an image's rendition comes in (`GET /assets/{hash}?width=`). */
export type RenditionWidth = 320 | 640 | 1280;

/** `page[number]` / `page[size]` for a list route. */
export const pageQuery = (page: {
  number?: number;
  size?: number;
}): { 'page[number]'?: number; 'page[size]'?: number } => ({
  ...(page.number === undefined ? {} : { 'page[number]': page.number }),
  ...(page.size === undefined ? {} : { 'page[size]': page.size }),
});

/** Fills `{name}` in a route template; values are URL-encoded. */
export function fillPath(
  template: string,
  params: Record<string, string> | undefined,
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

/**
 * Typed access to the API's JSON routes. Routes, parameters and documents come from the
 * generated `schema.d.ts`, so a changed endpoint breaks the build. Failures are `ApiError`s.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly readRef = inject(ReadRef);
  /** `PUT`s on their way, and who waits for none to be left (`putsSettled`). */
  private puts = 0;
  private waiting: (() => void)[] = [];

  /**
   * Resolves once no `PUT` (a working-copy save, say) is on its way, or after `maxMs`: so a
   * request that must follow what was just typed (an update from the base) goes after it.
   */
  putsSettled(maxMs = 5000): Promise<void> {
    if (this.puts === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, maxMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.waiting.push(done);
    });
  }

  /** `GET` a route; `ref` (and the other query parameters) go in `options.query`. */
  get<P extends JsonGetPath>(
    path: P,
    ...[options]: [PathParams<P>] extends [never]
      ? [options?: RequestOptions<P>]
      : [options: RequestOptions<P>]
  ): Observable<Response<P>> {
    const url = `${this.base}${fillPath(path, options?.path as Record<string, string> | undefined)}`;
    const query: Record<string, unknown> = { ...options?.query };
    // Reads follow the chosen change set's branch, unless the call names its own `ref`.
    const ref = this.readRef.ref();
    if (ref && query['ref'] === undefined && isRefRoute(path)) {
      query['ref'] = ref;
    }
    return this.http.get<Response<P>>(url, {
      params: paramsOf(query),
      headers: { Accept: JSON_API },
    });
  }

  /**
   * `GET` a route with the whole response, for what its headers say (the server's `Date`, to
   * turn a time it names into one of the browser's clock). No `ref`: for routes without one.
   */
  getResponse<P extends JsonGetPath>(
    path: P,
    ...[options]: [PathParams<P>] extends [never]
      ? [options?: RequestOptions<P>]
      : [options: RequestOptions<P>]
  ): Observable<HttpResponse<Response<P>>> {
    const url = `${this.base}${fillPath(path, options?.path as Record<string, string> | undefined)}`;
    return this.http.get<Response<P>>(url, {
      params: paramsOf({ ...options?.query }),
      headers: { Accept: JSON_API },
      observe: 'response',
    });
  }

  /**
   * `POST` a JSON:API document to a route that creates something (`201`; some answer `200` when
   * there was nothing to create, with their own document). Path parameters go in `options.path`.
   */
  post<P extends JsonPostPath>(
    path: P,
    body: PostBody<P>,
    ...[options]: [PostPathParams<P>] extends [never]
      ? [options?: { path?: undefined }]
      : [options: { path: PostPathParams<P> }]
  ): Observable<PostResponse<P>> {
    const url = `${this.base}${fillPath(path, options?.path as Record<string, string> | undefined)}`;
    return this.http.post<PostResponse<P>>(url, body, {
      headers: { Accept: JSON_API, 'Content-Type': JSON_API },
    });
  }

  /**
   * `POST` to a route that acts on a resource and answers `200` (a workflow transition), `202`
   * (queued: a release's file retried) or `204` to a JSON body (breaking a lock: `null`), with its
   * optional JSON:API body. Path parameters go in `options.path`.
   */
  act<P extends JsonActionPath>(
    path: P,
    options: { path: ActionPathParams<P> },
    body?: ActionBody<P>,
  ): Observable<ActionResponse<P>> {
    const url = `${this.base}${fillPath(path, options.path as Record<string, string>)}`;
    return this.http.post<ActionResponse<P>>(url, body ?? {}, {
      headers: { Accept: JSON_API, 'Content-Type': JSON_API },
    });
  }

  /**
   * `PUT` a JSON:API document (`200`); path parameters go in `options.path`, query parameters
   * (a template file's path) in `options.query`.
   */
  put<P extends JsonPutPath>(
    path: P,
    options: { path: PutPathParams<P>; query?: PutQuery<P> },
    body: PutBody<P>,
  ): Observable<PutResponse<P>> {
    const url = `${this.base}${fillPath(path, options.path as Record<string, string>)}`;
    return defer(() => {
      this.puts++;
      return this.http
        .put<PutResponse<P>>(url, body, {
          params: paramsOf(options.query ?? {}),
          headers: { Accept: JSON_API, 'Content-Type': JSON_API },
        })
        .pipe(
          finalize(() => {
            if (--this.puts > 0) return;
            const waiting = this.waiting;
            this.waiting = [];
            for (const done of waiting) done();
          }),
        );
    });
  }

  /** `PATCH` a JSON:API document (`200`); path parameters go in `options.path`. */
  patch<P extends JsonPatchPath>(
    path: P,
    options: { path: PatchPathParams<P> },
    body: PatchBody<P>,
  ): Observable<PatchResponse<P>> {
    const url = `${this.base}${fillPath(path, options.path as Record<string, string>)}`;
    return this.http.patch<PatchResponse<P>>(url, body, {
      headers: { Accept: JSON_API, 'Content-Type': JSON_API },
    });
  }

  /**
   * `DELETE` on a route, with its query parameters in `options.query`; answers what the API
   * answered (most send no body). It says JSON:API,
   * as every state-changing call must (`stateChangeInterceptor`); a route that takes a document
   * (removing roles from a user) gets it as `body`.
   */
  delete<P extends DeletePath>(
    path: P,
    options: { path: DeletePathParams<P>; query?: DeleteQuery<P> },
    ...[body]: [DeleteBody<P>] extends [never] ? [] : [body: DeleteBody<P>]
  ): Observable<unknown> {
    const url = `${this.base}${fillPath(path, options.path as Record<string, string>)}`;
    return this.http.delete(url, {
      params: paramsOf(options.query ?? {}),
      headers: { Accept: JSON_API, 'Content-Type': JSON_API },
      ...(body !== undefined && { body }),
    });
  }

  /**
   * `POST` a file as `multipart/form-data` (one part named `file`, with its name) to the upload
   * route: an image, with `kind: 'attachment'` a file of any type, with `kind: 'font'` a font
   * for a page design (#555). `stateChangeInterceptor`
   * adds `X-Ccms-Request`, which the API asks of a form.
   */
  upload(
    path: '/change-sets/{changeSetId}/assets',
    options: {
      path: { changeSetId: string };
      kind?: 'image' | 'attachment' | 'font';
    },
    file: Blob,
  ): Observable<Schema<'ChangeSetAssetDocument'>> {
    const url = `${this.base}${fillPath(path, options.path)}`;
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Schema<'ChangeSetAssetDocument'>>(url, form, {
      headers: { Accept: JSON_API },
      params: options.kind ? { kind: options.kind } : {},
    });
  }

  /**
   * `POST` an image for the branding (`/branding/images`, #169) as `multipart/form-data` (one
   * part named `file`); `stateChangeInterceptor` adds `X-Ccms-Request`.
   */
  uploadBrandingImage(file: Blob): Observable<Schema<'BrandingImageDocument'>> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Schema<'BrandingImageDocument'>>(
      `${this.base}/branding/images`,
      form,
      { headers: { Accept: JSON_API } },
    );
  }

  /**
   * `upload`, with its progress: the request's events (`HttpEventType.UploadProgress` while the
   * bytes go, then the `HttpResponse` with the API's answer).
   */
  uploadWithProgress(
    path: '/change-sets/{changeSetId}/assets',
    options: {
      path: { changeSetId: string };
      kind?: 'image' | 'attachment' | 'font';
    },
    file: Blob,
  ): Observable<HttpEvent<Schema<'ChangeSetAssetDocument'>>> {
    const url = `${this.base}${fillPath(path, options.path)}`;
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Schema<'ChangeSetAssetDocument'>>(url, form, {
      headers: { Accept: JSON_API },
      params: options.kind ? { kind: options.kind } : {},
      reportProgress: true,
      observe: 'events',
    });
  }

  /**
   * `GET` an image's or an attached file's bytes. `/assets/{hash}` and a safety symbol's artwork
   * (`/symbols/{id}`) read at the chosen change set's branch, as JSON reads do (unless `ref` is
   * given); the change-set preview takes no `ref`. `width` asks for the image's rendition at most
   * that wide (a WebP; PNG, JPEG, GIF and WebP images only; `/assets/{hash}` and the change-set
   * preview only).
   */
  image(
    path:
      | '/assets/{hash}'
      | '/change-sets/{changeSetId}/assets/{hash}'
      | '/symbols/{id}',
    options: {
      path: Record<string, string>;
      ref?: string;
      width?: RenditionWidth;
    },
  ): Observable<Blob> {
    const url = `${this.base}${fillPath(path, options.path)}`;
    const ref =
      path === '/change-sets/{changeSetId}/assets/{hash}'
        ? undefined
        : (options.ref ?? this.readRef.ref());
    return this.http.get(url, {
      params: {
        ...(ref ? { ref } : {}),
        ...(options.width ? { width: options.width } : {}),
      },
      responseType: 'blob',
    });
  }

  /**
   * `GET` an attached file's bytes with the response, as `image` reads them: its headers say the
   * name the API serves it under (`Content-Disposition`) and its stored type. A release's file
   * (`/releases/{releaseId}/outputs/{outputId}/file`) or a download's version
   * (`/downloads/{id}/versions/{releaseId}/file`) takes no `ref`: it is the release's.
   */
  file(
    path:
      | '/assets/{hash}'
      | '/change-sets/{changeSetId}/assets/{hash}'
      | '/releases/{releaseId}/outputs/{outputId}/file'
      | '/downloads/{id}/versions/{releaseId}/file',
    options: { path: Record<string, string>; ref?: string },
  ): Observable<HttpResponse<Blob>> {
    const url = `${this.base}${fillPath(path, options.path)}`;
    const ref =
      path === '/assets/{hash}'
        ? (options.ref ?? this.readRef.ref())
        : undefined;
    return this.http.get(url, {
      params: ref ? { ref } : {},
      responseType: 'blob',
      observe: 'response',
    });
  }

  /**
   * `GET` a report as CSV (#56) with the response, so its `Content-Disposition` names the file. It
   * reads at the chosen change set's branch, as the JSON reports do (unless `query.ref` is given);
   * query values left undefined are left out.
   */
  csv(
    path: '/reports/translations/csv' | '/reports/module-usage/csv',
    query: Readonly<Record<string, string | undefined>> = {},
  ): Observable<HttpResponse<Blob>> {
    const ref = query['ref'] ?? this.readRef.ref();
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...query, ref })) {
      if (value !== undefined) params[key] = value;
    }
    return this.http.get(`${this.base}${path}`, {
      params,
      headers: { Accept: 'text/csv' },
      responseType: 'blob',
      observe: 'response',
    });
  }

  /**
   * `GET /audit-events/export` (#379) with the response, so its `Content-Disposition` names the
   * file: the audit log as CSV or JSON Lines, for the filters given (values left undefined are left
   * out). It takes no `ref`: the log is no content.
   */
  auditExport(
    format: 'csv' | 'jsonl',
    filters: Readonly<Record<string, string | undefined>>,
  ): Observable<HttpResponse<Blob>> {
    const params: Record<string, string> = { format };
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) params[key] = value;
    }
    return this.http.get(`${this.base}/audit-events/export`, {
      params,
      headers: {
        Accept: format === 'csv' ? 'text/csv' : 'application/jsonl',
      },
      responseType: 'blob',
      observe: 'response',
    });
  }

  /**
   * `GET` a translation job's file (#50) with the response, so its `Content-Disposition` names
   * it: with `lang`, that language's XLIFF; without, a ZIP of every language. It takes no `ref`:
   * the file is made from the job's commit.
   */
  translationJobFile(
    jobId: string,
    lang?: string,
  ): Observable<HttpResponse<Blob>> {
    const url = `${this.base}${fillPath('/translations/exports/{jobId}/file', { jobId })}`;
    return this.http.get(url, {
      params: lang ? { lang } : {},
      responseType: 'blob',
      observe: 'response',
    });
  }

  /** A translation job as a COTI package for a translation management system (#140). */
  translationJobPackage(jobId: string): Observable<HttpResponse<Blob>> {
    const url = `${this.base}${fillPath('/translations/exports/{jobId}/package', { jobId })}`;
    return this.http.get(url, { responseType: 'blob', observe: 'response' });
  }

  /**
   * A stable address's QR code (#450) as `format`, by the address's path as `GET /stable-addresses`
   * gives it (`/d/<product>/…`, already encoded); any other path is refused before a request.
   */
  qrCode(
    addressPath: string,
    format: 'svg' | 'png',
  ): Observable<HttpResponse<Blob>> {
    if (
      !/^\/d\/[^?#\\]+$/.test(addressPath) ||
      addressPath.includes('..') ||
      /%2e|%2f|%5c/i.test(addressPath)
    ) {
      throw new Error(`Not a stable address: ${addressPath}`);
    }
    return this.http.get(`${this.base}${addressPath}/qr.${format}`, {
      responseType: 'blob',
      observe: 'response',
    });
  }

  /**
   * `GET` all of a release's files as one ZIP (#469), with its progress: the request's events
   * (`HttpEventType.DownloadProgress` while the bytes come, with `total` from its
   * `Content-Length`, then the `HttpResponse`, whose headers name the file and say how many files
   * it holds and left out). It takes no `ref`: the files are the release's.
   */
  releaseArchive(releaseId: string): Observable<HttpEvent<Blob>> {
    const url = `${this.base}${fillPath('/releases/{releaseId}/outputs/archive', { releaseId })}`;
    return this.http.get(url, {
      responseType: 'blob',
      observe: 'events',
      reportProgress: true,
    });
  }
}

const isRefRoute = (path: string): boolean =>
  (REF_ROUTES as readonly string[]).includes(path);

/** Query parameters as `HttpParams`: an array repeats its name (`filter[keyword]=a&filter[keyword]=b`). */
function paramsOf(query: object): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) {
        params = params.append(key, String(item));
      }
    }
  }
  return params;
}
