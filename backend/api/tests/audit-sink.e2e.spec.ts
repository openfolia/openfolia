import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { AuditSinkConsumer } from '../src/audit/api/audit-sink-consumer.js';
import { SendToAuditSinkAction } from '../src/audit/core/actions/send-to-audit-sink.action.js';
import { AuditSink } from '../src/audit/core/audit-sink.js';
import { DrizzleAuditSinkCursor } from '../src/audit/repos/drizzle-audit-sink-cursor.js';
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from '../src/webhooks/core/webhook-signature.js';
import { createTestApp, type TestApp } from './test-app.js';
import {
  makeTestCertificate,
  type TestCertificate,
} from './tls-certificate.js';

const SECRET = `whsec_${'5e'.repeat(32)}`;

const admin: Actor = {
  kind: 'user',
  id: 'sample-admin',
  roles: [
    { id: 'role', name: 'Role', permissions: ['admin.roles'], scope: {} },
  ],
};

interface Delivered {
  events: { id: string; action: string; subject: { id: string } }[];
}

// #379: the audit log copied to an HTTPS sink as it grows (a receiver on this
// machine, with a certificate of its own), and retention through the database's
// own function.
describe('the audit sink (e2e)', () => {
  let certificate: TestCertificate;
  let server: Server;
  let port: number;
  let received: { headers: IncomingMessage['headers']; body: string }[];
  let respond: (res: ServerResponse) => void;
  let t: TestApp;

  beforeAll(async () => {
    certificate = makeTestCertificate();
    server = createServer(
      { key: certificate.key, cert: certificate.cert },
      (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          respond(res);
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    certificate?.remove();
  });

  beforeEach(async () => {
    received = [];
    respond = (res) => res.writeHead(200).end();
    t = await createTestApp({
      CCMS_AUDIT_SINK_URL: `https://localhost:${port}/audit`,
      CCMS_AUDIT_SINK_SECRET: SECRET,
      CCMS_AUDIT_SINK_CA_FILE: certificate.certFile,
    });
    t.actAs(admin);
  });
  afterEach(() => t?.close());

  const deliver = () => t.app.get(AuditSinkConsumer).runOnce();
  const ids = () =>
    received.flatMap((r) =>
      (JSON.parse(r.body) as Delivered).events.map((e) => e.id),
    );
  /** Records an `audit-log.export` event: what the sink then has to deliver. */
  const recordOne = async () =>
    expect((await t.get('/audit-events/export?format=jsonl')).status).toBe(200);

  it('delivers every event once, in order, signed; a failed delivery is sent again', async () => {
    await recordOne();
    await recordOne();

    respond = (res) => res.writeHead(503).end();
    const failed = await deliver();
    expect(failed?.stopped).toMatchObject({
      reason: 'failed',
      result: { error: 'http-status', statusCode: 503 },
    });
    expect(received).toHaveLength(1);

    respond = (res) => res.writeHead(204).end();
    expect(await deliver()).toEqual({ sent: 2 });
    expect(received).toHaveLength(2);
    // The same batch both times: at least once, in order.
    expect(received[0]!.body).toBe(received[1]!.body);
    const [first, second] = (JSON.parse(received[1]!.body) as Delivered)
      .events as [Delivered['events'][number], Delivered['events'][number]];
    expect(first.action).toBe('audit-log.export');
    expect(Number(first.id)).toBeLessThan(Number(second.id));
    expect(
      verifyWebhookSignature(
        received[1]!.headers[SIGNATURE_HEADER.toLowerCase()] as string,
        received[1]!.body,
        SECRET,
      ),
    ).toBe(true);

    // Nothing new: nothing sent.
    expect(await deliver()).toEqual({ sent: 0 });
    expect(received).toHaveLength(2);
  });

  it('goes on after a restart from where the last server stopped', async () => {
    await recordOne();
    expect(await deliver()).toEqual({ sent: 1 });
    await recordOne();
    // Another process (the restarted server) with a cursor of its own, once
    // the old one's lease ran out.
    await t.database.db.execute(
      sql`update audit_sink set claimed_until = now() - interval '1 second'`,
    );
    const restarted = new SendToAuditSinkAction(
      t.app.get(AuditSink),
      new DrizzleAuditSinkCursor(t.database),
    );
    expect(
      await restarted.handle({
        holder: 'restarted',
        leaseMs: 60_000,
        deadline: Date.now() + 10_000,
      }),
    ).toEqual({ sent: 1 });
    const delivered = ids();
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(2);
  });
});
