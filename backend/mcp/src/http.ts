import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpContext } from './server.js';

/** The MCP endpoint's path. */
export const MCP_PATH = '/mcp';
/** The largest request body taken. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Requests one client address may send per window, and failed authentications. */
export const MAX_REQUESTS_PER_WINDOW = 600;
export const MAX_FAILURES_PER_WINDOW = 10;
/** Failed authentications from all addresses together per window, so spraying from many is bounded too. */
export const MAX_FAILURES_PER_WINDOW_ALL = 100;
const EVERYONE = '*';
export const WINDOW_MS = 60_000;
/** The most client addresses counted at once; past it, the counts start again. */
const MAX_ADDRESSES = 10_000;

export interface HttpOptions {
  /** The bearer token callers send (`CCMS_MCP_HTTP_TOKEN`). */
  readonly token: string;
  /** Origins a browser-based caller may send (`Origin`); any other is 403. */
  readonly allowedOrigins: readonly string[];
  /** Whether the server listens on a loopback address only: then `Host` must name one. */
  readonly loopbackOnly: boolean;
  readonly now?: () => number;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `host` is a loopback address or `localhost`. */
export function isLoopback(host: string): boolean {
  return (
    LOOPBACK_HOSTS.has(host) ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Counts per client address in fixed windows. */
class Counter {
  #counts = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  /** Whether the address is over its limit now; reads only, never adds an entry. */
  over(address: string): boolean {
    const entry = this.#current(address);
    return entry !== undefined && entry.n >= this.max;
  }

  /** Counts one, and says whether that went over the limit. */
  count(address: string): boolean {
    const entry = this.#entry(address);
    entry.n++;
    return entry.n > this.max;
  }

  /** Seconds until the address's window ends (1 when it has none). */
  retryAfter(address: string): number {
    const entry = this.#current(address);
    return entry
      ? Math.max(1, Math.ceil((entry.start + WINDOW_MS - this.now()) / 1000))
      : 1;
  }

  #current(address: string) {
    const entry = this.#counts.get(address);
    return entry && this.now() - entry.start < WINDOW_MS ? entry : undefined;
  }

  #entry(address: string) {
    const at = this.now();
    let entry = this.#counts.get(address);
    if (!entry || at - entry.start >= WINDOW_MS) {
      if (!entry && this.#counts.size >= MAX_ADDRESSES) {
        // Forget the address counted longest ago, never every count at once.
        const oldest = this.#counts.keys().next().value;
        if (oldest !== undefined) this.#counts.delete(oldest);
      }
      this.#counts.delete(address);
      entry = { start: at, n: 0 };
      this.#counts.set(address, entry);
    }
    return entry;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** A JSON-RPC error without an `id`, as the transport answers what it refuses. */
function refuse(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * The body as JSON, at most `MAX_BODY_BYTES`. Past the limit the rest is
 * drained, not the socket destroyed, so the client still gets the 413.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  const tooLarge = () => new BodyError(413, 'Request body too large');
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        over = true;
        parts.length = 0;
        reject(tooLarge());
        return;
      }
      parts.push(chunk);
    });
    req.on('error', () => reject(new BodyError(400, 'Bad request')));
    req.on('end', () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown);
      } catch {
        reject(new BodyError(400, 'Parse error: the body is no JSON'));
      }
    });
  });
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * The Streamable HTTP transport's request handler: one stateless MCP server
 * per request (no sessions), after these checks, in order: the path, the
 * `Origin` (DNS rebinding; any not allowed is 403), the `Host` when bound to
 * loopback, the client's rate, the bearer token (compared in constant time;
 * failures counted per address), the method (POST only) and the body size.
 */
export function createHttpHandler(
  context: McpContext,
  options: HttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = options.now ?? Date.now;
  const requests = new Counter(MAX_REQUESTS_PER_WINDOW, now);
  const failures = new Counter(MAX_FAILURES_PER_WINDOW, now);
  const allFailures = new Counter(MAX_FAILURES_PER_WINDOW_ALL, now);
  const expected = digest(options.token);
  const origins = new Set(options.allowedOrigins);
  return async (req, res) => {
    const address = req.socket.remoteAddress ?? 'unknown';
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return refuse(res, 404, 'Not found');
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return refuse(res, 403, 'Forbidden: origin not allowed');
    }
    if (options.loopbackOnly) {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!isLoopback(host))
        return refuse(res, 403, 'Forbidden: host not allowed');
    }
    // The token first: a caller holding it is always served, even from an
    // address others have locked out (a NAT, a proxy, this machine). Once
    // the failures of all addresses together, or of this one, run over their
    // budget, every wrong token gets the same 429, so a guess then learns
    // only that it is not the token. This does not slow guessing down: the
    // token's entropy is the defence (see `settings.ts`); the lockout bounds
    // the 401s and the noise.
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const valid =
      match !== null && timingSafeEqual(digest(match[1] ?? ''), expected);
    if (!valid) {
      // The global budget first: past it, no address is counted or looked up.
      const global = allFailures.over(EVERYONE);
      const local = !global && failures.over(address);
      if (global || local) {
        return refuse(res, 429, 'Too many failed attempts', {
          'Retry-After': String(
            global
              ? allFailures.retryAfter(EVERYONE)
              : failures.retryAfter(address),
          ),
          'WWW-Authenticate': 'Bearer',
        });
      }
      failures.count(address);
      allFailures.count(EVERYONE);
      return refuse(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    if (requests.count(address)) {
      return refuse(res, 429, 'Too many requests', {
        'Retry-After': String(requests.retryAfter(address)),
      });
    }
    if (req.method !== 'POST') {
      return refuse(res, 405, 'Method not allowed: POST only (stateless)', {
        Allow: 'POST',
      });
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      const e =
        error instanceof BodyError ? error : new BodyError(400, 'Bad request');
      return refuse(res, e.status, e.message, e.headers);
    }
    // One message per request: a batch (no longer in the protocol since
    // 2025-06-18) would make one request count as up to 100 calls.
    if (Array.isArray(body)) {
      return refuse(
        res,
        400,
        'Batches are not accepted: one message per request',
      );
    }
    const server = createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      refuse(res, 500, 'Internal error');
    }
  };
}

/** Starts the HTTP transport on `host:port`; resolves once it listens. */
export async function startHttpServer(
  context: McpContext,
  options: Omit<HttpOptions, 'loopbackOnly'> & { host: string; port: number },
): Promise<Server> {
  const handler = createHttpHandler(context, {
    ...options,
    loopbackOnly: isLoopback(options.host),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
