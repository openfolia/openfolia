import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Callers, isRefusal, SERVICE_TOKEN } from './callers.js';
import { createMcpServer, Limiter, type McpContext } from './server.js';

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
  /**
   * The context a caller reads with, made from its own token (a service
   * account's, `ccms_sat_…`, forwarded to the API on every read, #861).
   */
  readonly callerContext: (token: string) => McpContext;
  /** Origins a browser-based caller may send (`Origin`); any other is 403. */
  readonly allowedOrigins: readonly string[];
  /** Whether the server listens on a loopback address only: then `Host` must name one. */
  readonly loopbackOnly: boolean;
  /**
   * Proxies in front to believe about the client's address: that many hops
   * (`CCMS_MCP_HTTP_TRUST_PROXY`), and only from these peers
   * (`CCMS_MCP_HTTP_PROXY_ADDRESSES`). Unset: none, the connection's address.
   */
  readonly trustProxy?: { readonly hops: number; readonly proxies: Proxies };
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

/** The peers to believe `X-Forwarded-For` from (`ProxyAddresses`). */
export interface Proxies {
  has(address: string): boolean;
}

/**
 * The client's address, which the lockout and the rate limit count by: the
 * connection's, unless the connection comes from one of the `proxies`; then,
 * with `hops` trusted proxies in front, the address the outermost of them
 * saw. Each proxy appends the address it saw to `X-Forwarded-For`, so that one
 * is `hops - 1` entries from the right; what a client wrote further left is
 * never read, and a client connecting directly is never believed at all. A
 * shorter chain gives its leftmost entry, and an entry that is no IP address
 * gives the connection's.
 */
export function clientAddress(
  req: IncomingMessage,
  trust?: { readonly hops: number; readonly proxies: Proxies },
): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  const hops = trust?.hops ?? 0;
  if (hops <= 0 || !trust?.proxies.has(socket)) return socket;
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const chain = [socket, ...forwarded.reverse()];
  const address = chain[Math.min(hops, chain.length - 1)] ?? socket;
  return isIP(address) === 0 ? socket : address;
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

  /** When the address's current window started (after `count`), to `forgive` in that window only. */
  windowOf(address: string): number | undefined {
    return this.#current(address)?.start;
  }

  /** Takes back one counted in the window that started at `start`, if it still runs (a check that passed, or could not be made). */
  forgive(address: string, start: number | undefined): void {
    const entry = this.#current(address);
    if (entry && entry.start === start && entry.n > 0) entry.n--;
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

/** Checks of tokens not yet admitted one client address may have under way at once; past it, 429. */
export const MAX_CHECKS_PER_ADDRESS = 4;
/** Checks of tokens not yet admitted under way at once for everyone; more wait, up to `MAX_CHECKS_WAITING` (then 503). */
export const MAX_CHECKS_AT_ONCE = 16;
export const MAX_CHECKS_WAITING = 256;

/** How long a caller is asked to wait when its token could not be checked (the API did not answer). */
export const CHECK_RETRY_AFTER_S = 5;

/**
 * The Streamable HTTP transport's request handler: one stateless MCP server
 * per request (no sessions), after these checks, in order: the path, the
 * `Origin` (DNS rebinding; any not allowed is 403), the `Host` when bound to
 * loopback, the bearer token (failures counted per client address,
 * `clientAddress`), the client's rate, the method (POST only) and the body
 * size. The token is the caller's own service account token, checked by the
 * API (`Callers`).
 */
export function createHttpHandler(
  options: HttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = options.now ?? Date.now;
  const requests = new Counter(MAX_REQUESTS_PER_WINDOW, now);
  const failures = new Counter(MAX_FAILURES_PER_WINDOW, now);
  const allFailures = new Counter(MAX_FAILURES_PER_WINDOW_ALL, now);
  const callers = new Callers(options.callerContext, now);
  const checks = new Limiter(MAX_CHECKS_AT_ONCE, MAX_CHECKS_WAITING);
  const checking = new Map<string, number>();
  const origins = new Set(options.allowedOrigins);
  return async (req, res) => {
    const address = clientAddress(req, options.trustProxy);
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
    // The token first. A caller already admitted with its own token is always served, even from an address others
    // have locked out (a NAT, a proxy, this machine). Any other token costs a
    // failed attempt of its address up front, taken back when the API accepts
    // it or cannot say, so checks under way count too. A token of no service
    // account's form is refused here; past the failures of all addresses
    // together, or of this one, every such token gets the same 429, so a
    // guess then learns only that it is not a token. A service account's
    // token not yet admitted is bounded by its address alone (its failures,
    // its rate, `MAX_CHECKS_PER_ADDRESS` at once) and by `MAX_CHECKS_AT_ONCE`
    // for everyone, which queues: never by the global budget, so a flood of
    // wrong tokens from many addresses cannot lock a new real caller out.
    // This does not slow guessing down: the tokens' entropy is the defence
    // (256 random bits).
    const header = req.headers.authorization ?? '';
    const presented = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const sent = presented === undefined ? undefined : digest(presented);
    const key = sent?.toString('hex');
    let context: McpContext | undefined;
    const own =
      presented !== undefined &&
      key !== undefined &&
      SERVICE_TOKEN.test(presented);
    const known = own && key !== undefined && callers.known(key);
    // Whether this request holds a failed attempt counted up front.
    let counted = false;
    let countedIn: number | undefined;
    if (!known) {
      // The global budget first (not for a service token): past it, no address is counted or looked up.
      const global = !own && allFailures.over(EVERYONE);
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
      if (!own) allFailures.count(EVERYONE);
      counted = true;
      countedIn = failures.windowOf(address);
      if (!own) {
        return refuse(res, 401, 'Unauthorized', {
          'WWW-Authenticate': 'Bearer',
        });
      }
    }
    const forgive = () => {
      if (!counted) return;
      counted = false;
      failures.forgive(address, countedIn);
    };
    if (requests.count(address)) {
      forgive();
      return refuse(res, 429, 'Too many requests', {
        'Retry-After': String(requests.retryAfter(address)),
      });
    }
    if (own && presented !== undefined && key) {
      const under = checking.get(address) ?? 0;
      if (!known && under >= MAX_CHECKS_PER_ADDRESS) {
        forgive();
        return refuse(res, 429, 'Too many token checks at once', {
          'Retry-After': String(CHECK_RETRY_AFTER_S),
        });
      }
      // Only checks of tokens not yet admitted take a place (an admitted caller's re-check none).
      if (!known) checking.set(address, under + 1);
      try {
        context = await (known
          ? callers.admit(presented, key)
          : checks.run(() => callers.admit(presented, key)));
        forgive();
      } catch (error) {
        // The API's own code and status (`token-revoked`, `token-not-read-only`, …), never the token.
        if (isRefusal(error)) {
          if (!counted) failures.count(address);
          if (error.code === 'token-not-read-only') {
            return refuse(
              res,
              403,
              `Forbidden: token-not-read-only: ${error.detail ?? error.title}`,
            );
          }
          // The API locking this server's address out (only wrong tokens get that there).
          if (error.status === 429) {
            return refuse(res, 429, 'Too many failed attempts', {
              'Retry-After': String(error.retryAfter ?? CHECK_RETRY_AFTER_S),
            });
          }
          return error.status === 403
            ? refuse(res, 403, `Forbidden: ${error.code}`)
            : refuse(res, 401, `Unauthorized: ${error.code}`, {
                'WWW-Authenticate': 'Bearer',
              });
        }
        // The API could not say (down, slow, a 5xx), or too many checks wait: nothing is counted against the caller.
        forgive();
        return refuse(
          res,
          503,
          'The token could not be checked now (the content API did not answer, or too many checks are under way); try again shortly',
          { 'Retry-After': String(CHECK_RETRY_AFTER_S) },
        );
      } finally {
        if (!known) {
          const left = (checking.get(address) ?? 1) - 1;
          if (left > 0) checking.set(address, left);
          else checking.delete(address);
        }
      }
    }
    if (context === undefined) return refuse(res, 500, 'Internal error');
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
  options: Omit<HttpOptions, 'loopbackOnly'> & { host: string; port: number },
): Promise<Server> {
  const handler = createHttpHandler({
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
