// The launcher over HTTP, on fake sandboxes (tests/fakes.ts): starting, the cookie binding, the
// routing, the refusals and the headers.
import type { Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { loadAssets } from '../src/assets.js';
import { jsonLogger, type Logger, silentLogger } from '../src/log.js';
import { solve } from '../src/pow.js';
import { Sandboxes } from '../src/sandboxes.js';
import {
  COOKIE,
  createLauncherServer,
  ownCookieName,
  privateCacheControl,
  readCookie,
  upstreamTarget,
  withCookieVary,
  withoutOwnCookie,
} from '../src/server.js';
import { launcherSettings } from '../src/settings.js';
import { FakeRuntime } from './fakes.js';

const ORIGIN = 'http://localhost:4000';

async function launcher(
  env: Record<string, string> = {},
  log: Logger = silentLogger,
) {
  const settings = launcherSettings({
    CCMS_LAUNCHER_PUBLIC_URL: `${ORIGIN}/`,
    CCMS_LAUNCHER_AGENT_URL: 'http://agent:8081',
    CCMS_LAUNCHER_AGENT_TOKEN: 'a'.repeat(64),
    CCMS_LAUNCHER_POW_BITS: '4',
    CCMS_LAUNCHER_MAX_SANDBOXES: '2',
    CCMS_LAUNCHER_PER_ADDRESS: '5',
    CCMS_LAUNCHER_PER_ADDRESS_DAILY: '10',
    CCMS_LAUNCHER_RATE: '1000',
    CCMS_LAUNCHER_TRUST_PROXY: '1',
    CCMS_LAUNCHER_PROXY_ADDRESSES: '127.0.0.1',
    ...env,
  });
  const runtime = new FakeRuntime();
  const sandboxes = new Sandboxes(runtime, settings, log);
  const server: Server = createLauncherServer({
    settings,
    sandboxes,
    assets: loadAssets(),
    log,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, runtime, sandboxes, base };
}

type Launcher = Awaited<ReturnType<typeof launcher>>;

/** A request as a browser at `ip` sends it (the launcher sits behind one proxy here). */
function call(
  l: Launcher,
  path: string,
  init: RequestInit & { ip?: string; cookie?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', init.ip ?? '203.0.113.1');
  if (init.cookie) headers.set('cookie', init.cookie);
  return fetch(`${l.base}${path}`, { ...init, headers, redirect: 'manual' });
}

/** The whole start: a challenge, its work, the start; the cookie the launcher set. */
async function startSandbox(l: Launcher, ip = '203.0.113.1', lang = 'en') {
  const json = {
    'content-type': 'application/json',
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
  };
  const challenge = await call(l, '/_demo/api/challenge', {
    method: 'POST',
    headers: json,
    body: '{}',
    ip,
  });
  expect(challenge.status).toBe(200);
  const { challenge: c, bits } = (await challenge.json()) as {
    challenge: string;
    bits: number;
  };
  const started = await call(l, '/_demo/api/start', {
    method: 'POST',
    headers: json,
    ip,
    body: JSON.stringify({ challenge: c, nonce: solve(c, bits), lang }),
  });
  const setCookie = started.headers.get('set-cookie') ?? '';
  const value = /__Host-openfolia-demo=([^;]+)/.exec(setCookie)?.[1];
  return {
    status: started.status,
    body: (await started.json()) as Record<string, unknown>,
    setCookie,
    cookie: value ? `${COOKIE}=${value}` : '',
  };
}

describe('the launcher', () => {
  let l: Launcher;
  afterEach(async () => {
    l.server.close();
    l.server.closeAllConnections();
    await l.runtime.stopAll();
  });

  it('shows the start page without a sandbox, with its policy', async () => {
    l = await launcher();
    const page = await call(l, '/?lang=de');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('<html lang="de"');
    expect(html).toContain('Demo starten');
    expect(html).not.toContain('Missbrauch melden');
    for (const asset of [
      'theme.css',
      'page.css',
      'page.js',
      'pow-worker.js',
      'fonts/Geist-Variable.woff2',
    ]) {
      const res = await call(l, `/_demo/${asset}`);
      expect(res.status, asset).toBe(200);
    }
    expect((await call(l, '/_demo/../package.json')).status).toBe(404);
    expect((await call(l, '/_demo/films/hero-en.mp4')).status).toBe(404);
  });

  it('shows the abuse contact only when it is set', async () => {
    l = await launcher({ CCMS_LAUNCHER_ABUSE_CONTACT: 'abuse@example.org' });
    expect(await (await call(l, '/')).text()).toContain(
      'href="mailto:abuse@example.org"',
    );
  });

  it('starts a sandbox, binds it to a cookie, and routes only that cookie to it', async () => {
    l = await launcher();
    const a = await startSandbox(l, '203.0.113.1', 'de');
    expect(a.status).toBe(201);
    expect(a.setCookie).toMatch(
      /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=5400$/,
    );
    const b = await startSandbox(l, '198.51.100.2');
    expect(b.status).toBe(201);
    const [idA, idB] = l.runtime.started.map((s) => s.id);
    expect(l.runtime.started.map((s) => s.lang)).toEqual(['de', 'en']);

    const fromA = await call(l, '/modules/en/x?y=1', { cookie: a.cookie });
    expect(await fromA.text()).toBe(
      `sandbox ${idA} (de) GET /modules/en/x?y=1`,
    );
    expect(fromA.headers.get('server')).toBeNull();
    expect(await (await call(l, '/', { cookie: b.cookie })).text()).toContain(
      `sandbox ${idB}`,
    );

    // The same address without the cookie, another browser: the start page, never a sandbox.
    const other = await call(l, '/modules/en/x', {
      headers: { accept: 'text/html' },
    });
    expect(other.status).toBe(303);
    expect(other.headers.get('location')).toBe('/');
    expect(await (await call(l, '/')).text()).toContain('Start the demo');
    const api = await call(l, '/api/modules', {
      headers: { accept: 'application/vnd.api+json' },
    });
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ code: 'no-sandbox' });
    const made = await call(l, '/api/change-sets', {
      method: 'POST',
      body: '{}',
    });
    expect(made.status).toBe(404);
    // Neither sandbox saw any of it, nor the launcher's cookie.
    const seen = [
      ...(l.runtime.seen.get(idA ?? '') ?? []),
      ...(l.runtime.seen.get(idB ?? '') ?? []),
    ];
    expect(seen.map((s) => s.url)).toEqual(['/modules/en/x?y=1', '/']);
    for (const s of seen)
      expect(String(s.headers.cookie ?? '')).not.toContain(COOKIE);
  });

  it('passes no visitor address on, and keeps the host', async () => {
    l = await launcher();
    const a = await startSandbox(l);
    await call(l, '/x', {
      cookie: `${a.cookie}; editor=1`,
      headers: {
        'x-real-ip': '1.1.1.1',
        forwarded: 'for=1.1.1.1',
        'cf-connecting-ip': '1.1.1.1',
        'true-client-ip': '1.1.1.1',
      },
    });
    const [seen] = l.runtime.seen.get(l.runtime.started[0]!.id)!;
    expect(seen!.headers['x-forwarded-for']).toBeUndefined();
    expect(seen!.headers['x-real-ip']).toBeUndefined();
    expect(seen!.headers['forwarded']).toBeUndefined();
    expect(seen!.headers['cf-connecting-ip']).toBeUndefined();
    expect(seen!.headers['true-client-ip']).toBeUndefined();
    expect(seen!.headers.cookie).toBe('editor=1');
    expect(seen!.headers['x-forwarded-host']).toBe('localhost:4000');
  });

  it("never lets a sandbox set the launcher's cookie", async () => {
    l = await launcher();
    const a = await startSandbox(l);
    const res = await call(l, '/set-cookie', { cookie: a.cookie });
    expect(res.headers.getSetCookie()).toEqual(['editor=1; Path=/']);
  });

  it('reuses the sandbox of a second tab', async () => {
    l = await launcher();
    const a = await startSandbox(l);
    const status = await call(l, '/_demo/api/status', { cookie: a.cookie });
    expect(await status.json()).toMatchObject({
      capacity: 2,
      free: 1,
      session: { active: true },
    });
    const json = { 'content-type': 'application/json', origin: ORIGIN };
    const again = await call(l, '/_demo/api/start', {
      method: 'POST',
      headers: json,
      cookie: a.cookie,
      body: '{"lang":"en"}',
    });
    expect(again.status).toBe(200);
    expect(l.runtime.started).toHaveLength(1);
  });

  it('refuses a start from another site, without the work, or past the cap', async () => {
    l = await launcher();
    const foreign = await call(l, '/_demo/api/challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(foreign.status).toBe(403);
    const json = { 'content-type': 'application/json', origin: ORIGIN };
    const lazy = await call(l, '/_demo/api/start', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        challenge: 'v1.1.4.x.y.z',
        nonce: '1',
        lang: 'en',
      }),
    });
    expect(lazy.status).toBe(403);
    expect(await lazy.json()).toMatchObject({ code: 'proof-of-work' });
    await startSandbox(l, '203.0.113.1');
    await startSandbox(l, '203.0.113.2');
    const full = await startSandbox(l, '203.0.113.3');
    expect(full.status).toBe(503);
    expect(full.body).toEqual({ code: 'full' });
    expect(await (await call(l, '/')).text()).toContain('data-state="full"');
  });

  it('answers the start page, and clears the cookie, once the sandbox has gone', async () => {
    l = await launcher();
    const a = await startSandbox(l);
    const [session] = [l.sandboxes.find(/=(.+)$/.exec(a.cookie)![1])!];
    await l.sandboxes.drop(session, 'test');
    const page = await call(l, '/', { cookie: a.cookie });
    expect(page.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await page.text()).toContain('has ended');
  });

  it('reads only its own cookie, of the right shape, and passes the others on', () => {
    const token = 'A'.repeat(43);
    expect(readCookie(`a=1; ${COOKIE}=${token}; b=2`)).toBe(token);
    expect(readCookie(`${COOKIE}=short`)).toBeUndefined();
    expect(withoutOwnCookie(`a=1; ${COOKIE}=${token}; b=2`)).toBe('a=1; b=2');
    expect(withoutOwnCookie(`${COOKIE}=${token}`)).toBeUndefined();
  });

  it('sends a request only to the sandbox’s own origin, whatever its target says', async () => {
    const sandbox = 'http://openfolia-sandbox-demo-0123456789abcdef:8080';
    expect(upstreamTarget('/api/x?y=1', sandbox)?.href).toBe(
      `${sandbox}/api/x?y=1`,
    );
    for (const target of [
      'http://169.254.169.254/latest',
      '//evil.example/x',
      'evil.example/x',
      '',
      '/\\evil',
      '/a b',
      undefined,
    ])
      expect(upstreamTarget(target, sandbox), String(target)).toBeUndefined();
    expect(upstreamTarget('/@evil.example', sandbox)?.origin).toBe(sandbox);

    l = await launcher();
    const a = await startSandbox(l);
    const other = l.runtime.servers
      .get(l.runtime.started[0]!.id)!
      .address() as AddressInfo;
    const port = Number(new URL(l.base).port);
    // An absolute-form target, as a client may send it to a proxy: refused, never fetched.
    const answer = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          `GET http://127.0.0.1:${other.port}/elsewhere HTTP/1.1\r\nHost: localhost:4000\r\nX-Forwarded-For: 203.0.113.1\r\nCookie: ${a.cookie}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    expect(answer).toContain('invalid-request-target');
    expect(l.runtime.seen.get(l.runtime.started[0]!.id)).toEqual([]);
  });

  it('keeps every sandbox answer out of shared caches', async () => {
    expect(privateCacheControl('public, max-age=31536000, immutable')).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(privateCacheControl('s-maxage=60, no-cache')).toBe(
      'private, no-cache',
    );
    expect(privateCacheControl(undefined)).toBe('private');
    expect(withCookieVary('Accept-Encoding')).toBe('Accept-Encoding, Cookie');
    expect(withCookieVary('cookie')).toBe('cookie');
    expect(withCookieVary(undefined)).toBe('Cookie');
    l = await launcher();
    const a = await startSandbox(l);
    const res = await call(l, '/', { cookie: a.cookie });
    expect(res.headers.get('cache-control')).toBe('private');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('refuses a peer that is not the trusted proxy, whatever it forwards', async () => {
    l = await launcher({ CCMS_LAUNCHER_PROXY_ADDRESSES: '10.9.9.0/24' });
    const res = await call(l, '/', { ip: '203.0.113.9' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'untrusted-peer' });
    // The container's own health check is not from the proxy, and is answered.
    expect((await call(l, '/_demo/healthz')).status).toBe(200);
  });

  it('says what it stores, in both languages, with or without a sandbox', async () => {
    l = await launcher();
    for (const [lang, title] of [
      ['en', 'What this demo stores'],
      ['de', 'Was diese Demo speichert'],
    ] as const) {
      const res = await call(l, `/_demo/data?lang=${lang}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<h1 id="data-title">${title}</h1>`);
      expect(html).toContain('HMAC-SHA-256');
      expect(html).toContain(lang === 'en' ? '24 hours' : '24 Stunden');
      expect(html).toContain(
        lang === 'en'
          ? '90 minutes at the latest'
          : 'spätestens nach 90 Minuten',
      );
    }
    const a = await startSandbox(l);
    const res = await call(l, '/_demo/data', { cookie: a.cookie });
    expect(await res.text()).toContain('What this demo stores');
  });

  it('links the operator’s pages only when they are set', async () => {
    l = await launcher();
    let html = await (
      await call(l, '/', { headers: { accept: 'text/html' } })
    ).text();
    expect(html).toContain('<a class="home" href="/?lang=en"');
    expect(html).not.toMatch(
      />(Documentation|Homepage|Imprint|Privacy|Published manuals)</,
    );
    expect(html).not.toContain('Report abuse');
    expect(html).toContain('href="/_demo/data?lang=en"');
    l.server.close();
    l.server.closeAllConnections();
    l = await launcher({
      CCMS_LAUNCHER_HOMEPAGE_URL: 'https://www.example.org/',
      CCMS_LAUNCHER_DOCS_URL: 'https://docs.example.org/',
      CCMS_LAUNCHER_IMPRINT_URL: 'https://www.example.org/imprint',
      CCMS_LAUNCHER_PRIVACY_URL: 'https://www.example.org/privacy',
    });
    html = await (
      await call(l, '/?lang=de', { headers: { accept: 'text/html' } })
    ).text();
    expect(html).toContain('<a class="home" href="https://www.example.org/"');
    expect(html).toContain(
      '<a class="docs" href="https://docs.example.org/de/">Dokumentation</a>',
    );
    expect(html).toContain(
      '<a href="https://www.example.org/imprint">Impressum</a>',
    );
    expect(html).toContain(
      '<a href="https://www.example.org/privacy">Datenschutz</a>',
    );
    expect(html).toContain('<a href="https://www.example.org/">Startseite</a>');
  });

  it('keeps no address: counts it by a keyed hash, logs none, passes none on', async () => {
    const lines: string[] = [];
    const secret = 's'.repeat(40);
    l = await launcher(
      { CCMS_LAUNCHER_ADDRESS_SECRET: secret, CCMS_LAUNCHER_PER_ADDRESS: '1' },
      jsonLogger('test', (line) => lines.push(line)),
    );
    await startSandbox(l, '203.0.113.77');
    // The second start from the same address is refused: the limit knows it, by its hash.
    const again = await call(l, '/_demo/api/challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
      ip: '203.0.113.77',
    });
    const { challenge, bits } = (await again.json()) as {
      challenge: string;
      bits: number;
    };
    const refused = await call(l, '/_demo/api/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        challenge,
        nonce: solve(challenge, bits),
        lang: 'en',
      }),
      ip: '203.0.113.77',
    });
    expect(((await refused.json()) as { code: string }).code).toBe(
      'one-at-a-time',
    );
    const inside = l.sandboxes as unknown as { daily: Map<string, number[]> };
    const [key] = [...inside.daily.keys()];
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain('203.0.113');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('203.0.113');
      expect(JSON.parse(line)).not.toHaveProperty('ip');
    }
    expect(() =>
      launcherSettings({
        CCMS_LAUNCHER_PUBLIC_URL: `${ORIGIN}/`,
        CCMS_LAUNCHER_AGENT_URL: 'http://agent:8081',
        CCMS_LAUNCHER_AGENT_TOKEN: 'a'.repeat(64),
        CCMS_LAUNCHER_ADDRESS_SECRET: 'short',
      }),
    ).toThrow(/ADDRESS_SECRET/);
  });

  it('lets no sandbox set the launcher’s cookie, however it spells it', () => {
    for (const line of [
      `${COOKIE}=x; Path=/`,
      `${COOKIE} =x`,
      ` __HOST-openfolia-demo=x`,
      '__Host-other=x',
    ])
      expect(ownCookieName(line), line).toBe(true);
    expect(ownCookieName('editor=1; Path=/')).toBe(false);
  });
});
