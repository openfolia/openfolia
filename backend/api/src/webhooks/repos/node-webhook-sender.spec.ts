import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeWebhookSender, type Resolve } from './node-webhook-sender.js';

/** A receiver on this machine: never a real outbound call. */
let server: Server;
let port: number;
let received: { req: IncomingMessage; body: string }[] = [];
let respond: (
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ req, body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received = [];
  respond = (_req, res) => res.writeHead(200).end('ok');
});

const LOCAL = { allowHttp: true, allowPrivate: true };
const STRICT_HTTP = { allowHttp: true, allowPrivate: false };
const request = (url: string) => ({
  url,
  headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' },
  body: '{"a":1}',
});
/** Resolves every name to `addresses`, counting the lookups. */
const resolving = (...addresses: string[]) => {
  const calls: string[] = [];
  const resolve: Resolve = async (hostname) => {
    calls.push(hostname);
    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
  return { resolve, calls };
};

describe('NodeWebhookSender', () => {
  it('posts the body and headers and answers the status', async () => {
    const sender = new NodeWebhookSender(LOCAL, 2_000);
    const result = await sender.send(
      request(`http://127.0.0.1:${port}/hook?x=1`),
    );
    expect(result).toEqual({ ok: true, statusCode: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]?.req.method).toBe('POST');
    expect(received[0]?.req.url).toBe('/hook?x=1');
    expect(received[0]?.req.headers['x-test']).toBe('yes');
    expect(received[0]?.body).toBe('{"a":1}');
  });

  it('refuses a name resolving to a blocked address, without connecting', async () => {
    const { resolve } = resolving('127.0.0.1');
    const sender = new NodeWebhookSender(STRICT_HTTP, 2_000, resolve);
    expect(
      await sender.send(request(`http://receiver.example:${port}/`)),
    ).toEqual({ ok: false, error: 'blocked-address', statusCode: null });
    expect(received).toHaveLength(0);
  });

  it('refuses when any of the addresses is blocked (one public, one private)', async () => {
    const { resolve } = resolving('93.184.216.34', '169.254.169.254');
    const sender = new NodeWebhookSender(STRICT_HTTP, 2_000, resolve);
    expect(
      await sender.send(request(`http://receiver.example:${port}/`)),
    ).toMatchObject({ ok: false, error: 'blocked-address' });
  });

  it('refuses a literal blocked address in the URL, also in another notation', async () => {
    const sender = new NodeWebhookSender(STRICT_HTTP, 2_000);
    for (const host of [
      '127.0.0.1',
      '[::1]',
      '0x7f.0.0.1',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(
        await sender.send(request(`http://${host}:${port}/`)),
      ).toMatchObject({ ok: false, error: 'blocked-address' });
    }
    expect(received).toHaveLength(0);
  });

  it('connects to the address it checked, resolving once (no rebinding), with the host name kept', async () => {
    const { resolve, calls } = resolving('127.0.0.1');
    const sender = new NodeWebhookSender(LOCAL, 2_000, resolve);
    expect(
      await sender.send(request(`http://receiver.example:${port}/pinned`)),
    ).toEqual({ ok: true, statusCode: 200 });
    expect(calls).toEqual(['receiver.example']);
    expect(received[0]?.req.headers.host).toBe(`receiver.example:${port}`);
  });

  it('follows no redirect', async () => {
    respond = (_req, res) =>
      res
        .writeHead(307, { Location: `http://127.0.0.1:${port}/elsewhere` })
        .end();
    const sender = new NodeWebhookSender(LOCAL, 2_000);
    expect(await sender.send(request(`http://127.0.0.1:${port}/`))).toEqual({
      ok: false,
      error: 'http-status',
      statusCode: 307,
    });
    expect(received).toHaveLength(1);
  });

  it('gives up after the timeout', async () => {
    respond = () => undefined; // never answers
    const sender = new NodeWebhookSender(LOCAL, 200);
    const started = Date.now();
    expect(await sender.send(request(`http://127.0.0.1:${port}/`))).toEqual({
      ok: false,
      error: 'timeout',
      statusCode: null,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('cancels a lookup that never answers when the attempt is cut off', async () => {
    let cancelled = false;
    const hanging: Resolve = (_hostname, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          cancelled = true;
          reject(new Error('cancelled'));
        }),
      );
    const sender = new NodeWebhookSender(STRICT_HTTP, 100, hanging);
    expect(
      await sender.send({
        url: 'http://slow.example/hook',
        headers: {},
        body: '{}',
      }),
    ).toEqual({ ok: false, error: 'timeout', statusCode: null });
    expect(cancelled).toBe(true);
  });

  it('reads no body and stops at oversized headers', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'X-Big': 'a'.repeat(32 * 1024) });
      res.end();
    };
    const sender = new NodeWebhookSender(LOCAL, 2_000);
    expect(await sender.send(request(`http://127.0.0.1:${port}/`))).toEqual({
      ok: false,
      error: 'connection',
      statusCode: null,
    });
  });

  it('reports a refused connection, a non-2xx and a scheme the rules do not allow', async () => {
    const sender = new NodeWebhookSender(LOCAL, 2_000);
    expect(await sender.send(request('http://127.0.0.1:1/'))).toMatchObject({
      ok: false,
      error: 'connection',
    });
    respond = (_req, res) => res.writeHead(500).end();
    expect(await sender.send(request(`http://127.0.0.1:${port}/`))).toEqual({
      ok: false,
      error: 'http-status',
      statusCode: 500,
    });
    const strict = new NodeWebhookSender(
      { allowHttp: false, allowPrivate: true },
      2_000,
    );
    expect(await strict.send(request(`http://127.0.0.1:${port}/`))).toEqual({
      ok: false,
      error: 'blocked-url',
      statusCode: null,
    });
  });
});
