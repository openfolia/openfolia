import { z } from 'zod';

const JSON_API = 'application/vnd.api+json';

/** What the connector reads of an import's report (`meta.report`, `POST /imports`). */
const Report = z.object({
  valid: z.boolean(),
  applicable: z.boolean(),
  items: z
    .array(
      z.object({
        kind: z.string(),
        id: z.string(),
        /** A module's language. */
        lang: z.string().optional(),
        action: z.string(),
        reasons: z.array(z.object({ code: z.string(), message: z.string() })),
      }),
    )
    .default([]),
  issues: z
    .array(
      z.object({ severity: z.string(), code: z.string(), message: z.string() }),
    )
    .default([]),
  counts: z.object({
    create: z.number(),
    update: z.number(),
    skip: z.number(),
    refuse: z.number(),
  }),
});
export type ImportReport = z.output<typeof Report>;

const ImportResource = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({ state: z.string() }),
    relationships: z
      .object({
        changeSet: z.object({ data: z.object({ id: z.string() }) }).optional(),
      })
      .optional(),
    meta: z.object({
      report: Report,
      failure: z
        .object({ code: z.string(), detail: z.string() })
        .nullable()
        .optional(),
    }),
  }),
});

const ChangeSetResource = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({ state: z.string() }),
  }),
});

const LockPage = z.object({
  data: z.array(
    z.object({
      relationships: z.object({
        changeSet: z.object({ data: z.object({ id: z.string() }) }),
      }),
    }),
  ),
});

const ErrorBody = z.object({
  errors: z
    .array(
      z.object({
        code: z.string().optional(),
        detail: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .min(1),
});

/** An answer of the API other than the one asked for: its status and error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`The API answered ${status} ${code}: ${detail}`);
    this.name = 'ApiError';
  }
}

export interface ImportState {
  readonly id: string;
  readonly state: string;
  readonly report: ImportReport;
  readonly changeSetId?: string;
  readonly failure?: { readonly code: string; readonly detail: string };
}

export interface ImportApiOptions {
  /** The API's base URL: https, or http on a loopback address only. */
  readonly baseUrl: string;
  /** What the requests act with, sent on every request to the API and nowhere else. */
  readonly credential: ApiCredential;
  /** For tests; default the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** How long one request may take (default 60 s). */
  readonly timeoutMs?: number;
}

/**
 * What the connector's requests act with. An import is made by a person
 * holding `admin.roles` and `content.edit` (a service account cannot hold
 * `admin.roles`), so the command line uses a person's session: the session
 * cookie `__Host-openfolia-session`, from the cookie file made by signing in
 * (`readSessionCookie`). A bearer token is for tests and for whatever
 * other credential the API accepts for imports.
 */
export type ApiCredential =
  { readonly session: string } | { readonly bearer: string };

/** The session cookie's name (`backend/api`, sign-in). */
export const SESSION_COOKIE = '__Host-openfolia-session';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Checks the base URL: https, or http to this machine only, so the
 * credential never crosses a network in the clear. No credentials, query or fragment
 * in it.
 */
export function apiBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The API URL is not a URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The API URL holds no credentials, query or fragment: give the session separately.',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))
  ) {
    throw new Error(
      'The API URL must use https (http only to this machine), so the session is never sent in the clear.',
    );
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/**
 * The few routes of the content API a connector uses, and nothing else:
 * an import's check (`dryRun`), its upload, applying it, reading its state
 * and submitting its change set for review. Every request goes to the one
 * configured API, with the credential, never following a redirect (so the
 * credential goes nowhere else).
 */
export class ImportApi {
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ImportApiOptions) {
    this.base = apiBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** `POST /imports` with `dryRun`: the report, nothing stored. */
  async check(bundle: Uint8Array, fileName: string): Promise<ImportReport> {
    return (await this.upload(bundle, fileName, true)).report;
  }

  /** `POST /imports`: the stored import and its report. */
  async create(bundle: Uint8Array, fileName: string): Promise<ImportState> {
    return this.upload(bundle, fileName, false);
  }

  /** `POST /imports/:id/apply`: its job starts. */
  async apply(id: string): Promise<ImportState> {
    return toState(
      ImportResource.parse(
        // Every POST names the JSON:API media type, also without a body.
        await this.request(
          'POST',
          `imports/${encodeURIComponent(id)}/apply`,
          '',
          JSON_API,
        ),
      ),
    );
  }

  /** `GET /imports/:id`. */
  async get(id: string): Promise<ImportState> {
    return toState(
      ImportResource.parse(
        await this.request('GET', `imports/${encodeURIComponent(id)}`),
      ),
    );
  }

  /**
   * `GET /locks?filter[subject]=…`: the change set holding the lock on a
   * module (`module/<lang>/<id>`) or manual (`manual/<id>`), if one does.
   */
  async lockedBy(subject: string): Promise<string | undefined> {
    const query = new URLSearchParams({
      'filter[subject]': subject,
      'page[size]': '1',
    });
    const page = LockPage.parse(
      await this.request('GET', `locks?${query.toString()}`),
    );
    return page.data[0]?.relationships.changeSet.data.id;
  }

  /** `POST /change-sets/:id/submit`: in review, with the comment in its audit event. */
  async submit(changeSetId: string, comment: string): Promise<string> {
    const body = await this.request(
      'POST',
      `change-sets/${encodeURIComponent(changeSetId)}/submit`,
      JSON.stringify({ meta: { comment } }),
      JSON_API,
    );
    return ChangeSetResource.parse(body).data.attributes.state;
  }

  private async upload(
    bundle: Uint8Array,
    fileName: string,
    dryRun: boolean,
  ): Promise<ImportState> {
    const form = new FormData();
    form.set('importer', 'bundle');
    form.set('updateExisting', 'true');
    form.set('dryRun', String(dryRun));
    form.set(
      'file',
      new Blob([bundle as Uint8Array<ArrayBuffer>], {
        type: 'application/zip',
      }),
      fileName,
    );
    return toState(
      ImportResource.parse(await this.request('POST', 'imports', form)),
    );
  }

  private async request(
    method: string,
    path: string,
    body?: FormData | string,
    contentType?: string,
  ): Promise<unknown> {
    const response = await this.fetch(new URL(path, this.base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: JSON_API,
        ...('bearer' in this.options.credential
          ? { Authorization: `Bearer ${this.options.credential.bearer}` }
          : { Cookie: `${SESSION_COOKIE}=${this.options.credential.session}` }),
        'X-Ccms-Request': '1',
        ...(contentType && { 'Content-Type': contentType }),
      },
      ...(body !== undefined && { body }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const error = ErrorBody.safeParse(json);
      const first = error.success ? error.data.errors[0] : undefined;
      throw new ApiError(
        response.status,
        first?.code ?? 'unexpected-answer',
        (first?.detail ?? first?.title ?? response.statusText).slice(0, 500),
      );
    }
    return json;
  }
}

function toState(doc: z.output<typeof ImportResource>): ImportState {
  const { data } = doc;
  const changeSetId = data.relationships?.changeSet?.data.id;
  return {
    id: data.id,
    state: data.attributes.state,
    report: data.meta.report,
    ...(changeSetId && { changeSetId }),
    ...(data.meta.failure && { failure: data.meta.failure }),
  };
}

/**
 * The session cookie's value from a cookie file in the format curl writes
 * (`curl -c cookies.txt`, "Sign in for the import" in the import format's
 * guide): the line naming `__Host-openfolia-session` for `host` (the API's,
 * exactly, as a `__Host-` cookie is set), not expired. Undefined when there
 * is none.
 */
export function readSessionCookie(
  cookieFile: string,
  host: string,
  now: number = Date.now(),
): string | undefined {
  for (const line of cookieFile.split(/\r?\n/)) {
    const fields = line.replace(/^#HttpOnly_/, '').split('\t');
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    if (fields.length !== 7 || fields[5] !== SESSION_COOKIE) continue;
    // curl writes an IPv6 address without the brackets a URL holds.
    if (
      fields[0]?.toLowerCase() !==
      host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    )
      continue;
    const expires = Number(fields[4]);
    if (expires > 0 && expires * 1000 <= now) continue;
    const value = fields[6]?.trim();
    // A cookie value: printable, no separators, so it cannot smuggle a header.
    return value && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)
      ? value
      : undefined;
  }
  return undefined;
}
