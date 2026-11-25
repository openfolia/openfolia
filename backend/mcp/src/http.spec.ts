import type { AddressInfo } from 'node:net';
import {
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { paged, StubApi, stubContext } from '../tests/stub-api.js';
import { ToolError } from './api-client.js';
import { ProxyAddresses } from './proxies.js';
import { LOOKUP_TTL_MS } from './released.js';
import {
  MAX_BODY_BYTES,
  MAX_CHECKS_AT_ONCE,
  MAX_CHECKS_PER_ADDRESS,
  MAX_FAILURES_PER_WINDOW,
  MAX_FAILURES_PER_WINDOW_ALL,
  MAX_REQUESTS_PER_WINDOW,
  clientAddress,
  createHttpHandler,
  startHttpServer,
} from './http.js';

/** A caller's own service account token (#861), which the stub API takes. */
const TOKEN = `ccms_sat_0123456789abcdef_${'6c1e9a40d7f25b83'.repeat(4)}`;
/** The deprecated shared token (`CCMS_MCP_HTTP_TOKEN`). */
const SHARED = '9d41f0c7a2e85b36d0c4f17e2a9b58c3';

/**
 * Callers' contexts over stub APIs, one per token: `TOKEN` and those in
 * `valid` read as `content.read` alone; any other the API refuses
 * (`invalid-token`, 401), as it does a token it does not know.
 */
function callers(valid: Record<string, StubApi> = {}) {
  const apis = new Map<string, StubApi>();
  const callerContext = (token: string) => {
    const api =
      valid[token] ??
      (token === TOKEN
        ? new StubApi().set('/variants', paged([]))
        : new StubApi().set(
            '/me',
            new ToolError('unauthorized', 'Unauthorized', undefined, 401),
          ));
    apis.set(token, api);
    return stubContext(api);
  };
  return { callerContext, apis };
}

let server: Server;
let url: string;
beforeAll(async () => {
  server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    ...callers(),
    allowedOrigins: ['https://allowed.example'],
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function client(token: string | undefined) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      token === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name: 'test', version: '1.0.0' }), transport };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'x', version: '1' },
  },
};

function post(headers: Record<string, string>, body: unknown = INIT) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('the Streamable HTTP transport', () => {
  it('answers a client with its token: a tool call over HTTP', async () => {
    const { client: c, transport } = client(TOKEN);
    await c.connect(transport);
    const result = await c.callTool({ name: 'list_variants', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ref: 'main',
      attributes: [],
    });
    await c.close();
  });

  it('refuses calls without a token, or with one that is no service account’s or the API refuses', async () => {
    const { client: c, transport } = client(undefined);
    await expect(c.connect(transport)).rejects.toThrow();
    const wrong = await post({ Authorization: `Bearer ${'x'.repeat(40)}` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer');
    expect(await wrong.text()).not.toContain('x'.repeat(40));
    expect((await post({ Authorization: TOKEN })).status).toBe(401);
    const unknown = TOKEN.replace(/.{8}$/, '00000000');
    const refused = await post({ Authorization: `Bearer ${unknown}` });
    expect(refused.status).toBe(401);
    const text = await refused.text();
    expect(text).toContain('unauthorized');
    expect(text).not.toContain(unknown);
  });

  it('refuses an Origin it does not allow (DNS rebinding) and a Host that is not loopback', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect(
      (await post({ ...auth, Origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await post({ ...auth, Origin: 'https://allowed.example' })).status,
    ).toBe(200);
    // fetch does not let a caller set Host: a raw request does, as a rebound browser's would.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            ...auth,
            Host: 'evil.example',
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(INIT));
    });
    expect(status).toBe(403);
  });

  it('takes POST only, on /mcp only, and bodies up to its limit', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(url, { method: 'DELETE', headers: auth })).status).toBe(
      405,
    );
    expect(
      (
        await fetch(url.replace('/mcp', '/other'), {
          method: 'POST',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect((await post(auth, 'x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post(auth, '{not json')).status).toBe(400);
    // A body over the limit announced up front is refused before it is read.
    const big = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            ...auth,
            'Content-Type': 'application/json',
            'Content-Length': String(MAX_BODY_BYTES + 1),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(big).toBe(413);
  });

  it('refuses a JSON-RPC batch: one message per request, so the rate counts calls', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const batch = await post(auth, [INIT, { ...INIT, id: 2 }]);
    expect(batch.status).toBe(400);
    expect(await batch.text()).toContain('Batches are not accepted');
  });
});

describe('failed authentications', () => {
  async function server(now: () => number) {
    const s = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      ...callers(),
      allowedOrigins: [],
      now,
    });
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
    const send = (token: string, from?: string) =>
      new Promise<{
        status: number | undefined;
        retryAfter: string | undefined;
        authenticate: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = request(
          at,
          {
            method: 'POST',
            // A different local address for each client, where asked: 127.0.0.0/8 is all loopback.
            ...(from && { localAddress: from }),
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                retryAfter: res.headers['retry-after'] as string | undefined,
                authenticate: res.headers['www-authenticate'],
                body,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(INIT));
      });
    return {
      send,
      close: () => new Promise<void>((resolve) => s.close(() => resolve())),
    };
  }

  it('lock out wrong tokens from an address for the window, the same for every wrong one, and still serve an admitted caller', async () => {
    let now = 0;
    const { send, close } = await server(() => now);
    expect((await send(TOKEN)).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect((await send(`wrong-${i}`)).status).toBe(401);
    }
    const a = await send('wrong-a');
    const b = await send('another-wrong-token-entirely');
    expect(a.status).toBe(429);
    expect(Number(a.retryAfter)).toBeGreaterThan(0);
    expect(a.authenticate).toBe('Bearer');
    expect([b.status, b.retryAfter, b.authenticate, b.body]).toEqual([
      a.status,
      a.retryAfter,
      a.authenticate,
      a.body,
    ]);
    // A caller already admitted is served, even from the locked address (a NAT, a proxy).
    expect((await send(TOKEN)).status).toBe(200);
    now = 60_000;
    expect((await send('wrong')).status).toBe(401);
    await close();
  });

  it('bound the failures of all addresses together', async () => {
    // The handler on its own, so each request can come from its own address.
    const handle = createHttpHandler({
      ...callers(),
      allowedOrigins: [],
      loopbackOnly: false,
      now: () => 0,
    });
    const send = async (token: string, address: string) => {
      const req = {
        url: '/mcp',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, host: 'mcp.example' },
        socket: { remoteAddress: address },
      } as unknown as IncomingMessage;
      let status: number | undefined;
      const res = {
        headersSent: false,
        writeHead: (code: number) => (status = code),
        end: () => undefined,
      } as unknown as ServerResponse;
      await handle(req, res);
      return status;
    };
    expect(await send(TOKEN, '10.9.9.8')).not.toBe(429);
    // From many addresses, none over its own limit: the global budget trips.
    for (let n = 0; n < MAX_FAILURES_PER_WINDOW_ALL; n++) {
      expect(await send('wrong', `10.0.${Math.floor(n / 5)}.${n % 5}`)).toBe(
        401,
      );
    }
    expect(await send('wrong', '10.9.9.9')).toBe(429);
    // An admitted caller is still served; requests stop there, before any MCP work.
    expect(await send(TOKEN, '10.9.9.9')).not.toBe(429);
  });
});

describe('behind a proxy (CCMS_MCP_HTTP_TRUST_PROXY, CCMS_MCP_HTTP_PROXY_ADDRESSES)', () => {
  const PROXY = '172.18.0.4';
  const proxies = new ProxyAddresses([PROXY]);
  const trust = (hops: number) => ({ hops, proxies });
  const req = (socket: string, forwarded?: string) =>
    ({
      socket: { remoteAddress: socket },
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    }) as unknown as IncomingMessage;

  it('takes the address the trusted hops saw, never what a client wrote further left', () => {
    // Without trust, the connection's address, whatever the header says.
    expect(clientAddress(req(PROXY, '203.0.113.7'))).toBe(PROXY);
    // One hop (the editor's nginx): the address it appended, the rightmost.
    expect(clientAddress(req(PROXY, '203.0.113.7'), trust(1))).toBe(
      '203.0.113.7',
    );
    expect(clientAddress(req(PROXY, '1.1.1.1, 203.0.113.7'), trust(1))).toBe(
      '203.0.113.7',
    );
    // Two hops (a reverse proxy in front of the editor).
    expect(
      clientAddress(req(PROXY, '1.1.1.1, 198.51.100.2, 10.0.0.9'), trust(2)),
    ).toBe('198.51.100.2');
    // A shorter chain gives its leftmost; no header, the connection.
    expect(clientAddress(req(PROXY, '198.51.100.2'), trust(3))).toBe(
      '198.51.100.2',
    );
    expect(clientAddress(req(PROXY), trust(1))).toBe(PROXY);
    // An entry that is no address counts as the connection.
    expect(clientAddress(req(PROXY, 'not-an-ip'), trust(1))).toBe(PROXY);
    expect(clientAddress(req(PROXY, '2001:db8::1'), trust(1))).toBe(
      '2001:db8::1',
    );
    // A dual-stack socket's form of the proxy's address is the proxy too.
    expect(clientAddress(req(`::ffff:${PROXY}`, '203.0.113.7'), trust(1))).toBe(
      '203.0.113.7',
    );
  });

  it('never believes a peer that is not one of the proxies (the published port)', () => {
    expect(clientAddress(req('172.18.0.1', '203.0.113.7'), trust(1))).toBe(
      '172.18.0.1',
    );
    expect(clientAddress(req('127.0.0.1', '203.0.113.7'), trust(2))).toBe(
      '127.0.0.1',
    );
  });

  // The handler on its own; each request from `peer`, through the editor by default.
  function behindProxy(hops: number) {
    const handle = createHttpHandler({
      ...callers(),
      allowedOrigins: ['https://allowed.example'],
      loopbackOnly: false,
      trustProxy: trust(hops),
      now: () => 0,
    });
    return async (
      token: string,
      client: string,
      extra: Record<string, string> = {},
      peer = PROXY,
    ) => {
      const r = {
        url: '/mcp',
        // GET: past the checks, the 405 answers without any MCP work.
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          host: 'team.example',
          'x-forwarded-for': client,
          ...extra,
        },
        socket: { remoteAddress: peer },
      } as unknown as IncomingMessage;
      let status: number | undefined;
      const res = {
        headersSent: false,
        writeHead: (code: number) => (status = code),
        end: () => undefined,
      } as unknown as ServerResponse;
      await handle(r, res);
      return status;
    };
  }

  it('locks out a client address, not every caller behind the proxy', async () => {
    const send = behindProxy(1);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect(await send('wrong', '203.0.113.7')).toBe(401);
    }
    expect(await send('wrong', '203.0.113.7')).toBe(429);
    // A forged entry left of the proxy's own changes nothing.
    expect(await send('wrong', '198.51.100.9, 203.0.113.7')).toBe(429);
    // Another client behind the same proxy is still answered 401, not locked out.
    expect(await send('wrong', '198.51.100.2')).toBe(401);
  });

  it('limits the rate of each client address apart', async () => {
    const send = behindProxy(1);
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
      expect(await send(TOKEN, '203.0.113.7')).toBe(405);
    }
    expect(await send(TOKEN, '203.0.113.7')).toBe(429);
    expect(await send(TOKEN, '198.51.100.2')).toBe(405);
  });

  it('locks out and rate-limits a direct client by its own address, whatever X-Forwarded-For it sends', async () => {
    const send = behindProxy(1);
    const direct = '172.18.0.1';
    expect(await send(TOKEN, '198.51.100.3')).toBe(405);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect(await send('wrong', `198.51.100.${i}`, {}, direct)).toBe(401);
    }
    expect(await send('wrong', '198.51.100.200', {}, direct)).toBe(429);
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
      expect(await send(TOKEN, `203.0.113.${i % 250}`, {}, direct)).toBe(405);
    }
    expect(await send(TOKEN, '203.0.113.251', {}, direct)).toBe(429);
    // Callers through the editor are not affected.
    expect(await send(TOKEN, '198.51.100.2')).toBe(405);
  });

  it('still refuses an Origin it does not allow', async () => {
    const send = behindProxy(1);
    expect(
      await send(TOKEN, '203.0.113.7', { origin: 'https://team.example' }),
    ).toBe(403);
    expect(
      await send(TOKEN, '203.0.113.7', { origin: 'https://allowed.example' }),
    ).toBe(405);
  });
});

describe('per-caller tokens (#861)', () => {
  const OTHER = `ccms_sat_fedcba9876543210_${'0a1b2c3d4e5f6789'.repeat(4)}`;

  /** The handler on its own; each request a GET (past the checks, a 405 without MCP work). */
  function handler(
    options: Partial<Parameters<typeof createHttpHandler>[0]> = {},
  ) {
    const made = callers();
    const handle = createHttpHandler({
      ...made,
      allowedOrigins: [],
      loopbackOnly: false,
      ...options,
    });
    const send = async (token: string, address = '10.0.0.1') => {
      const req = {
        url: '/mcp',
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, host: 'mcp.example' },
        socket: { remoteAddress: address },
      } as unknown as IncomingMessage;
      const answer = {
        status: 0,
        headers: {} as Record<string, string>,
        body: '',
      };
      const res = {
        headersSent: false,
        writeHead: (code: number, headers: Record<string, string>) => {
          answer.status = code;
          answer.headers = headers;
        },
        end: (body: string) => (answer.body = body),
      } as unknown as ServerResponse;
      await handle(req, res);
      return answer;
    };
    return { send, apis: made.apis };
  }

  afterEach(() => vi.useRealTimers());

  it('checks a caller’s token with the API once, then serves it from the check kept', async () => {
    const { send, apis } = handler();
    expect((await send(TOKEN)).status).toBe(405);
    expect((await send(TOKEN)).status).toBe(405);
    expect(apis.get(TOKEN)?.callsTo('/me')).toHaveLength(1);
  });

  it('refuses a token holding more than content.read with 403 token-not-read-only, and keeps nothing of it', async () => {
    const wide = new StubApi().set('/me', {
      data: {
        meta: {
          permissions: [
            { permission: 'content.read' },
            { permission: 'content.read.draft' },
          ],
        },
      },
    });
    const made = callers({ [OTHER]: wide });
    const { send } = handler({ callerContext: made.callerContext });
    const answer = await send(OTHER);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('token-not-read-only');
    expect(answer.body).toContain('content.read.draft');
    // Refused again for a while without asking the API, never served.
    expect((await send(OTHER)).status).toBe(403);
    expect(wide.callsTo('/me')).toHaveLength(1);
  });

  it('stops serving a revoked token once its check is past its time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const { send, apis } = handler({ now: () => Date.now() });
    expect((await send(TOKEN)).status).toBe(405);
    apis
      .get(TOKEN)
      ?.set(
        '/me',
        new ToolError('token-revoked', 'Unauthorized', undefined, 401),
      );
    vi.setSystemTime(LOOKUP_TTL_MS);
    const revoked = await send(TOKEN);
    expect(revoked.status).toBe(401);
    expect(revoked.body).toContain('token-revoked');
    expect(revoked.body).not.toContain(TOKEN);
  });

  it('counts tokens the API refuses as failed attempts, and past the lockout asks the API only about admitted callers', async () => {
    const { send, apis } = handler({ now: () => 0 });
    expect((await send(TOKEN)).status).toBe(405);
    const unknown = (i: number) => TOKEN.replace(/.{4}$/, String(1000 + i));
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect((await send(unknown(i))).status).toBe(401);
    }
    // Past the lockout, every token not admitted gets the same 429, without asking the API...
    expect((await send('wrong')).status).toBe(429);
    expect((await send(unknown(99))).status).toBe(429);
    expect(apis.has(unknown(99))).toBe(false);
    // ...while an admitted caller is served.
    expect((await send(TOKEN)).status).toBe(405);
  });

  it('still checks and serves a new valid token while garbage from many addresses has tripped the global budget', async () => {
    const { send } = handler({ now: () => 0 });
    for (let n = 0; n < MAX_FAILURES_PER_WINDOW_ALL; n++) {
      expect(
        (await send('garbage', `10.1.${Math.floor(n / 5)}.${n % 5}`)).status,
      ).toBe(401);
    }
    expect((await send('garbage', '10.2.0.1')).status).toBe(429);
    // A first-time caller with a valid token, from an address of its own.
    expect((await send(TOKEN, '10.2.0.2')).status).toBe(405);
  });

  it('locks out a flood of well-formed but wrong tokens from one address by that address’s budget, without asking the API past it', async () => {
    const { send, apis } = handler({ now: () => 0 });
    const wrong = (i: number) => TOKEN.replace(/.{4}$/, String(3000 + i));
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect((await send(wrong(i), '10.3.0.1')).status).toBe(401);
    }
    expect((await send(wrong(50), '10.3.0.1')).status).toBe(429);
    expect(apis.has(wrong(50))).toBe(false);
    // Another address is not affected.
    expect((await send(wrong(51), '10.3.0.2')).status).toBe(401);
  });

  /** A handler whose API answers `/me` only once `release` is called, counting the checks under way. */
  function slowChecks() {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen = { now: 0, most: 0, total: 0 };
    const made = callers();
    const h = handler({
      callerContext: (token) => {
        const context = made.callerContext(token);
        const ensure = context.token.ensure.bind(context.token);
        context.token.ensure = async () => {
          seen.total++;
          seen.most = Math.max(seen.most, ++seen.now);
          await gate;
          seen.now--;
          return ensure();
        };
        return context;
      },
      now: () => 0,
    });
    return { ...h, release: () => release(), seen };
  }

  it('bounds the checks under way: per address (refusing past it) and for everyone (queueing)', async () => {
    const one = slowChecks();
    const wrong = (i: number) => TOKEN.replace(/.{4}$/, String(4000 + i));
    const fromOne = Array.from({ length: MAX_CHECKS_PER_ADDRESS + 2 }, (_, i) =>
      one.send(wrong(i), '10.4.0.1'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    one.release();
    const statuses = (await Promise.all(fromOne)).map((a) => a.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(
      MAX_CHECKS_PER_ADDRESS,
    );
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(one.seen.total).toBe(MAX_CHECKS_PER_ADDRESS);

    const all = slowChecks();
    const many = Array.from({ length: MAX_CHECKS_AT_ONCE + 10 }, (_, i) =>
      all.send(wrong(100 + i), `10.5.${Math.floor(i / 200)}.${i % 200}`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(all.seen.most).toBe(MAX_CHECKS_AT_ONCE);
    all.release();
    // The others waited their turn: every one was checked and answered, none turned away.
    const answers = (await Promise.all(many)).map((a) => a.status);
    expect(answers.every((s) => s === 401)).toBe(true);
    expect(all.seen.total).toBe(MAX_CHECKS_AT_ONCE + 10);
    expect(all.seen.most).toBe(MAX_CHECKS_AT_ONCE);
  });

  it('keeps the API’s 403 for a deactivated account, without asking the client to sign in again', async () => {
    const off = new StubApi().set(
      '/me',
      new ToolError('service-account-deactivated', 'Forbidden', undefined, 403),
    );
    const { send } = handler({
      callerContext: callers({ [OTHER]: off }).callerContext,
    });
    const answer = await send(OTHER);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('service-account-deactivated');
    expect(answer.headers['WWW-Authenticate']).toBeUndefined();
  });

  it('answers 503 when the API cannot check a token, never counting it against the caller', async () => {
    const down = new StubApi().set(
      '/me',
      new ToolError('api-unavailable', 'The content API could not be reached'),
    );
    const { send } = handler({
      callerContext: callers({ [OTHER]: down }).callerContext,
      now: () => 0,
    });
    for (let i = 0; i <= MAX_FAILURES_PER_WINDOW; i++) {
      const answer = await send(OTHER);
      expect(answer.status).toBe(503);
      expect(answer.headers['Retry-After']).toBeDefined();
    }
    expect((await send('wrong')).status).toBe(401);
  });

  it('still serves the deprecated shared token, reading as the server’s own account, beside callers’ own', async () => {
    const own = stubContext();
    const { send } = handler({ shared: { token: SHARED, context: own } });
    expect((await send(SHARED)).status).toBe(405);
    expect((await send(TOKEN)).status).toBe(405);
    expect((await send(SHARED.replace(/.$/, '0'))).status).toBe(401);
    // Without it configured, the shared token is just a wrong one.
    expect((await handler().send(SHARED)).status).toBe(401);
  });

  it('never shows one caller what another’s token reads: tag lists, releases, counts', async () => {
    // Caller A sees the release tags v1 and v0; caller B's scope reads none.
    const a = new StubApi().set('/variants', paged([]));
    const b = new StubApi()
      .set('/variants', paged([]))
      .set(
        '/refs',
        paged([
          {
            type: 'Ref',
            id: 'heads/main',
            attributes: {
              kind: 'branch',
              name: 'main',
              commit: 'c'.repeat(40),
            },
          },
        ]),
      )
      .set('/releases', paged([]));
    const made = callers({ [TOKEN]: a, [OTHER]: b });
    const s = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      callerContext: made.callerContext,
      allowedOrigins: [],
    });
    const at = new URL(
      `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`,
    );
    const connect = async (token: string) => {
      const c = new Client({ name: 'test', version: '1.0.0' });
      await c.connect(
        new StreamableHTTPClientTransport(at, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return c;
    };
    const ca = await connect(TOKEN);
    const cb = await connect(OTHER);
    const atTag = { name: 'list_variants', arguments: { ref: 'v1' } };
    expect((await ca.callTool(atTag)).isError).toBeFalsy();
    // A's lists were read and kept: B still reads its own, and is refused the tag.
    const refused = await cb.callTool(atTag);
    expect(refused.structuredContent).toMatchObject({
      error: { code: 'ref-not-released' },
    });
    const releases = async (c: Client) =>
      (await c.callTool({ name: 'list_releases', arguments: {} }))
        .structuredContent as { total: number };
    expect((await releases(ca)).total).toBe(2);
    expect((await releases(cb)).total).toBe(0);
    // Each caller's lists came from its own API client.
    expect(a.callsTo('/refs')).toHaveLength(1);
    expect(b.callsTo('/refs')).toHaveLength(1);
    await ca.close();
    await cb.close();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});
