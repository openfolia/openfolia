/**
 * The portal build's client of the API: the read routes only, as a service account. The token
 * is sent in the `Authorization` header and nowhere else: never in a URL, a log line or an
 * error message, and never to another origin (redirects are refused, so a redirect cannot
 * carry it elsewhere).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface JsonApiResource {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface ApiClientOptions {
  /** One request's time limit; default 30 s. */
  readonly timeoutMs?: number;
  /** Retries of a 429 or 503 (after `Retry-After`, at most 30 s) or a network error; default 3. */
  readonly retries?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const JSON_API = 'application/vnd.api+json';
/** Pages of lists: the API's most. */
const PAGE_SIZE = 200;
/** A list with more pages than this is refused rather than read without end. */
const MAX_PAGES = 1000;
/** A response body larger than this is refused (images and attachments included). */
const MAX_BYTES = 256 * 1024 * 1024;

export class ApiClient {
  readonly #token: string;
  readonly #base: URL;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(base: URL, token: string, options: ApiClientOptions = {}) {
    this.#base = base;
    this.#token = token;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 3;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Never shows the token, whatever prints the client. */
  toJSON(): string {
    return `ApiClient(${this.#base.origin})`;
  }

  /** A JSON:API document. */
  async json(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await this.#request(path, query, JSON_API);
    const text = new TextDecoder().decode(await read(response, path));
    try {
      return JSON.parse(text);
    } catch {
      // Not the parser's message: it quotes the body.
      throw new ApiError(
        `${path}: the API answered with no JSON`,
        response.status,
        undefined,
      );
    }
  }

  /** A single resource's `data`. */
  async resource(
    path: string,
    query: Record<string, string> = {},
  ): Promise<JsonApiResource> {
    return dataOf(await this.json(path, query), path) as JsonApiResource;
  }

  /** Every resource of a paged list, page by page. */
  async list(
    path: string,
    query: Record<string, string> = {},
  ): Promise<JsonApiResource[]> {
    const all: JsonApiResource[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const doc = (await this.json(path, {
        ...query,
        'page[size]': String(PAGE_SIZE),
        'page[number]': String(page),
      })) as { data?: unknown; meta?: { page?: { lastPage?: unknown } } };
      const data = dataOf(doc, path);
      if (!Array.isArray(data))
        throw new ApiError(`${path}: not a list`, 200, undefined);
      all.push(...(data as JsonApiResource[]));
      const last = doc.meta?.page?.lastPage;
      if (typeof last !== 'number' || page >= last) return all;
    }
    throw new ApiError(`${path}: more than ${MAX_PAGES} pages`, 200, undefined);
  }

  /** A binary answer (an image, an attached file) with its media type. */
  async bytes(
    path: string,
    query: Record<string, string> = {},
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.#request(path, query, '*/*');
    return {
      bytes: await read(response, path),
      contentType: (response.headers.get('content-type') ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase(),
    };
  }

  async #request(
    path: string,
    query: Record<string, string>,
    accept: string,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.#base);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    if (url.origin !== this.#base.origin)
      throw new ApiError(`${path}: not a path of the API`, 0, undefined);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: { Authorization: `Bearer ${this.#token}`, Accept: accept },
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        if (attempt < this.#retries) {
          await this.#sleep(1000 * 2 ** attempt);
          continue;
        }
        // The cause's message only: a network error never holds the request's headers.
        throw new ApiError(
          `${path}: ${error instanceof Error ? error.name : 'request failed'} (${error instanceof Error ? error.message : ''})`,
          0,
          undefined,
        );
      }
      if (response.ok) return response;
      if (
        (response.status === 429 || response.status === 503) &&
        attempt < this.#retries
      ) {
        const wait = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.#sleep(
          Math.min(
            Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000,
            30_000,
          ),
        );
        continue;
      }
      throw await apiError(path, response);
    }
  }
}

function dataOf(doc: unknown, path: string): unknown {
  if (typeof doc !== 'object' || doc === null || !('data' in doc))
    throw new ApiError(`${path}: not a JSON:API document`, 200, undefined);
  return (doc as { data: unknown }).data;
}

async function read(response: Response, path: string): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    await response.body?.cancel();
    throw new ApiError(
      `${path}: larger than ${MAX_BYTES} bytes`,
      response.status,
      undefined,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES)
      throw new ApiError(
        `${path}: larger than ${MAX_BYTES} bytes`,
        response.status,
        undefined,
      );
    chunks.push(chunk);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/** The error the API answered, by its stable code: its detail text is the server's, its code ours to branch on. */
async function apiError(path: string, response: Response): Promise<ApiError> {
  let code: string | undefined;
  try {
    const doc = (await response.json()) as { errors?: { code?: unknown }[] };
    const first = doc.errors?.[0]?.code;
    if (typeof first === 'string' && /^[a-z0-9-]{1,100}$/.test(first))
      code = first;
  } catch {
    // Not JSON: the status says enough.
  }
  return new ApiError(
    `${path}: the API answered ${response.status}${code === undefined ? '' : ` ${code}`}`,
    response.status,
    code,
  );
}
