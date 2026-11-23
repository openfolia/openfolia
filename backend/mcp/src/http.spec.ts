import type { AddressInfo } from 'node:net';
import {
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { paged, stubContext } from '../tests/stub-api.js';
import {
  MAX_BODY_BYTES,
  MAX_FAILURES_PER_WINDOW,
  MAX_FAILURES_PER_WINDOW_ALL,
  createHttpHandler,
  startHttpServer,
} from './http.js';

const TOKEN = '6c1e9a40d7f25b83e0a94c7d2f1b68e5';

let server: Server;
let url: string;
beforeAll(async () => {
  const context = stubContext();
  context.api.set('/variants', paged([]));
  server = await startHttpServer(context, {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
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

  it('refuses calls without its token, or with another (the API token is not it)', async () => {
    const { client: c, transport } = client(undefined);
    await expect(c.connect(transport)).rejects.toThrow();
    const wrong = await post({ Authorization: `Bearer ${'x'.repeat(40)}` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer');
    expect(await wrong.text()).not.toContain('x'.repeat(40));
    expect((await post({ Authorization: TOKEN })).status).toBe(401);
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
    const s = await startHttpServer(stubContext(), {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
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

  it('lock out wrong tokens from an address for the window, the same for every wrong one, and still serve the token', async () => {
    let now = 0;
    const { send, close } = await server(() => now);
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
    // A caller holding the token is served, even from the locked address (a NAT, a proxy).
    expect((await send(TOKEN)).status).toBe(200);
    now = 60_000;
    expect((await send('wrong')).status).toBe(401);
    await close();
  });

  it('bound the failures of all addresses together', async () => {
    // The handler on its own, so each request can come from its own address.
    const handle = createHttpHandler(stubContext(), {
      token: TOKEN,
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
    // From many addresses, none over its own limit: the global budget trips.
    for (let n = 0; n < MAX_FAILURES_PER_WINDOW_ALL; n++) {
      expect(await send('wrong', `10.0.${Math.floor(n / 5)}.${n % 5}`)).toBe(
        401,
      );
    }
    expect(await send('wrong', '10.9.9.9')).toBe(429);
    // The token is still served; requests stop there, before any MCP work.
    expect(await send(TOKEN, '10.9.9.9')).not.toBe(429);
  });
});
