import { z } from 'zod';

/** The JSON:API media type the API speaks. */
export const JSON_API = 'application/vnd.api+json';

/**
 * The header naming what a request is for (#877): `mcp` for this server's own
 * lookups (the token check, the lists of releases), `mcp/<tool>` for a tool's
 * reads, `mcp/resources/list` and `mcp/resources/read`. The API records it in
 * the service account's read events, beside the account the token names.
 */
export const CLIENT_HEADER = 'X-OpenFolia-Client';
/** What this server's own requests are named by. */
export const MCP_CLIENT = 'mcp';

/** How long one API request may take before it is given up. */
export const API_TIMEOUT_MS = 30_000;
/** The largest API response read; a longer one is an error, never read on. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * A refusal or failure, as a tool reports it: the API's `status` and stable
 * `code` (`not-found`, `forbidden`, `too-many-failed-attempts`, …), or one of
 * this server's own (`ref-not-released`, `api-unavailable`, …). Never a stack
 * trace, never the token.
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(detail ?? title);
    this.name = 'ToolError';
  }
}

const ErrorDocument = z.object({
  errors: z
    .array(
      z.looseObject({
        status: z.string().optional(),
        code: z.string().optional(),
        title: z.string().optional(),
        detail: z.string().optional(),
        meta: z.looseObject({ retryAfter: z.number().optional() }).optional(),
      }),
    )
    .min(1),
});

/** A query: a value, or several for a repeatable parameter (`filter[facet]`). */
export type Query = Record<string, string | readonly string[] | undefined>;

export interface ApiResponse {
  readonly body: unknown;
  /** `X-Ccms-Commit`: the commit a content read was answered from. */
  readonly commit: string | undefined;
}

/** What the tools read the API through; a stub stands in for it in unit tests. */
export interface ContentApi {
  /** The API's base URL, for links in results. */
  readonly baseUrl: string;
  /**
   * A GET of `path` (segments already encoded) with `query`; JSON:API
   * errors become `ToolError`s. `signal` gives it up (the call was
   * cancelled, or ran past its deadline). `client` names what it is for
   * (`CLIENT_HEADER`; default `mcp`).
   */
  get(
    path: string,
    query?: Query,
    signal?: AbortSignal,
    client?: string,
  ): Promise<ApiResponse>;
}

/**
 * The API over HTTP with one service account's token: every call sends it,
 * so the API checks it (and its account's roles and scope) on every request.
 * Only GETs: this server never writes.
 */
export class HttpContentApi implements ContentApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async get(
    path: string,
    query: Query = {},
    signal?: AbortSignal,
    client: string = MCP_CLIENT,
  ): Promise<ApiResponse> {
    if (signal?.aborted) throw cancelled();
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const v of typeof value === 'string' ? [value] : value) {
        url.searchParams.append(name, v);
      }
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: JSON_API,
          [CLIENT_HEADER]: client,
        },
        // A redirect would carry the token elsewhere: the API never answers with one.
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
          : AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      if (signal?.aborted) throw cancelled();
      throw new ToolError(
        'api-unavailable',
        'The content API could not be reached',
        `No answer from the content API within ${API_TIMEOUT_MS / 1000} s.`,
      );
    }
    let body: unknown;
    try {
      body = await readJson(res);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    }
    if (!res.ok) throw errorOf(res, body);
    return { body, commit: res.headers.get('x-ccms-commit') ?? undefined };
  }
}

function cancelled(): ToolError {
  return new ToolError(
    'cancelled',
    'The call was cancelled or ran past its deadline',
  );
}

/** The body as JSON, at most `MAX_RESPONSE_BYTES`; undefined when there is none or it is no JSON. */
async function readJson(res: Response): Promise<unknown> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      throw new ToolError(
        'api-unavailable',
        'The content API’s answer broke off',
      );
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ToolError(
        'response-too-large',
        'The content API’s answer is too large',
        `More than ${MAX_RESPONSE_BYTES} bytes.`,
      );
    }
    parts.push(chunk.value);
  }
  const text = Buffer.concat(parts).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorOf(res: Response, body: unknown): ToolError {
  const parsed = ErrorDocument.safeParse(body);
  const first = parsed.success ? parsed.data.errors[0] : undefined;
  const header = Number(res.headers.get('retry-after'));
  const retryAfter =
    first?.meta?.retryAfter ??
    (Number.isFinite(header) && header > 0 ? header : undefined);
  return new ToolError(
    first?.code ?? `http-${res.status}`,
    first?.title ?? (res.statusText || 'The content API refused the request'),
    first?.detail,
    res.status,
    retryAfter,
  );
}

/** Path segments, each percent-encoded: `segments('modules', 'en', 'x')` is `/modules/en/x`. */
export function segments(...parts: string[]): string {
  return parts.map((p) => '/' + encodeURIComponent(p)).join('');
}

/** A JSON:API list page as the tools read it (`meta.page`; extend it with `data`). */
export const Paged = z.looseObject({
  meta: z.looseObject({
    page: z.looseObject({
      currentPage: z.number(),
      lastPage: z.number(),
      perPage: z.number(),
      total: z.number(),
    }),
  }),
});

/** Parses an API answer, failing as a tool error (never with the body) when it is not as expected. */
export function parseAnswer<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const at = parsed.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.') || '(the body)');
    throw new ToolError(
      'unexpected-answer',
      'The content API answered in an unexpected form',
      `Unexpected at: ${at.join(', ')}.`,
    );
  }
  return parsed.data;
}
