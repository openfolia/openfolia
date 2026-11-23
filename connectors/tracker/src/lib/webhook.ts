import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * The trigger from the source (#141): instead of waiting for its schedule, the
 * connector starts a run when the source system calls it. The call is signed
 * with a secret the source and the connector share, and nothing in its body is
 * read: it only says "something changed", and the run fetches from the source
 * as any run does. So a trigger can never put content into the bundle; the
 * worst a caller with the secret can do is ask for runs, which are queued one
 * after the other and spaced out.
 */

/** The header holding the signature: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`. */
export const TRIGGER_SIGNATURE_HEADER = 'X-Openfolia-Signature';
/** The one route the listener answers. */
export const TRIGGER_PATH = '/trigger';
/** How far a signature's time may lie from the connector's clock. */
export const TRIGGER_TOLERANCE_SECONDS = 5 * 60;
/**
 * How far a signature's time may lie ahead of the connector's clock: little,
 * so a request seen before a restart cannot be replayed after it (the
 * replay guard is in memory, the start time bounds the past).
 */
export const TRIGGER_FUTURE_SKEW_SECONDS = 60;
/** The shortest secret the listener accepts. */
export const TRIGGER_SECRET_MIN_LENGTH = 32;
/** The largest body read (it is signed, never parsed). */
export const TRIGGER_MAX_BODY_BYTES = 64 * 1024;

/**
 * The signature of `body` at `timestamp`: HMAC-SHA256 keyed with the secret
 * (UTF-8), over `<timestamp>.<body>` (decimal Unix seconds, a full stop, the
 * raw body bytes), as lowercase hex. The same recipe as the API's outbound
 * webhooks (`backend/api/README.md`, "Webhooks").
 */
export function signTrigger(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
}

/** The header's value for `body`, signed now (for a source, or a test). */
export function triggerSignatureHeader(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): string {
  return `t=${timestamp},v1=${signTrigger(secret, timestamp, body)}`;
}

export type SignatureCheck =
  /** `key` names this signed request, for the replay guard. */
  | { readonly ok: true; readonly key: string; readonly expiresAt: number }
  | {
      readonly ok: false;
      readonly code:
        'signature-missing' | 'signature-expired' | 'signature-invalid';
    };

/**
 * Checks a trigger's signature header against its raw body: a `t` within
 * `toleranceSeconds` before now (at most a minute ahead) and not before `notBefore` (the listener's start,
 * so a restart cannot reopen the window of a request it saw before), and a
 * `v1` matching the HMAC, compared in constant time.
 */
export function checkTriggerSignature(
  header: string | undefined,
  body: Uint8Array,
  secret: string,
  options: {
    readonly now: number;
    readonly notBefore?: number;
    readonly toleranceSeconds?: number;
  },
): SignatureCheck {
  if (!header) return { ok: false, code: 'signature-missing' };
  const now = Math.floor(options.now / 1000);
  const tolerance = options.toleranceSeconds ?? TRIGGER_TOLERANCE_SECONDS;
  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(',').slice(0, 8)) {
    const [key, value = ''] = part.trim().split('=', 2);
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      candidates.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === undefined || candidates.length === 0) {
    return { ok: false, code: 'signature-missing' };
  }
  const notBefore =
    options.notBefore === undefined
      ? -Infinity
      : Math.floor(options.notBefore / 1000);
  if (
    now - timestamp > tolerance ||
    timestamp - now > TRIGGER_FUTURE_SKEW_SECONDS ||
    timestamp < notBefore
  ) {
    return { ok: false, code: 'signature-expired' };
  }
  const expected = signTrigger(secret, timestamp, body);
  const expectedBytes = Buffer.from(expected, 'hex');
  let match = false;
  // Every candidate is compared, so the time taken says nothing about which.
  for (const c of candidates)
    match = timingSafeEqual(c, expectedBytes) || match;
  if (!match) return { ok: false, code: 'signature-invalid' };
  return {
    ok: true,
    key: expected,
    expiresAt: (timestamp + tolerance + 1) * 1000,
  };
}

/**
 * The signed requests already accepted, until their signature expires: the
 * same request sent again is refused. Bounded: when full of live entries,
 * it refuses new ones rather than forgetting one (which would let it be
 * replayed).
 */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}

  /** `accepted` the first time a key is seen; `replayed` again; `full` when no room is left. */
  admit(
    key: string,
    expiresAt: number,
    now: number,
  ): 'accepted' | 'replayed' | 'full' {
    const seen = this.#seen.get(key);
    if (seen !== undefined && seen > now) return 'replayed';
    if (this.#seen.size >= this.max) {
      for (const [k, until] of this.#seen)
        if (until <= now) this.#seen.delete(k);
      if (this.#seen.size >= this.max) return 'full';
    }
    this.#seen.set(key, expiresAt);
    return 'accepted';
  }
}

/**
 * A fixed window per caller (its address): at most `limit` requests per
 * `windowMs`. `take` answers how many seconds to wait, or 0 when the request
 * may go on. Bounded: when as many callers as `maxCallers` are in their
 * window, a new one waits too.
 */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxCallers = 10_000,
  ) {}

  take(caller: string, now: number): number {
    let window = this.#windows.get(caller);
    if (!window || now - window.start >= this.windowMs) {
      if (!window && this.#windows.size >= this.maxCallers) {
        for (const [k, w] of this.#windows) {
          if (now - w.start >= this.windowMs) this.#windows.delete(k);
        }
        if (this.#windows.size >= this.maxCallers) {
          return Math.ceil(this.windowMs / 1000);
        }
      }
      window = { start: now, count: 0 };
      this.#windows.set(caller, window);
    }
    if (window.count >= this.limit) {
      return Math.max(
        1,
        Math.ceil((window.start + this.windowMs - now) / 1000),
      );
    }
    window.count += 1;
    return 0;
  }
}

/** What a request for a run did. */
export type RunRequest =
  /** A run is now wanted: it starts at once, after the shortest gap, or after the one under way. */
  | 'queued'
  /** A run that has not started yet already covers it. */
  | 'already-queued'
  /** The queue is stopping. */
  | 'stopped';

export interface RunQueueOptions {
  /** One run; what it prints and how it fails is its own. */
  readonly run: () => Promise<void>;
  /** The shortest time from one run's start to the next one's (default 0). */
  readonly minGapMs?: number;
  readonly now?: () => number;
  /** Waits out the gap; resolves early when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Runs one after the other, never two at once. Requests while a run is
 * waiting to start fold into it; a request while one is under way wants one
 * more after it (what changed during the run may be past what it read). So
 * any number of triggers gives at most one run under way and one waiting.
 */
export class RunQueue {
  readonly #run: () => Promise<void>;
  readonly #minGapMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;
  #wanted = false;
  #lastStart = -Infinity;

  constructor(options: RunQueueOptions) {
    this.#run = options.run;
    this.#minGapMs = options.minGapMs ?? 0;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  request(): RunRequest {
    if (this.#stop.signal.aborted) return 'stopped';
    if (this.#wanted) return 'already-queued';
    this.#wanted = true;
    this.#loop ??= this.#drain();
    return 'queued';
  }

  /** Resolves once no run is under way or wanted. */
  idle(): Promise<void> {
    return this.#loop ?? Promise.resolve();
  }

  /** Drops the run that is waiting and resolves after the one under way. */
  stop(): Promise<void> {
    this.#stop.abort();
    return this.idle();
  }

  async #drain(): Promise<void> {
    // After `request` has kept this loop, even when the run throws at once.
    await Promise.resolve();
    try {
      while (this.#wanted && !this.#stop.signal.aborted) {
        const wait = this.#lastStart + this.#minGapMs - this.#now();
        if (wait > 0) await this.#sleep(wait, this.#stop.signal);
        if (this.#stop.signal.aborted) break;
        this.#wanted = false;
        this.#lastStart = this.#now();
        try {
          await this.#run();
        } catch {
          // A run reports its own failure; the queue goes on.
        }
      }
    } finally {
      this.#wanted = false;
      this.#loop = undefined;
    }
  }
}

export interface TriggerListenerOptions {
  readonly secret: string;
  readonly queue: RunQueue;
  /** Refused requests per caller (by address) and minute before it gets 429 (default 60). */
  readonly perMinute?: number;
  readonly now?: () => number;
  /** A line for each refused or accepted trigger (never the secret or a signature). */
  readonly log?: (line: string) => void;
}

/**
 * The listener for triggers: `POST /trigger` with a signed body answers
 * 202 at once and queues a run; it never waits for the run. Refused:
 * another route (404) or method (405), more than 60 refused requests a minute from one address
 * (429, `Retry-After`), a body over 64 KiB (413), a missing, expired or
 * wrong signature (401), the same signed request again (409).
 */
export function createTriggerListener(options: TriggerListenerOptions): Server {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const limiter = new RateLimiter(options.perMinute ?? 60, 60_000);
  const replays = new ReplayGuard();
  const log = options.log ?? (() => undefined);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path !== TRIGGER_PATH) return reply(res, 404, { error: 'not-found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'method-not-allowed' });
    }
    const caller = req.socket.remoteAddress ?? 'unknown';
    /**
     * Only refused requests count against their address: a caller without
     * the secret cannot use up the source's budget (behind a proxy every
     * request has the proxy's address). Signed ones are spaced out by the
     * replay guard and the queue instead.
     */
    const refuse = (status: number, error: string, close = false) => {
      const wait = limiter.take(caller, now());
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        return reply(res, 429, { error: 'too-many-requests' }, close);
      }
      log(`Trigger refused (${error}) from ${caller}.`);
      return reply(res, status, { error }, close);
    };
    const body = await readBody(req, TRIGGER_MAX_BODY_BYTES);
    if (body === undefined) {
      return refuse(413, 'body-too-large', true);
    }
    const header = req.headers[TRIGGER_SIGNATURE_HEADER.toLowerCase()];
    const check = checkTriggerSignature(
      Array.isArray(header) ? header[0] : header,
      body,
      options.secret,
      { now: now(), notBefore: startedAt },
    );
    if (!check.ok) return refuse(401, check.code);
    const admitted = replays.admit(check.key, check.expiresAt, now());
    if (admitted === 'replayed') return refuse(409, 'replayed');
    if (admitted === 'full') {
      res.setHeader('Retry-After', '60');
      return reply(res, 429, { error: 'too-many-requests' });
    }
    const run = options.queue.request();
    if (run === 'stopped') return reply(res, 503, { error: 'stopping' });
    if (run === 'queued') log('Trigger accepted: a run is queued.');
    return reply(res, 202, { run });
  };

  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 },
    (req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: 'internal' }, true);
        else res.destroy();
      });
    },
  );
  server.keepAliveTimeout = 5_000;
  return server;
}

function reply(
  res: ServerResponse,
  status: number,
  body: Record<string, string>,
  close = false,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (close) res.setHeader('Connection', 'close');
  res.end(JSON.stringify(body));
}

/** The raw body, or undefined once it is over `max` bytes (the rest is not read). */
function readBody(
  req: IncomingMessage,
  max: number,
): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.pause();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parses `--listen`: a port (on 127.0.0.1), or `<host>:<port>` (`[<v6>]:<port>`). */
export function parseListen(
  value: string,
): { host: string; port: number } | undefined {
  const match = /^(?:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):)?(\d{1,5})$/.exec(
    value,
  );
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port > 65535) return undefined;
  const host = (match[1] ?? '127.0.0.1').replace(/^\[|\]$/g, '');
  return { host, port };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
