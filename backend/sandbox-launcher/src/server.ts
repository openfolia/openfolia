// The launcher's HTTP server: the start page and its API under /_demo/, and everything else
// proxied to the visitor's own sandbox, found by their cookie alone. Without a live sandbox every
// address answers the start page, so a sandbox's address shared with anyone else opens nothing.
import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { addressKey, clientAddress } from './address.js';
import { type Asset, FILM_FILE, FILM_TYPES, findFilms } from './assets.js';
import type { Logger } from './log.js';
import {
  type ChromeOptions,
  type Ended,
  renderDataPage,
  renderPage,
} from './page.js';
import { ProofOfWork } from './pow.js';
import { RateLimiter } from './rate.js';
import { END_PATH, SANDBOX_LANGS, type SandboxLang } from './runtime.js';
import type { Sandboxes, Session } from './sandboxes.js';
import type { LauncherSettings } from './settings.js';
import { PAGE_LANGS, type PageLang } from './texts.js';

/** The session cookie: `__Host-` keeps it to this host, its path `/`, and Secure. */
export const COOKIE = '__Host-openfolia-demo';
/** The largest request body passed on to a sandbox (uploads are off there anyway). */
const MAX_BODY = 16 * 1024 * 1024;
/** The largest body the launcher's own API reads. */
const MAX_API_BODY = 2048;
/** Requests that are not a visitor's activity: the editor's own sandbox status and health. */
// What an open tab asks on its own does not keep a sandbox: the same list as the API's own idle
// clock (backend/api/src/sandbox/sandbox.module.ts), so the two agree on when it ends.
const QUIET =
  /^\/(?:api\/(?:sandbox|health|me\/notifications\/unread-count)(?:[/?]|$)|healthz$)/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface LauncherDeps {
  readonly settings: LauncherSettings;
  readonly sandboxes: Sandboxes;
  readonly assets: ReadonlyMap<string, Asset>;
  readonly log: Logger;
  readonly now?: () => number;
}

export function createLauncherServer(deps: LauncherDeps): Server {
  const { settings, sandboxes, assets, log } = deps;
  const now = deps.now ?? Date.now;
  const key = randomBytes(32);
  const pow = new ProofOfWork(key, settings.powBits, now);
  // Every request to the launcher's own pages and API, per address.
  const pageRate = new RateLimiter(
    settings.ratePerSecond,
    settings.ratePerSecond * 10,
    now,
  );
  // Challenges and starts, per address: a handful a minute.
  const startRate = new RateLimiter(1 / 6, 10, now);
  // A sandbox's requests, per sandbox: the rows that grow with each request (the audit log) grow slowly.
  const sandboxRate = new RateLimiter(
    settings.ratePerSecond,
    settings.ratePerSecond * 10,
    now,
  );
  const https = settings.publicUrl.protocol === 'https:';
  const origin = settings.publicUrl.origin;
  const films = {
    en: findFilms(settings.filmsDir, 'en'),
    de: findFilms(settings.filmsDir, 'de'),
  };
  // The limits count an address by its keyed hash; the address itself is neither kept nor logged.
  const addressHash = (addressKey: string) =>
    createHmac('sha256', settings.addressSecret)
      .update(addressKey)
      .digest('base64url');

  const ownHeaders = (): OutgoingHttpHeaders => ({
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-frame-options': 'DENY',
    ...(https
      ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
      : {}),
  });

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: OutgoingHttpHeaders = {},
  ) => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      ...ownHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(data),
      ...extra,
    });
    res.end(data);
  };

  const cookie = (token: string) =>
    `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${settings.maxMinutes * 60}`;
  const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

  function pageLang(req: IncomingMessage, url: URL): PageLang {
    const asked = url.searchParams.get('lang');
    if (asked && (PAGE_LANGS as readonly string[]).includes(asked))
      return asked as PageLang;
    const accept = req.headers['accept-language'] ?? '';
    for (const part of accept.split(',')) {
      const tag = part.split(';')[0]?.trim().toLowerCase().slice(0, 2);
      if (tag && (PAGE_LANGS as readonly string[]).includes(tag))
        return tag as PageLang;
    }
    return 'en';
  }

  /**
   * The start page. `?ended=closed|expired`, where the end route sends the visitor, opens the
   * "thanks" dialog; so does a cookie that names a sandbox that has gone (idle, its maximum, a
   * restart: `expired`), which clears the cookie.
   */
  function startPage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    expired: boolean,
  ) {
    const lang = pageLang(req, url);
    const { capacity, free } = sandboxes.status();
    const asked = url.searchParams.get('ended');
    const ended: Ended | undefined =
      asked === 'closed' || asked === 'expired'
        ? asked
        : expired
          ? 'expired'
          : undefined;
    const html = renderPage({
      ...chrome(lang),
      capacity,
      free,
      films: films[lang],
      ended,
      bookingUrl: settings.bookingUrl?.href,
    });
    sendPage(
      req,
      res,
      lang,
      html,
      expired ? { 'set-cookie': clearCookie } : {},
    );
  }

  /** Where the end route sends the visitor: the start page with the "thanks" dialog. */
  function endedPage(ended: Ended, lang: unknown): string {
    const query = new URLSearchParams({ ended });
    if (
      typeof lang === 'string' &&
      (PAGE_LANGS as readonly string[]).includes(lang)
    )
      query.set('lang', lang);
    return `/?${query}`;
  }

  function chrome(lang: PageLang): ChromeOptions {
    return {
      lang,
      idleMinutes: settings.idleMinutes,
      maxMinutes: settings.maxMinutes,
      perAddress: settings.perAddress,
      perAddressDaily: settings.perAddressDaily,
      docsUrl: settings.docsUrl
        ? new URL(lang === 'de' ? 'de/' : '', settings.docsUrl).href
        : undefined,
      homepageUrl: settings.homepageUrl?.href,
      imprintUrl: settings.imprintUrl?.href,
      privacyUrl: settings.privacyUrl?.href,
      portalUrl: settings.portalUrl?.href,
      abuseContact: settings.abuseContact,
    };
  }

  function sendPage(
    req: IncomingMessage,
    res: ServerResponse,
    lang: PageLang,
    html: string,
    extra: OutgoingHttpHeaders = {},
  ) {
    res.writeHead(200, {
      ...ownHeaders(),
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-language': lang,
      vary: 'Accept-Language, Cookie',
      'content-length': Buffer.byteLength(html),
      ...extra,
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  /** The launcher's own API: same origin only (a page elsewhere cannot start a sandbox for a visitor). */
  function sameOrigin(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    return req.headers.origin === origin;
  }

  async function readJson(
    req: IncomingMessage,
  ): Promise<Record<string, unknown> | undefined> {
    if (!/^application\/json(?:;|$)/.test(req.headers['content-type'] ?? ''))
      return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_API_BODY) return undefined;
      chunks.push(chunk);
    }
    try {
      const value: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8') || '{}',
      );
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    addr: string,
    token: string | undefined,
    session: Session | undefined,
  ) {
    if (
      path === '/_demo/api/status' &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const { capacity, free } = sandboxes.status();
      return json(res, 200, {
        capacity,
        free,
        session: session
          ? {
              active: true,
              endsAt: new Date(sandboxes.endsAt(session)).toISOString(),
            }
          : null,
      });
    }
    if (req.method !== 'POST')
      return json(res, 405, { code: 'method-not-allowed' }, { allow: 'POST' });
    if (!sameOrigin(req))
      return json(res, 403, { code: 'cross-origin-request' });
    const wait = startRate.take(addr);
    if (wait > 0) {
      log.info('refused', { reason: 'rate-limited' });
      return json(
        res,
        429,
        { code: 'rate-limited' },
        { 'retry-after': String(wait) },
      );
    }
    if (path === '/_demo/api/challenge') return json(res, 200, pow.issue(addr));
    if (path === END_PATH) {
      // The visitor ends their own sandbox (#846): the one their cookie names, and no other. The
      // body only picks the page's language; nothing in it names a sandbox.
      const body = await readJson(req);
      if (!body) return json(res, 400, { code: 'invalid-request' });
      if (!token) return json(res, 404, { code: 'no-sandbox' });
      const ran = await sandboxes.close(token);
      const ended: Ended = ran ? 'closed' : 'expired';
      return json(
        res,
        200,
        { status: 'ended', next: endedPage(ended, body['lang']) },
        { 'set-cookie': clearCookie },
      );
    }
    if (path === '/_demo/api/start') {
      const body = await readJson(req);
      if (!body) return json(res, 400, { code: 'invalid-request' });
      // A second tab, or a second press: the sandbox the cookie names already is theirs.
      if (session) return json(res, 200, { status: 'running' });
      const lang = body['lang'];
      if (
        typeof lang !== 'string' ||
        !(SANDBOX_LANGS as readonly string[]).includes(lang)
      )
        return json(res, 400, { code: 'invalid-request' });
      const refusal = pow.redeem(body['challenge'], body['nonce'], addr);
      if (refusal) {
        log.info('refused', { reason: `pow-${refusal}` });
        return json(res, 403, { code: 'proof-of-work', reason: refusal });
      }
      const result = await sandboxes.start(addr, lang as SandboxLang);
      switch (result.kind) {
        case 'started':
          return json(
            res,
            201,
            { status: 'started' },
            { 'set-cookie': cookie(result.token) },
          );
        case 'full':
          return json(res, 503, { code: 'full' }, { 'retry-after': '120' });
        case 'one-at-a-time':
          return json(res, 429, { code: 'one-at-a-time' });
        case 'daily-limit':
          return json(res, 429, {
            code: 'daily-limit',
            retryAt: new Date(result.retryAt).toISOString(),
          });
        case 'failed':
          return json(res, 502, {
            code: 'start-failed',
            reference: result.reference,
          });
      }
    }
    return json(res, 404, { code: 'not-found' });
  }

  function asset(req: IncomingMessage, res: ServerResponse, name: string) {
    const found = assets.get(name);
    if (!found) return notFound(res);
    res.writeHead(200, {
      ...ownHeaders(),
      'content-type': found.type,
      'cache-control': 'public, max-age=3600',
      'content-length': found.body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : found.body);
  }

  function film(req: IncomingMessage, res: ServerResponse, name: string) {
    const match = FILM_FILE.exec(name);
    if (!settings.filmsDir || !match) return notFound(res);
    const file = join(settings.filmsDir, name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return notFound(res);
    }
    const headers: OutgoingHttpHeaders = {
      ...ownHeaders(),
      'content-type': FILM_TYPES[match[3] ?? ''] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
      'accept-ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
    } else {
      res.writeHead(200, { ...headers, 'content-length': size });
    }
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function notFound(res: ServerResponse) {
    json(res, 404, { code: 'not-found' });
  }

  function proxy(req: IncomingMessage, res: ServerResponse, session: Session) {
    const target = upstreamTarget(req.url, session.url);
    if (!target) return json(res, 400, { code: 'invalid-request-target' });
    const headers: IncomingHttpHeaders = {};
    const connectionNamed = new Set(
      String(req.headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim()),
    );
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name) || connectionNamed.has(name)) continue;
      if (FORWARDING.test(name)) continue;
      headers[name] = value;
    }
    const others = withoutOwnCookie(req.headers.cookie);
    if (others) headers.cookie = others;
    else delete headers.cookie;
    // No X-Forwarded-For: the sandbox never learns the visitor's address (it sees the launcher's).
    headers['x-forwarded-proto'] = settings.publicUrl.protocol.slice(0, -1);
    headers['x-forwarded-host'] = settings.publicUrl.host;

    let size = 0;
    const upstream = httpRequest(
      target,
      { method: req.method, headers, timeout: 310_000 },
      (answer) => {
        const out: OutgoingHttpHeaders = {};
        const named = new Set(
          String(answer.headers.connection ?? '')
            .toLowerCase()
            .split(',')
            .map((s) => s.trim()),
        );
        for (const [name, value] of Object.entries(answer.headers)) {
          if (HOP_BY_HOP.has(name) || named.has(name) || name === 'server')
            continue;
          if (name === 'set-cookie') {
            const kept = (
              Array.isArray(value) ? value : [String(value)]
            ).filter((line) => !ownCookieName(line));
            if (kept.length) out[name] = kept;
            continue;
          }
          out[name] = value;
        }
        // One visitor's answer is never kept for another: no shared cache may store it.
        out['cache-control'] = privateCacheControl(
          answer.headers['cache-control'],
        );
        out['vary'] = withCookieVary(answer.headers['vary']);
        if (https)
          out['strict-transport-security'] =
            'max-age=31536000; includeSubDomains';
        out['x-content-type-options'] ??= 'nosniff';
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, out);
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (
        ['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(
          error.code ?? '',
        )
      ) {
        // The sandbox is gone or ended: removed, so the next request gets the start page.
        log.error('sandbox-unreachable', {
          sandbox: session.id,
          error: error.code,
        });
        void sandboxes.drop(session, 'unreachable');
      }
      if (res.headersSent) res.destroy();
      else json(res, 502, { code: 'sandbox-unreachable' });
    });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        upstream.destroy();
        if (!res.headersSent)
          json(res, 413, { code: 'too-large' }, { connection: 'close' });
        req.destroy();
      }
    });
    req.pipe(upstream);
  }

  const server = createServer(
    { requestTimeout: 330_000, headersTimeout: 20_000 },
    (req, res) => {
      const handled = async () => {
        // The health check, from the container itself: before the peer check, and says nothing.
        if (req.url === '/_demo/healthz') {
          res.writeHead(200, {
            'content-type': 'text/plain',
            'cache-control': 'no-store',
          });
          return res.end('ok\n');
        }
        const address = clientAddress(
          req.socket.remoteAddress,
          req.headers['x-forwarded-for'],
          settings.trustProxy,
          settings.proxyAddresses,
        );
        // Not through the trusted proxy (a sandbox on the launcher's network, say): refused.
        if (!address) return json(res, 403, { code: 'untrusted-peer' });
        const addr = addressHash(addressKey(address));
        let url: URL;
        try {
          url = new URL(req.url ?? '/', origin);
        } catch {
          return json(res, 400, { code: 'invalid-request' });
        }
        const path = url.pathname;
        const token = readCookie(req.headers.cookie);
        const session = sandboxes.find(token);

        if (path.startsWith('/_demo/')) {
          const wait = pageRate.take(addr);
          if (wait > 0)
            return json(
              res,
              429,
              { code: 'rate-limited' },
              { 'retry-after': String(wait) },
            );
          if (path.startsWith('/_demo/api/'))
            return api(req, res, path, addr, token, session);
          if (req.method !== 'GET' && req.method !== 'HEAD')
            return json(res, 405, { code: 'method-not-allowed' });
          // What this demo stores: linkable from the operator's privacy policy, with or without a sandbox.
          if (path === '/_demo/data')
            return sendPage(
              req,
              res,
              pageLang(req, url),
              renderDataPage(chrome(pageLang(req, url))),
            );
          if (path.startsWith('/_demo/films/'))
            return film(req, res, path.slice('/_demo/films/'.length));
          return asset(req, res, path.slice('/_demo/'.length));
        }

        if (session) {
          // The visitor and the sandbox both: a sandbox's requests, and one address's.
          const wait = Math.max(
            sandboxRate.take(session.id),
            pageRate.take(addr),
          );
          if (wait > 0)
            return json(
              res,
              429,
              { code: 'rate-limited' },
              { 'retry-after': String(wait) },
            );
          if (!QUIET.test(path)) sandboxes.touch(session);
          return proxy(req, res, session);
        }

        const wait = pageRate.take(addr);
        if (wait > 0)
          return json(
            res,
            429,
            { code: 'rate-limited' },
            { 'retry-after': String(wait) },
          );
        const navigation =
          req.headers['sec-fetch-mode'] === 'navigate' ||
          /text\/html/.test(req.headers.accept ?? '');
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          (path === '/' || navigation)
        ) {
          // Any address of a sandbox opened without its cookie: the start page, at `/`; with a
          // cookie whose sandbox has gone, in its ended state.
          if (path !== '/') {
            const lang = url.searchParams.get('lang');
            const query = new URLSearchParams(
              token ? { ended: 'expired' } : {},
            );
            if (lang === 'de' || lang === 'en') query.set('lang', lang);
            res.writeHead(303, {
              ...ownHeaders(),
              location: query.size ? `/?${query}` : '/',
              'cache-control': 'no-store',
              ...(token ? { 'set-cookie': clearCookie } : {}),
            });
            return res.end();
          }
          return startPage(req, res, url, token !== undefined);
        }
        // The cookie stays: the editor's polls must not clear it before the visitor's next page,
        // which shows the ended state (and clears it). It names nothing any more.
        return json(res, 404, { code: 'no-sandbox' });
      };
      handled().catch((error: unknown) => {
        log.error('request-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) json(res, 500, { code: 'internal-error' });
        else res.destroy();
      });
    },
  );
  // No WebSockets: the editor uses none, and nothing else is passed on.
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

/**
 * The sandbox address a request goes to: only an origin-form target (`/path?query`), put on the
 * sandbox's own origin. An absolute-form (`http://host/…`) or scheme-relative (`//host/…`) target
 * could otherwise name another host; undefined for those, and for anything that would not stay on
 * the sandbox's origin.
 */
/** Headers that name a client's address: never passed on, whoever sent them. */
const FORWARDING =
  /^(?:x-forwarded-|forwarded$|x-real-ip$|x-client-ip$|x-cluster-client-ip$|client-ip$|true-client-ip$|cf-connecting-ip$|fastly-client-ip$)/;

/** A Set-Cookie of the launcher's own cookie (or any __Host- one), however its name is spaced or cased. */
export function ownCookieName(line: string): boolean {
  const name = line.split('=', 1)[0]?.trim().toLowerCase() ?? '';
  return name === COOKIE.toLowerCase() || name.startsWith('__host-');
}

export function upstreamTarget(
  requestTarget: string | undefined,
  sandboxUrl: string,
): URL | undefined {
  if (
    !requestTarget ||
    !requestTarget.startsWith('/') ||
    requestTarget.startsWith('//')
  )
    return undefined;
  if (/[\\\s]/.test(requestTarget)) return undefined;
  const base = new URL(sandboxUrl);
  let target: URL;
  try {
    target = new URL(base.origin + requestTarget);
  } catch {
    return undefined;
  }
  return target.origin === base.origin ? target : undefined;
}

/** A sandbox's Cache-Control made private: no `public` or `s-maxage`, `private` always. */
export function privateCacheControl(
  value: string | string[] | undefined,
): string {
  const directives = (Array.isArray(value) ? value.join(',') : (value ?? ''))
    .split(',')
    .map((d) => d.trim())
    .filter(
      (d) =>
        d && !/^(?:public|private|s-maxage\s*=.*|proxy-revalidate)$/i.test(d),
    );
  return ['private', ...directives].join(', ');
}

/** A sandbox's Vary with `Cookie` in it. */
export function withCookieVary(value: string | string[] | undefined): string {
  const fields = (Array.isArray(value) ? value.join(',') : (value ?? ''))
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.includes('*')) return '*';
  return fields.some((f) => f.toLowerCase() === 'cookie')
    ? fields.join(', ')
    : [...fields, 'Cookie'].join(', ');
}

/** The session cookie's value from a Cookie header; undefined when absent or malformed. */
export function readCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** The Cookie header without the launcher's own cookie: the sandbox never sees it. */
export function withoutOwnCookie(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}
