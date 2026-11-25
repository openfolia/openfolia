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
  now?: () => number,
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
    now,
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

  describe('the end route (#846)', () => {
    const same = {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
    };
    const end = (
      cookie: string | undefined,
      body: unknown = { lang: 'de' },
      headers: Record<string, string> = same,
    ) =>
      call(l, '/_demo/api/end', {
        method: 'POST',
        headers,
        ...(cookie ? { cookie } : {}),
        body: JSON.stringify(body),
      });

    it("ends the visitor's own sandbox, through the runtime, clears the cookie and says where to go", async () => {
      l = await launcher();
      const a = await startSandbox(l);
      const id = l.runtime.started[0]!.id;
      const res = await end(a.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ended',
        next: '/?ended=closed&lang=de',
      });
      expect(res.headers.get('set-cookie')).toMatch(
        /^__Host-openfolia-demo=; .*Max-Age=0$/,
      );
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(l.runtime.removed).toEqual([id]);
      expect(l.sandboxes.status().free).toBe(2);
      // The same cookie reaches nothing any more: the start page, in its ended state.
      const page = await call(l, '/?ended=closed', { cookie: a.cookie });
      const html = await page.text();
      expect(html).toContain('data-ended="closed"');
      expect(html).toContain('Thanks for trying OpenFolia.');
    });

    it('refuses a request from another site, or without the fetch metadata of this one', async () => {
      l = await launcher();
      const a = await startSandbox(l);
      for (const headers of [
        {
          ...same,
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
        { ...same, 'sec-fetch-site': 'same-site' },
        { 'content-type': 'application/json' },
      ]) {
        const res = await end(a.cookie, {}, headers);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ code: 'cross-origin-request' });
        expect(res.headers.get('set-cookie')).toBeNull();
      }
      expect(l.runtime.removed).toEqual([]);
      const get = await call(l, '/_demo/api/end', { cookie: a.cookie });
      expect(get.status).toBe(405);
      expect(l.runtime.removed).toEqual([]);
    });

    it('refuses a request without the cookie, or without a JSON body, and ends nothing', async () => {
      l = await launcher();
      const a = await startSandbox(l);
      const none = await end(undefined);
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ code: 'no-sandbox' });
      const forged = await end(`${COOKIE}=short`);
      expect(forged.status).toBe(404);
      const form = await call(l, '/_demo/api/end', {
        method: 'POST',
        headers: { ...same, 'content-type': 'text/plain' },
        cookie: a.cookie,
        body: 'x',
      });
      expect(form.status).toBe(400);
      expect(l.runtime.removed).toEqual([]);
    });

    it("never ends another visitor's sandbox, whatever the body names", async () => {
      l = await launcher();
      const a = await startSandbox(l, '203.0.113.1');
      const b = await startSandbox(l, '198.51.100.2');
      const [idA, idB] = l.runtime.started.map((s) => s.id);
      // A cookie of a sandbox that is no one's: nothing is removed.
      const stranger = await end(`${COOKIE}=${'B'.repeat(43)}`, {
        lang: 'de',
        id: idB,
        sandbox: idB,
      });
      expect(stranger.status).toBe(200);
      expect(await stranger.json()).toMatchObject({
        next: '/?ended=expired&lang=de',
      });
      expect(l.runtime.removed).toEqual([]);
      // A's cookie with B's ID in the body: A's ends, B's runs on.
      const res = await end(a.cookie, { id: idB, sandbox: idB });
      expect(res.status).toBe(200);
      expect(l.runtime.removed).toEqual([idA]);
      expect(await (await call(l, '/', { cookie: b.cookie })).text()).toContain(
        `sandbox ${idB}`,
      );
    });

    it('ends a sandbox only once, whatever the body says: a second call says it has expired', async () => {
      l = await launcher();
      const a = await startSandbox(l);
      const first = await end(a.cookie, { lang: 'de', reason: 'expired' });
      // The body names no outcome: a running sandbox ends as ended.
      expect(await first.json()).toMatchObject({
        next: '/?ended=closed&lang=de',
      });
      const again = await end(a.cookie, { lang: 'xx' });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        status: 'ended',
        next: '/?ended=expired',
      });
      expect(l.runtime.removed).toHaveLength(1);
    });
  });

  it('counts what a person does as activity, and not what an open tab asks on its own', async () => {
    l = await launcher();
    const a = await startSandbox(l);
    const touch = vi.spyOn(l.sandboxes, 'touch');
    for (const path of [
      '/api/sandbox',
      '/api/health',
      '/api/me/notifications/unread-count',
    ])
      await call(l, path, { cookie: a.cookie });
    expect(touch).not.toHaveBeenCalled();
    await call(l, '/api/modules', { cookie: a.cookie });
    expect(touch).toHaveBeenCalledOnce();
  });

  describe('the rate limits (#870)', () => {
    // One cold load of the built editor, as measured through the launcher: 76 files (its code in
    // chunks, styles, fonts, translations) and 8 API requests.
    const FILES = 76;
    const API = 8;
    /** Statuses of `paths`, sent 100 at a time, all at one instant (the clock stands still). */
    async function statuses(paths: string[], cookie: string) {
      const seen: number[] = [];
      for (let i = 0; i < paths.length; i += 100)
        seen.push(
          ...(await Promise.all(
            paths.slice(i, i + 100).map((path) =>
              call(l, path, { cookie }).then(async (res) => {
                await res.arrayBuffer();
                return res.status;
              }),
            ),
          )),
        );
      return seen;
    }
    const load = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        i % 2 ? '/' : `/manuals/m${i}`,
        ...Array.from({ length: FILES - 1 }, (_, f) => `/chunk-${f}.js`),
        ...Array.from({ length: API }, (_, a) => `/api/r${a}?page[number]=1`),
      ]).flat();

    it('lets 20 editor loads at once through at the default rate', async () => {
      l = await launcher({ CCMS_LAUNCHER_RATE: '20' }, silentLogger, () => 0);
      const a = await startSandbox(l);
      const answered = await statuses(load(20), a.cookie);
      expect(answered.filter((s) => s !== 200)).toEqual([]);
    });

    it('still limits a flood of files, and the API on its own', async () => {
      l = await launcher({ CCMS_LAUNCHER_RATE: '2' }, silentLogger, () => 0);
      const a = await startSandbox(l);
      // The API: ten seconds' worth (20) in a burst, less the two the start took from the
      // address's; the files do not use it up.
      const api = Array.from({ length: 18 }, (_, i) => `/api/r${i}`);
      expect(await statuses(api, a.cookie)).toEqual(api.map(() => 200));
      expect(await statuses(['/api/one-more'], a.cookie)).toEqual([429]);
      // The files: a hundred seconds' worth (200) in a burst, then refused too.
      const files = Array.from({ length: 200 }, (_, i) => `/chunk-${i}.js`);
      expect(await statuses(files, a.cookie)).toEqual(files.map(() => 200));
      expect(await statuses(['/chunk-x.js'], a.cookie)).toEqual([429]);
    });

    it('caps a sandbox’s requests in flight, and frees the room as they end (#876)', async () => {
      l = await launcher({ CCMS_LAUNCHER_MAX_IN_FLIGHT: '3' });
      const a = await startSandbox(l);
      const b = await startSandbox(l, '203.0.113.2');
      let release!: () => void;
      l.runtime.hold = new Promise<void>((r) => (release = r));
      const held = [0, 1, 2].map((i) =>
        call(l, `/hold-${i}.js`, { cookie: a.cookie }),
      );
      // Wait until all three reached the sandbox.
      const reached = () =>
        [...l.runtime.seen.values()]
          .flat()
          .filter((s) => s.url.startsWith('/hold')).length;
      while (reached() < 3) await new Promise((r) => setTimeout(r, 5));
      const over = await call(l, '/chunk.js', { cookie: a.cookie });
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBe('1');
      // Another sandbox is not held back.
      expect((await call(l, '/chunk.js', { cookie: b.cookie })).status).toBe(
        200,
      );
      release();
      for (const res of await Promise.all(held)) {
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      expect((await call(l, '/chunk.js', { cookie: a.cookie })).status).toBe(
        200,
      );
    });

    it('closes the sandbox’s socket when the visitor gives up (#876)', async () => {
      l = await launcher({ CCMS_LAUNCHER_MAX_IN_FLIGHT: '1' });
      const a = await startSandbox(l);
      l.runtime.hold = new Promise<void>(() => undefined);
      const abort = new AbortController();
      const pending = call(l, '/hold-x.js', {
        cookie: a.cookie,
        signal: abort.signal,
      }).catch(() => undefined);
      while (![...l.runtime.seen.values()].flat().length)
        await new Promise((r) => setTimeout(r, 5));
      abort.abort();
      await pending;
      for (let i = 0; i < 200 && !l.runtime.dropped.length; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(l.runtime.dropped).toEqual(['/hold-x.js']);
      l.runtime.hold = undefined;
      expect((await call(l, '/chunk.js', { cookie: a.cookie })).status).toBe(
        200,
      );
    });

    it('counts a write, an encoded path and the API’s other doors as API requests', async () => {
      l = await launcher({ CCMS_LAUNCHER_RATE: '2' }, silentLogger, () => 0);
      const a = await startSandbox(l);
      // These use up the API's burst (18, as above), whatever their spelling.
      const api = [
        ...Array.from({ length: 8 }, (_, i) => `/api/r${i}`),
        '/api',
        '/api/x',
        '/d/manual',
        '/mcp',
        '/%61pi/x',
        '/x/..%2Fapi/y',
        '/API%2Fx',
        '/.%2e/api/x',
        '/api/../api/x',
        '/a%20b',
      ];
      expect(await statuses(api, a.cookie)).toEqual(api.map(() => 200));
      expect(await statuses(['/api/one-more'], a.cookie)).toEqual([429]);
      const post = await call(l, '/chunk-a.js', {
        method: 'POST',
        cookie: a.cookie,
      });
      expect(post.status).toBe(429);
      // A file still goes through: its own bucket.
      expect(await statuses(['/chunk-a.js'], a.cookie)).toEqual([200]);
    });
  });

  it('keeps a gone sandbox’s cookie on the editor’s polls, so the next page shows the ended dialog', async () => {
    l = await launcher();
    const a = await startSandbox(l);
    await l.sandboxes.drop(
      l.sandboxes.find(/=(.+)$/.exec(a.cookie)![1])!,
      'test',
    );
    const poll = await call(l, '/api/sandbox', { cookie: a.cookie });
    expect(poll.status).toBe(404);
    expect(poll.headers.get('set-cookie')).toBeNull();
    const deep = await call(l, '/modules/en/x?lang=de', {
      cookie: a.cookie,
      headers: { accept: 'text/html' },
    });
    expect(deep.status).toBe(303);
    expect(deep.headers.get('location')).toBe('/?ended=expired&lang=de');
    expect(deep.headers.get('set-cookie')).toContain('Max-Age=0');
    const page = await call(l, '/', { cookie: a.cookie });
    expect(await page.text()).toContain('data-ended="expired"');
  });

  it('opens the ended dialog only when asked, with "Book a demo" only when it is set', async () => {
    l = await launcher();
    const plain = await (await call(l, '/')).text();
    expect(plain).not.toContain('<dialog');
    const ended = await (await call(l, '/?ended=closed')).text();
    expect(ended).toContain('data-ended="closed"');
    expect(ended).not.toContain('Book a demo');
    expect(ended).not.toContain('See the published manuals');
    expect(ended).toContain('You can start a new sandbox at any time.');
    expect(await (await call(l, '/?ended=<x>')).text()).not.toContain(
      '<dialog',
    );
    l.server.close();
    l.server.closeAllConnections();
    l = await launcher({
      CCMS_LAUNCHER_BOOKING_URL: 'https://www.example.org/#demo',
      CCMS_LAUNCHER_PORTAL_URL: 'https://manuals.example.org/',
    });
    const de = await (await call(l, '/?ended=expired&lang=de')).text();
    expect(de).toContain(
      '<a class="btn" href="https://www.example.org/#demo" data-ended-book>',
    );
    expect(de).toContain('Demo buchen');
    expect(de).toContain('nach 30 Minuten ohne Aktivität');
    expect(de).toContain('href="https://manuals.example.org/"');
    // Nothing of the booking page is loaded here: the policy still allows this origin only.
    const res = await call(l, '/?ended=closed');
    expect(res.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(await res.text()).not.toMatch(/<(iframe|script[^>]+example\.org)/);
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
