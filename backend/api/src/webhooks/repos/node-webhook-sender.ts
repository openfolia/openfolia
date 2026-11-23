import { Resolver } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  type OutgoingRequest,
  type SendResult,
  WebhookSender,
} from '../core/webhook-ports.js';
import {
  allowedScheme,
  blockedAddress,
  hostAddress,
  type UrlRules,
} from '../core/webhook-url.js';

/** One address a name resolves to. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Resolves a host name to every address it has; stops when `signal` aborts.
 */
export type Resolve = (
  hostname: string,
  signal: AbortSignal,
) => Promise<ResolvedAddress[]>;

/** Answers that mean "no such address", not "the resolver failed". */
const NO_ADDRESS = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * The A and AAAA records over DNS (c-ares, not the system's `getaddrinfo`):
 * a lookup is cancelled when the attempt is cut off, so a name server that
 * never answers holds no thread of the pool the rest of the server uses
 * (files, crypto). `/etc/hosts` is not read.
 */
const dnsResolve: Resolve = async (hostname, signal) => {
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const found: ResolvedAddress[] = [];
    let failed: unknown;
    answers.forEach((answer, i) => {
      if (answer.status === 'fulfilled') {
        for (const address of answer.value) {
          found.push({ address, family: i === 0 ? 4 : 6 });
        }
      } else if (
        !NO_ADDRESS.has((answer.reason as { code?: string }).code ?? '')
      ) {
        failed = answer.reason;
      }
    });
    if (found.length === 0 && failed !== undefined) throw failed;
    return found;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

/** The most bytes of the answer's status line and headers read; the body is never read. */
export const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

/**
 * `WebhookSender` over Node's `http` and `https`, guarding against server-
 * side request forgery:
 *
 * - The host is resolved once, here; when any address it resolves to is
 *   blocked (`blockedAddress`: private, loopback, link-local, …) the
 *   request is refused (`blocked-address`) unless `allowPrivate`. The
 *   connection then goes to the address checked (a `lookup` that answers
 *   only it), so DNS cannot point it elsewhere between check and connect
 *   (rebinding); TLS still checks the certificate against the host name.
 * - No redirect is followed (Node never does): a 3xx is a failed attempt.
 * - No connection is reused (`agent: false`), the whole attempt is cut off
 *   after `timeoutMs`, at most `MAX_RESPONSE_HEADER_BYTES` of the answer's
 *   head are read, and its body is never read.
 *
 * Nothing it logs or answers holds the URL, a header or the body.
 */
export class NodeWebhookSender extends WebhookSender {
  constructor(
    private readonly rules: UrlRules,
    private readonly timeoutMs: number,
    private readonly resolve: Resolve = dnsResolve,
  ) {
    super();
  }

  async send(request: OutgoingRequest): Promise<SendResult> {
    const fail = (
      error: Extract<SendResult, { ok: false }>['error'],
      statusCode: number | null = null,
    ): SendResult => ({ ok: false, error, statusCode });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return fail('blocked-url');
    }
    if (!allowedScheme(url, this.rules) || url.username || url.password) {
      return fail('blocked-url');
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    try {
      const target = await this.addressOf(url.hostname, signal);
      if (target === 'blocked') return fail('blocked-address');
      if (target === undefined) return fail('connection');
      const status = await this.post(url, target, request, signal);
      if (status === 'timeout') return fail('timeout');
      if (status === 'connection' || status < 100 || status > 599) {
        return fail('connection');
      }
      return status >= 200 && status < 300
        ? { ok: true, statusCode: status }
        : fail('http-status', status);
    } catch {
      return fail(timeout.signal.aborted ? 'timeout' : 'connection');
    } finally {
      clearTimeout(timer);
    }
  }

  /** The address to connect to; `blocked` when any address of the host is; undefined when it resolves to none. */
  private async addressOf(
    hostname: string,
    signal: AbortSignal,
  ): Promise<ResolvedAddress | 'blocked' | undefined> {
    const literal = hostAddress(hostname);
    const found: ResolvedAddress[] = literal
      ? [{ address: literal, family: literal.includes(':') ? 6 : 4 }]
      : await Promise.race([
          this.resolve(hostname, signal),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              {
                once: true,
              },
            );
          }),
        ]);
    if (found.length === 0) return undefined;
    if (
      !this.rules.allowPrivate &&
      found.some((a) => blockedAddress(a.address))
    ) {
      return 'blocked';
    }
    return found[0];
  }

  private post(
    url: URL,
    target: ResolvedAddress,
    request: OutgoingRequest,
    signal: AbortSignal,
  ): Promise<number | 'timeout' | 'connection'> {
    // Answers only the address checked, whatever is asked.
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (
          callback as unknown as (
            err: null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, [{ address: target.address, family: target.family }]);
      } else {
        callback(null, target.address, target.family);
      }
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = Buffer.from(request.body, 'utf8');
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: number | 'timeout' | 'connection') => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = send(
        url,
        {
          method: 'POST',
          headers: {
            ...request.headers,
            'Content-Length': String(body.length),
          },
          lookup: pinned,
          agent: false,
          maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
          signal,
        },
        (res: IncomingMessage) => {
          done(res.statusCode ?? 0);
          // The body is never read.
          res.destroy();
          req.destroy();
        },
      );
      req.on('error', () => done(signal.aborted ? 'timeout' : 'connection'));
      req.end(body);
    });
  }
}
