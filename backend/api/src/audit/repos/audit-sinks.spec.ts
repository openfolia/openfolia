import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
} from 'node:net';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
} from 'node:tls';
import {
  makeTestCertificate,
  type TestCertificate,
} from '../../../tests/tls-certificate.js';
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from '../../webhooks/core/webhook-signature.js';
import type { AuditEvent } from '../core/audit-event.js';
import { SINK_APP_NAME } from '../core/audit-sink.js';
import { HttpsAuditSink } from './https-audit-sink.js';
import {
  headerField,
  SyslogAuditSink,
  syslogFrame,
} from './syslog-audit-sink.js';

const SECRET = `whsec_${'ab'.repeat(32)}`;

const event = (id: string, action = 'role.update'): AuditEvent => ({
  id,
  at: new Date('2026-11-01T10:00:00.000Z'),
  kind: 'write',
  actor: { kind: 'user', id: 'ada' },
  action,
  subject: { type: 'role', id: 'author' },
  comment: id === '1' ? 'line one\nline two\u2028' : null,
  data: { n: Number(id), word: 'Grüße' },
});

let certificate: TestCertificate;
beforeAll(() => {
  certificate = makeTestCertificate();
});
afterAll(() => certificate?.remove());

const listen = async (server: Server | TlsServer | TcpServer) => {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  return (server.address() as AddressInfo).port;
};
const close = (server: Server | TlsServer | TcpServer) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('HttpsAuditSink', () => {
  let server: Server;
  let port: number;
  let received: { req: IncomingMessage; body: string }[];
  let respond: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    server = createHttpsServer(
      { key: certificate.key, cert: certificate.cert },
      (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        req.on('end', () => {
          received.push({ req, body });
          respond(req, res);
        });
      },
    );
    port = await listen(server);
  });
  afterAll(() => close(server));
  beforeEach(() => {
    received = [];
    respond = (_req, res) => res.writeHead(204).end();
  });

  const sink = (
    options: { ca?: Buffer; timeoutMs?: number; path?: string } = {},
  ) =>
    new HttpsAuditSink({
      url: new URL(`https://localhost:${port}${options.path ?? '/audit?x=1'}`),
      secret: SECRET,
      timeoutMs: options.timeoutMs ?? 5_000,
      ca: 'ca' in options ? options.ca : certificate.cert,
    });

  it('posts the batch in order as JSON, signed with the secret, and a 2xx is a delivery', async () => {
    const result = await sink().send([event('1'), event('2')]);

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    const { req, body } = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/audit?x=1');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['user-agent']).toBe(`${SINK_APP_NAME}-audit-sink`);
    const signature = req.headers[SIGNATURE_HEADER.toLowerCase()];
    expect(typeof signature).toBe('string');
    expect(verifyWebhookSignature(signature as string, body, SECRET)).toBe(
      true,
    );
    expect(
      verifyWebhookSignature(signature as string, `${body} `, SECRET),
    ).toBe(false);
    const parsed = JSON.parse(body) as { events: Record<string, unknown>[] };
    expect(parsed.events.map((e) => e.id)).toEqual(['1', '2']);
    expect(parsed.events[0]).toEqual({
      id: '1',
      at: '2026-11-01T10:00:00.000Z',
      kind: 'write',
      actor: { kind: 'user', id: 'ada' },
      action: 'role.update',
      subject: { type: 'role', id: 'author' },
      comment: 'line one\nline two\u2028',
      data: { n: 1, word: 'Grüße' },
    });
  });

  it('fails on an answer that is not 2xx, a redirect too (never followed)', async () => {
    respond = (_req, res) => res.writeHead(503).end('busy');
    expect(await sink().send([event('1')])).toEqual({
      ok: false,
      error: 'http-status',
      statusCode: 503,
    });
    respond = (_req, res) =>
      res.writeHead(302, { Location: 'https://localhost/elsewhere' }).end();
    expect(await sink().send([event('1')])).toEqual({
      ok: false,
      error: 'http-status',
      statusCode: 302,
    });
    expect(received).toHaveLength(2);
  });

  it('fails when the certificate is not trusted, sending nothing', async () => {
    expect(await sink({ ca: undefined }).send([event('1')])).toEqual({
      ok: false,
      error: 'connection',
    });
    expect(received).toHaveLength(0);
  });

  it('fails after the timeout when no answer comes', async () => {
    respond = () => undefined;
    expect(await sink({ timeoutMs: 1_000 }).send([event('1')])).toEqual({
      ok: false,
      error: 'timeout',
    });
  });
});

/** RFC 5425 frames: `<octets> <message>`, one after another. */
function frames(bytes: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const length = Number(bytes.subarray(at, space).toString('ascii'));
    out.push(bytes.subarray(space + 1, space + 1 + length).toString('utf8'));
    at = space + 1 + length;
  }
  return out;
}

describe('syslogFrame', () => {
  it('is an RFC 5424 message, octet-counted: priority, time, host, app, pid, action, JSON', () => {
    const frame = syslogFrame(event('7'), 'api-1', 42);
    const [message = ''] = frames(frame);
    expect(frame.toString('utf8')).toMatch(/^\d+ <110>1 /);
    expect(message).toBe(
      `<110>1 2026-11-01T10:00:00.000Z api-1 ${SINK_APP_NAME} 42 role.update - \uFEFF{"id":"7","at":"2026-11-01T10:00:00.000Z","kind":"write","actor":{"kind":"user","id":"ada"},"action":"role.update","subject":{"type":"role","id":"author"},"comment":null,"data":{"n":7,"word":"Grüße"}}`,
    );
    // The count is octets, not characters (ü, ß and the BOM take more than one).
    const space = frame.indexOf(0x20);
    expect(Number(frame.subarray(0, space).toString())).toBe(
      frame.length - space - 1,
    );
  });

  it('cuts MSGID to 32 printable characters and keeps a message on one line', () => {
    const long = `change-set.${'a'.repeat(40)}`;
    const [message = ''] = frames(
      syslogFrame(event('1', long), 'host with space', 1),
    );
    const fields = message.split(' ');
    expect(fields[2]).toBe('hostwithspace');
    expect(fields[5]).toBe(long.slice(0, 32));
    expect(message).not.toMatch(/[\n\r\u2028]/);
    expect(headerField('', 10)).toBe('-');
  });
});

describe('SyslogAuditSink', () => {
  let server: TlsServer;
  let port: number;
  let received: Buffer[];

  beforeAll(async () => {
    server = createTlsServer(
      { key: certificate.key, cert: certificate.cert },
      (socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => {
          received.push(Buffer.concat(chunks));
          socket.end();
        });
      },
    );
    port = await listen(server);
  });
  afterAll(() => close(server));
  beforeEach(() => {
    received = [];
  });

  const sink = (
    options: { ca?: Buffer; port?: number; timeoutMs?: number } = {},
  ) =>
    new SyslogAuditSink({
      host: 'localhost',
      port: options.port ?? port,
      timeoutMs: options.timeoutMs ?? 5_000,
      ca: 'ca' in options ? options.ca : certificate.cert,
      hostname: 'api-1',
    });

  it('writes one frame per event, in order, over one TLS connection', async () => {
    expect(await sink().send([event('1'), event('2'), event('3')])).toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const messages = frames(received[0]!);
    expect(
      messages.map((m) => JSON.parse(m.slice(m.indexOf('\uFEFF') + 1)).id),
    ).toEqual(['1', '2', '3']);
  });

  it('fails when the certificate is not trusted, sending nothing', async () => {
    expect(await sink({ ca: undefined }).send([event('1')])).toEqual({
      ok: false,
      error: 'connection',
    });
    expect(received).toHaveLength(0);
  });

  it('fails when the connection breaks before the batch is flushed, never counting it delivered', async () => {
    const breaking = createTlsServer(
      { key: certificate.key, cert: certificate.cert },
      (socket) => socket.once('data', () => socket.destroy()),
    );
    const breakingPort = await listen(breaking);
    try {
      const big = Array.from({ length: 300 }, (_, i) => ({
        ...event(String(i + 1)),
        data: { text: 'x'.repeat(60_000) },
      }));
      expect(await sink({ port: breakingPort }).send(big)).toEqual({
        ok: false,
        error: 'connection',
      });
    } finally {
      breaking.close();
    }
  });

  it('fails on a refused connection, and after the timeout on a silent one', async () => {
    const silent = createTcpServer(() => undefined);
    const silentPort = await listen(silent);
    const closed = createTcpServer();
    const closedPort = await listen(closed);
    await close(closed);
    try {
      expect(await sink({ port: closedPort }).send([event('1')])).toEqual({
        ok: false,
        error: 'connection',
      });
      expect(
        await sink({ port: silentPort, timeoutMs: 1_000 }).send([event('1')]),
      ).toEqual({ ok: false, error: 'timeout' });
    } finally {
      silent.close();
    }
  });
});
