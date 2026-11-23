import { execFileSync } from 'node:child_process';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitWriter } from '@openfolia/content-repo';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import {
  WebhookDeliveryDocument,
  WebhookDeliveryPageDocument,
  WebhookDocument,
  WebhookPageDocument,
  WebhookWithSecretDocument,
} from '../src/webhooks/api/webhook.resources.js';
import { WebhooksConsumer } from '../src/webhooks/api/webhooks-consumer.js';
import { verifyWebhookSignature } from '../src/webhooks/core/webhook-signature.js';
import { webhooks } from '../src/webhooks/repos/webhooks.tables.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Webhooks (#42) in the full app: subscribers, the outbox consumer, the
// delivery job, signatures, retries and scope. Every delivery goes to a
// receiver on this machine (the app allows http and loopback here only).

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const manager = user('hook-manager', ['webhook.manage', 'content.read']);
const publicManager = user(
  'public-hook-manager',
  ['webhook.manage', 'content.read'],
  { maxAudience: 'public' },
);
const publisher = user('hook-publisher', ['content.read', 'release.publish']);
const admin = user('hook-admin', ['admin.roles']);
const reader = user('hook-reader', ['content.read']);
/** Covers any owner: drafts and translations too. */
const everyOwner = user('hook-everything', [
  'webhook.manage',
  'content.read',
  'content.read.draft',
  'translation.manage',
]);

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let t: TestApp;
let receiver: Server;
let base: string;
const received: Received[] = [];
/** How the receiver answers: 200 unless a test says otherwise. */
let answer: (r: Received, res: ServerResponse) => void = (_r, res) =>
  res.writeHead(200).end();

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const consume = () => t.app.get(WebhooksConsumer).runOnce();
/**
 * Runs the delivery jobs, also the retries waiting for their backoff, and
 * lets a failing receiver's wait run out (as time would).
 */
const deliverAll = async () => {
  for (let round = 0; round < 12; round++) {
    await t.database.db.execute(
      sql`update webhooks set next_attempt_at = null`,
    );
    await t.database.db.execute(
      sql`update pgboss.job set start_after = now() where name = 'webhook.deliver' and state in ('created', 'retry')`,
    );
    if ((await t.runJobs()) === 0) return;
  }
};

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const r = { path: req.url ?? '', headers: req.headers, body };
      received.push(r);
      answer(r, res);
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  t = await createTestApp({
    CCMS_WEBHOOKS_ALLOW_HTTP: 'true',
    CCMS_WEBHOOKS_ALLOW_PRIVATE: 'true',
    CCMS_WEBHOOKS_TIMEOUT_MS: '2000',
  });
  await seedUsers(manager, publicManager, publisher, admin, reader, everyOwner);
});
afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});
afterEach(async () => {
  t?.actAs(undefined);
  received.length = 0;
  answer = (_r, res) => res.writeHead(200).end();
  if (t) await t.database.db.delete(webhooks);
});

async function seedUsers(...actors: Actor[]) {
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: actors.flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: actors.map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
}

const subscribe = async (
  path: string,
  events: string[],
  as: Actor = manager,
) => {
  t.actAs(as);
  const res = await t.post('/webhooks').send(
    JSON.stringify({
      data: {
        type: 'Webhook',
        attributes: { url: `${base}${path}`, events },
      },
    }),
  );
  expect(res.status).toBe(201);
  return { res, doc: WebhookWithSecretDocument.parse(res.body) };
};

let revisions = 0;
const cut = async () => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: {
        type: 'Release',
        attributes: { product: 'north', revision: `9.${revisions++}` },
      },
    }),
  );
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
};

const reword = () =>
  new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: `${git('show', 'main:modules/en/charging.adoc')}\nOne more sentence ${Date.now()}.\n`,
      },
    ],
    message: 'Reword charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });

const bodies = (path: string) =>
  received
    .filter((r) => r.path === path)
    .map(
      (r) =>
        JSON.parse(r.body) as { type: string; data: Record<string, unknown> },
    );

describe('managing subscribers', () => {
  it('needs webhook.manage', async () => {
    t.actAs(reader);
    expect((await t.get('/webhooks')).status).toBe(403);
    const res = await t.post('/webhooks').send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          attributes: { url: `${base}/x`, events: ['manual.released'] },
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  });

  it('shows the secret only when made and rotated, never in a read, a list or the audit log', async () => {
    const { res, doc } = await subscribe('/once', ['manual.released']);
    const secret = doc.meta.secret;
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['location']).toBe(`/webhooks/${doc.data.id}`);
    expect(doc.data.attributes).toMatchObject({
      url: `${base}/once`,
      events: ['manual.released'],
      active: true,
      owner: { kind: 'user', id: manager.id },
    });

    const one = await t.get(`/webhooks/${doc.data.id}`);
    expect(WebhookDocument.parse(one.body).data.id).toBe(doc.data.id);
    const list = await t.get('/webhooks');
    const listed = WebhookPageDocument.parse(list.body);
    expect(listed.meta.page.total).toBe(1);
    // The custom headers' limits, so a client checks a form before sending it (#560).
    expect(listed.meta.headerLimits).toEqual({
      maxHeaders: 20,
      maxHeaderName: 100,
      maxHeadersSize: 8192,
    });
    const rotated = await t.post(`/webhooks/${doc.data.id}/secret`);
    expect(rotated.status).toBe(200);
    const next = WebhookWithSecretDocument.parse(rotated.body).meta.secret;
    expect(next).not.toBe(secret);
    t.actAs(admin);
    const audit = await t.get(
      `/audit-events?filter[subject]=webhook/${doc.data.id}`,
    );
    expect(
      AuditEventPageDocument.parse(audit.body).data.map(
        (e) => e.attributes.action,
      ),
    ).toEqual(['webhook.rotate-secret', 'webhook.create']);
    t.actAs(manager);
    for (const text of [
      JSON.stringify(one.body),
      JSON.stringify(list.body),
      JSON.stringify(audit.body),
      JSON.stringify((await t.get(`/webhooks/${doc.data.id}`)).body),
    ]) {
      expect(text).not.toContain(secret.slice(6));
      expect(text).not.toContain(next.slice(6));
    }
    // Stored sealed: not even the database holds the secret as text.
    const [row] = await t.database.db.select().from(webhooks);
    expect(JSON.stringify(row)).not.toContain(secret.slice(6));
    expect(JSON.stringify(row)).not.toContain(next.slice(6));
  });

  it('refuses a URL with credentials or a fragment, and a malformed body', async () => {
    t.actAs(manager);
    for (const [url, problem] of [
      ['http://u:p@127.0.0.1/', 'credentials'],
      [`${base}/#x`, 'fragment'],
      ['ftp://127.0.0.1/', 'scheme'],
    ]) {
      const res = await t.post('/webhooks').send(
        JSON.stringify({
          data: {
            type: 'Webhook',
            attributes: { url, events: ['manual.released'] },
          },
        }),
      );
      expect([url, res.status, errors(res.body)[0]?.meta]).toEqual([
        url,
        422,
        { problem },
      ]);
    }
    const none = await t.post('/webhooks').send(
      JSON.stringify({
        data: { type: 'Webhook', attributes: { url: `${base}/`, events: [] } },
      }),
    );
    expect(none.status).toBe(400);
  });

  it('pauses, resumes and deletes', async () => {
    const { doc } = await subscribe('/pause', ['manual.released']);
    const id = doc.data.id;
    const paused = await t.patch(`/webhooks/${id}`).send(
      JSON.stringify({
        data: { type: 'Webhook', id, attributes: { active: false } },
      }),
    );
    expect(WebhookDocument.parse(paused.body).data.attributes.active).toBe(
      false,
    );
    const mismatch = await t.patch(`/webhooks/${id}`).send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          id: '00000000-0000-7000-8000-000000000000',
          attributes: {},
        },
      }),
    );
    expect(errors(mismatch.body)[0]?.code).toBe('id-mismatch');
    expect((await t.delete(`/webhooks/${id}`)).status).toBe(204);
    expect((await t.get(`/webhooks/${id}`)).status).toBe(404);
  });
});

describe('delivering events', () => {
  it('delivers each changed manual and module of a release, signed, as its owner may read it', async () => {
    const everything = await subscribe('/all', [
      'manual.released',
      'module.released',
    ]);
    const scoped = await subscribe(
      '/public',
      ['manual.released'],
      publicManager,
    );
    // Events before this point are history to both.
    await consume();
    await deliverAll();
    received.length = 0;

    const release = await cut();
    expect((await consume())?.deliveries).toBeGreaterThan(0);
    await deliverAll();

    const all = bodies('/all');
    const manuals = all.filter((b) => b.type === 'manual.released');
    expect(manuals.length).toBeGreaterThan(0);
    for (const b of manuals) {
      expect(b.data).toMatchObject({
        releaseId: release.id,
        tag: release.attributes.tag,
        commit: release.attributes.commit,
      });
    }
    const publicOnes = bodies('/public').map((b) => b.data['manualId']);
    // Only manuals the public-scoped owner reads (not the internal service manual).
    expect(publicOnes).not.toContain('service');
    expect(manuals.map((b) => b.data['manualId'])).toContain('service');

    for (const r of received) {
      const secret =
        r.path === '/all' ? everything.doc.meta.secret : scoped.doc.meta.secret;
      // The documented recipe: HMAC-SHA256 over `<t>.<raw body>`.
      expect(
        verifyWebhookSignature(
          r.headers['x-ccms-signature'] as string,
          r.body,
          secret,
        ),
      ).toBe(true);
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
      expect(r.headers['x-ccms-delivery']).toBeDefined();
      expect(JSON.parse(r.body)).toMatchObject({
        idempotencyKey: r.headers['idempotency-key'],
        type: r.headers['x-ccms-event'],
      });
    }

    // A module changed in the next release: one module.released with its content hash.
    received.length = 0;
    await reword();
    await cut();
    await consume();
    await deliverAll();
    const modules = bodies('/all').filter((b) => b.type === 'module.released');
    expect(
      modules.map((b) => `${b.data['lang']}/${b.data['moduleId']}`),
    ).toEqual(['en/charging']);
    expect(modules[0]?.data).toMatchObject({
      change: 'changed',
      contentHash: expect.stringMatching(/^[0-9a-f]+$/),
    });

    t.actAs(manager);
    const log = await t.get(`/webhooks/${everything.doc.data.id}/deliveries`);
    const page = WebhookDeliveryPageDocument.parse(log.body);
    expect(page.data.every((d) => d.attributes.status === 'succeeded')).toBe(
      true,
    );
    expect(JSON.stringify(log.body)).not.toContain(
      everything.doc.meta.secret.slice(6),
    );
    // To a manager with a narrower scope, another's subscriber does not exist.
    t.actAs(publicManager);
    for (const path of ['', '/deliveries']) {
      const hidden = await t.get(`/webhooks/${everything.doc.data.id}${path}`);
      expect(hidden.status).toBe(404);
    }
    const listed = await t.get('/webhooks');
    expect(
      (listed.body as { data: { id: string }[] }).data.map((w) => w.id),
    ).toEqual([scoped.doc.data.id]);
    // A reader of everything released (no drafts) sees both, not imports.
    const imports = await subscribe(
      '/imports',
      ['translation.imported'],
      everyOwner,
    );
    t.actAs(manager);
    expect(
      ((await t.get('/webhooks')).body as { data: { id: string }[] }).data.map(
        (w) => w.id,
      ),
    ).toEqual([everything.doc.data.id, scoped.doc.data.id]);
    t.actAs(everyOwner);
    expect(
      ((await t.get('/webhooks')).body as { data: { id: string }[] }).data.map(
        (w) => w.id,
      ),
    ).toEqual([
      everything.doc.data.id,
      scoped.doc.data.id,
      imports.doc.data.id,
    ]);
    t.actAs(publicManager);
    const own = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${scoped.doc.data.id}/deliveries`)).body,
    );
    expect(own.data.every((d) => d.attributes.payload !== null)).toBe(true);
    t.actAs(manager);
    const filtered = await t.get(
      `/webhooks/${everything.doc.data.id}/deliveries?filter[event]=module.released`,
    );
    expect(
      WebhookDeliveryPageDocument.parse(filtered.body).data.map(
        (d) => d.attributes.event,
      ),
    ).toEqual(['module.released']);
  });

  it('moves a subscriber only to a manager covering its owner, and never sends what was made for the old owner', async () => {
    const events = ['manual.released', 'release.withdrawn'];
    const hook = await subscribe('/old', events, publicManager);
    const id = hook.doc.data.id;
    const patch = (attributes: Record<string, unknown>) =>
      t
        .patch(`/webhooks/${id}`)
        .send(JSON.stringify({ data: { type: 'Webhook', id, attributes } }));
    await consume();
    await deliverAll();
    received.length = 0;
    const withdrawn = await cut();
    t.actAs(publisher);
    expect(
      (
        await t
          .post(`/releases/${withdrawn.id}/withdraw`)
          .send(JSON.stringify({ meta: { reason: 'Wrong revision.' } }))
      ).status,
    ).toBe(200);
    // Made for the public-scoped owner, not sent yet.
    expect((await consume())?.deliveries).toBeGreaterThan(0);

    // The same URL and events again: nobody takes it over.
    t.actAs(manager);
    const same = await patch({ url: `${base}/old`, events });
    expect(same.status).toBe(200);
    expect(same.body.data.attributes.owner).toEqual({
      kind: 'user',
      id: publicManager.id,
    });
    // A narrower scope may not point another's subscriber elsewhere.
    const mine = await subscribe('/mine', ['manual.released']);
    t.actAs(publicManager);
    const refused = await t.patch(`/webhooks/${mine.doc.data.id}`).send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          id: mine.doc.data.id,
          attributes: { url: `${base}/elsewhere` },
        },
      }),
    );
    expect(refused.status).toBe(404);
    expect(errors(refused.body)[0]?.code).toBe('not-found');

    // A manager reading everything takes it over: the deliveries waiting,
    // made for the old owner, are skipped, never sent to the new URL.
    t.actAs(manager);
    const moved = await patch({ url: `${base}/new` });
    expect(moved.status).toBe(200);
    expect(moved.body.data.attributes.owner).toEqual({
      kind: 'user',
      id: manager.id,
    });
    await deliverAll();
    expect(received.filter((r) => r.path !== '/mine')).toHaveLength(0);
    const log = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${id}/deliveries`)).body,
    ).data;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((d) => d.attributes.status === 'skipped')).toBe(true);
    // The old owner, narrower, no longer sees it.
    t.actAs(publicManager);
    expect((await t.get(`/webhooks/${id}/deliveries`)).status).toBe(404);

    // What follows is made for the new owner's scope.
    received.length = 0;
    await reword();
    await cut();
    await consume();
    await deliverAll();
    const manuals = bodies('/new').map((b) => b.data['manualId']);
    expect(manuals).toContain('service');
    expect(bodies('/old')).toHaveLength(0);
    t.actAs(manager);
    const after = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${id}/deliveries?filter[status]=succeeded`)).body,
    ).data;
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((d) => d.attributes.payload !== null)).toBe(true);
  });

  it('retries a failed delivery with the same key, and never sends it again after success', async () => {
    const hook = await subscribe('/flaky', ['release.withdrawn']);
    await consume();
    const release = await cut();
    t.actAs(publisher);
    expect(
      (
        await t
          .post(`/releases/${release.id}/withdraw`)
          .send(JSON.stringify({ meta: { reason: 'Wrong revision.' } }))
      ).status,
    ).toBe(200);
    let calls = 0;
    answer = (_r, res) => res.writeHead(++calls < 3 ? 503 : 200).end();
    await consume();
    await deliverAll();
    const hits = received.filter((r) => r.path === '/flaky');
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(new Set(hits.map((r) => r.headers['x-ccms-delivery'])).size).toBe(1);
    expect(new Set(hits.map((r) => r.body)).size).toBe(1);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({
      type: 'release.withdrawn',
      data: { releaseId: release.id, reason: 'Wrong revision.' },
    });

    // The outbox read again from the start (a lost cursor): nothing new is sent.
    await t.database.db.execute(
      sql`update outbox_consumers set last_tx_id = '0'::xid8, last_outbox_id = 0 where name = 'webhooks'`,
    );
    await consume();
    await deliverAll();
    expect(received.filter((r) => r.path === '/flaky')).toHaveLength(3);

    t.actAs(manager);
    const [delivery] = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${hook.doc.data.id}/deliveries`)).body,
    ).data;
    expect(delivery?.attributes).toMatchObject({
      status: 'succeeded',
      attempts: 3,
      lastStatusCode: 200,
    });
  });

  it('fires nothing for drafts and reviews', async () => {
    await subscribe('/drafts', [
      'manual.released',
      'module.released',
      'release.withdrawn',
    ]);
    await consume();
    await t.database.db.insert(outbox).values({
      topic: 'change-set.submit',
      key: `submit-${Date.now()}`,
      payload: { changeSetId: '00000000-0000-7000-8000-000000000000' },
    });
    await consume();
    await deliverAll();
    expect(received.filter((r) => r.path === '/drafts')).toHaveLength(0);
  });

  it('never logs a secret, a signature or the URL', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        logs.push(
          args
            .map((a) =>
              a instanceof Error
                ? `${a.name} ${a.message} ${a.stack}`
                : String(a),
            )
            .join(' '),
        );
      });
    }
    try {
      const hook = await subscribe('/secret-path?token=hidden', [
        'manual.released',
      ]);
      await consume();
      answer = (_r, res) => res.writeHead(500).end();
      await cut();
      await consume();
      await deliverAll();
      const text = logs.join('\n');
      expect(text).not.toContain(hook.doc.meta.secret.slice(6));
      expect(text).not.toContain('token=hidden');
      expect(text).not.toContain('v1=');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('test events and retries by hand (#254)', () => {
  it('sends a signed test event at once, shows its 200 in the log, and never shows the secret again', async () => {
    const { doc } = await subscribe('/ping', ['manual.released']);
    const id = doc.data.id;
    const secret = doc.meta.secret;
    const res = await t.post(`/webhooks/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const delivery = WebhookDeliveryDocument.parse(res.body).data;
    expect(delivery.attributes).toMatchObject({
      event: 'ping',
      status: 'succeeded',
      attempts: 1,
      lastStatusCode: 200,
      payload: { type: 'ping', data: { webhookId: id } },
    });
    const [hit] = received.filter((r) => r.path === '/ping');
    expect(hit?.headers['x-ccms-event']).toBe('ping');
    expect(hit?.headers['x-ccms-delivery']).toBe(delivery.id);
    expect(
      verifyWebhookSignature(
        hit!.headers['x-ccms-signature'] as string,
        hit!.body,
        secret,
      ),
    ).toBe(true);
    const log = await t.get(`/webhooks/${id}/deliveries?filter[event]=ping`);
    expect(
      WebhookDeliveryPageDocument.parse(log.body).data.map((d) => [
        d.id,
        d.attributes.lastStatusCode,
      ]),
    ).toEqual([[delivery.id, 200]]);
    const listed = WebhookPageDocument.parse((await t.get('/webhooks')).body);
    expect(listed.data[0]?.meta.lastDelivery).toMatchObject({
      id: delivery.id,
      event: 'ping',
      status: 'succeeded',
      lastStatusCode: 200,
    });
    for (const text of [
      JSON.stringify(res.body),
      JSON.stringify(log.body),
      JSON.stringify(listed),
    ]) {
      expect(text).not.toContain(secret.slice(6));
    }
    t.actAs(admin);
    const audit = await t.get(`/audit-events?filter[subject]=webhook/${id}`);
    expect(
      AuditEventPageDocument.parse(audit.body).data.map(
        (e) => e.attributes.action,
      ),
    ).toEqual(['webhook.test', 'webhook.create']);
  });

  it('records a failed test event, then answers 429 while the receiver waits; hides it from a narrower manager', async () => {
    const { doc } = await subscribe('/down', ['manual.released']);
    const id = doc.data.id;
    answer = (_r, res) => res.writeHead(500).end();
    const failed = await t.post(`/webhooks/${id}/test`);
    expect(failed.status).toBe(200);
    expect(
      WebhookDeliveryDocument.parse(failed.body).data.attributes,
    ).toMatchObject({
      status: 'failed',
      lastStatusCode: 500,
      lastError: 'http-status',
    });
    const busy = await t.post(`/webhooks/${id}/test`);
    expect(busy.status).toBe(429);
    expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
    expect(errors(busy.body)[0]?.code).toBe('rate-limited');
    expect(received.filter((r) => r.path === '/down')).toHaveLength(1);
    // Never counted toward disabling it.
    const after = WebhookDocument.parse((await t.get(`/webhooks/${id}`)).body);
    expect(after.data.meta.consecutiveFailures).toBe(0);
    t.actAs(publicManager);
    expect((await t.post(`/webhooks/${id}/test`)).status).toBe(404);
  });

  it('sends a failed delivery again from the log, and refuses what is not failed', async () => {
    const hook = await subscribe('/retry', ['release.withdrawn']);
    const id = hook.doc.data.id;
    await consume();
    const release = await cut();
    t.actAs(publisher);
    expect(
      (
        await t
          .post(`/releases/${release.id}/withdraw`)
          .send(JSON.stringify({ meta: { reason: 'Wrong revision.' } }))
      ).status,
    ).toBe(200);
    answer = (_r, res) => res.writeHead(503).end();
    await consume();
    await deliverAll();
    t.actAs(manager);
    const [failed] = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${id}/deliveries?filter[status]=failed`)).body,
    ).data;
    expect(failed?.attributes).toMatchObject({
      event: 'release.withdrawn',
      attempts: 9,
      lastStatusCode: 503,
    });
    answer = (_r, res) => res.writeHead(200).end();
    const retried = await t.post(
      `/webhooks/${id}/deliveries/${failed!.id}/retry`,
    );
    expect(retried.status).toBe(200);
    expect(
      WebhookDeliveryDocument.parse(retried.body).data.attributes.status,
    ).toBe('pending');
    const again = await t.post(
      `/webhooks/${id}/deliveries/${failed!.id}/retry`,
    );
    expect(again.status).toBe(409);
    expect(errors(again.body)[0]).toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'status' },
    });
    await deliverAll();
    const settled = WebhookDeliveryPageDocument.parse(
      (await t.get(`/webhooks/${id}/deliveries`)).body,
    ).data.find((d) => d.id === failed!.id);
    expect(settled?.attributes).toMatchObject({
      status: 'succeeded',
      attempts: 10,
      lastStatusCode: 200,
    });
    expect(
      (
        await t.post(
          `/webhooks/${id}/deliveries/00000000-0000-7000-8000-000000000000/retry`,
        )
      ).status,
    ).toBe(404);
  });

  it('keeps an audience limit, and sends a limited subscriber nothing above it', async () => {
    const limited = await subscribe('/limited', ['manual.released']);
    const id = limited.doc.data.id;
    const set = await t.patch(`/webhooks/${id}`).send(
      JSON.stringify({
        data: { type: 'Webhook', id, attributes: { maxAudience: 'public' } },
      }),
    );
    expect(WebhookDocument.parse(set.body).data.attributes.maxAudience).toBe(
      'public',
    );
    const open = await subscribe('/open', ['manual.released']);
    expect(open.doc.data.attributes.maxAudience).toBeNull();
    await consume();
    await deliverAll();
    received.length = 0;
    await reword();
    await cut();
    await consume();
    await deliverAll();
    const everything = bodies('/open').map((b) => b.data['manualId']);
    expect(everything).toContain('service');
    const capped = bodies('/limited').map((b) => b.data['manualId']);
    // What the release changed depends on the releases before it in this file: the limited
    // subscriber hears of a subset of what the open one does, never the restricted manual.
    expect(everything.length).toBeGreaterThan(capped.length);
    for (const manual of capped) expect(everything).toContain(manual);
    expect(capped).not.toContain('service');
    const bad = await t.patch(`/webhooks/${id}`).send(
      JSON.stringify({
        data: { type: 'Webhook', id, attributes: { maxAudience: 'Not A Key' } },
      }),
    );
    expect(bad.status).toBe(400);
  });
  it('delivers a deprecated manual to an owner who may read it, its replacement only when they may read that too (#558)', async () => {
    const open = await subscribe('/manuals', ['manual.deprecated']);
    await subscribe('/manuals-public', ['manual.deprecated'], publicManager);
    await subscribe('/releases-only', ['manual.released']);
    await consume();
    await deliverAll();
    received.length = 0;
    const commit = git('rev-parse', 'refs/heads/main');
    // As a merge into `main` writes them (#266): a public and an internal manual.
    await t.database.db.insert(outbox).values([
      {
        topic: 'manual.deprecated',
        key: 'hook-test/operating',
        payload: {
          manualId: 'operating',
          reason: 'Merged.',
          replacedBy: 'service',
          changeSetId: 'hook-test',
          commit,
        },
      },
      {
        topic: 'manual.deprecated',
        key: 'hook-test/service',
        payload: {
          manualId: 'service',
          reason: 'Merged.',
          replacedBy: null,
          changeSetId: 'hook-test',
          commit,
        },
      },
    ]);
    expect((await consume())?.deliveries).toBeGreaterThan(0);
    await deliverAll();
    const told = (path: string) =>
      bodies(path).map((b) => [
        b.type,
        b.data['manualId'],
        b.data['replacedBy'],
      ]);
    expect(told('/manuals')).toEqual(
      expect.arrayContaining([
        ['manual.deprecated', 'operating', 'service'],
        ['manual.deprecated', 'service', null],
      ]),
    );
    expect(told('/manuals')).toHaveLength(2);
    expect(bodies('/manuals')[0]?.data).toMatchObject({
      commit,
      reason: 'Merged.',
    });
    // The internal manual, and the replacement, are above this owner's audience.
    expect(told('/manuals-public')).toEqual([
      ['manual.deprecated', 'operating', null],
    ]);
    expect(bodies('/releases-only')).toEqual([]);
    t.actAs(manager);
    const log = WebhookDeliveryPageDocument.parse(
      (
        await t.get(
          `/webhooks/${open.doc.data.id}/deliveries?filter[event]=manual.deprecated`,
        )
      ).body,
    );
    expect(log.data).toHaveLength(2);
  });
});

describe('custom headers (#457)', () => {
  const TOKEN = 'Bearer e2e-header-secret-91c4';
  const withHeaders = async (path: string, headers: unknown[]) => {
    t.actAs(manager);
    const res = await t.post('/webhooks').send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          attributes: {
            url: `${base}${path}`,
            events: ['release.withdrawn'],
            headers,
          },
        },
      }),
    );
    return res;
  };
  const patch = (id: string, attributes: Record<string, unknown>) =>
    t
      .patch(`/webhooks/${id}`)
      .send(JSON.stringify({ data: { type: 'Webhook', id, attributes } }));
  const ping = async (id: string) => {
    received.length = 0;
    const res = await t.post(`/webhooks/${id}/test`);
    expect(res.status).toBe(200);
    return {
      hit: received[0],
      delivery: WebhookDeliveryDocument.parse(res.body),
    };
  };

  it('delivers a secret and a plain header on every attempt, retries and test events too, and never shows the secret value', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        logs.push(args.map((a) => String(a)).join(' '));
      });
    }
    try {
      const created = await withHeaders('/headers', [
        { name: 'Authorization', value: TOKEN, secret: true },
        { name: 'X-Api-Version', value: '2' },
      ]);
      expect(created.status).toBe(201);
      const id = WebhookWithSecretDocument.parse(created.body).data.id;
      expect(
        WebhookWithSecretDocument.parse(created.body).data.attributes.headers,
      ).toEqual([
        { name: 'Authorization', secret: true, value: null },
        { name: 'X-Api-Version', secret: false, value: '2' },
      ]);
      const one = await t.get(`/webhooks/${id}`);
      expect(WebhookDocument.parse(one.body).data.attributes.headers).toEqual([
        { name: 'Authorization', secret: true, value: null },
        { name: 'X-Api-Version', secret: false, value: '2' },
      ]);
      const list = await t.get('/webhooks');
      WebhookPageDocument.parse(list.body);

      // The test event carries them.
      const { hit, delivery } = await ping(id);
      expect(hit?.headers['authorization']).toBe(TOKEN);
      expect(hit?.headers['x-api-version']).toBe('2');
      expect(delivery.data.attributes.sentHeaders).toEqual(
        expect.arrayContaining([
          'Authorization',
          'X-Api-Version',
          'X-Ccms-Signature',
        ]),
      );

      // A delivery and its retries carry them.
      await consume();
      const release = await cut();
      t.actAs(publisher);
      expect(
        (
          await t
            .post(`/releases/${release.id}/withdraw`)
            .send(JSON.stringify({ meta: { reason: 'Headers.' } }))
        ).status,
      ).toBe(200);
      let calls = 0;
      answer = (_r, res) => res.writeHead(++calls < 2 ? 503 : 200).end();
      received.length = 0;
      await consume();
      await deliverAll();
      const hits = received.filter((r) => r.path === '/headers');
      expect(hits).toHaveLength(2);
      expect(hits.map((r) => r.headers['authorization'])).toEqual([
        TOKEN,
        TOKEN,
      ]);

      t.actAs(manager);
      const log = await t.get(`/webhooks/${id}/deliveries`);
      WebhookDeliveryPageDocument.parse(log.body);
      t.actAs(admin);
      const audit = await t.get(`/audit-events?filter[subject]=webhook/${id}`);
      const events = AuditEventPageDocument.parse(audit.body).data;
      expect(
        events.find((e) => e.attributes.action === 'webhook.create')?.attributes
          .data,
      ).toMatchObject({
        headers: [
          { name: 'Authorization', secret: true },
          { name: 'X-Api-Version', secret: false },
        ],
      });
      for (const text of [
        JSON.stringify(created.body),
        JSON.stringify(one.body),
        JSON.stringify(list.body),
        JSON.stringify(log.body),
        JSON.stringify(audit.body),
        logs.join('\n'),
      ]) {
        expect(text).not.toContain('e2e-header-secret');
      }
      // Stored sealed, never as it is.
      const rows = await t.database.db
        .select({ headers: webhooks.headers })
        .from(webhooks);
      expect(JSON.stringify(rows)).not.toContain('e2e-header-secret');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses names the server sets or that break delivery, and malformed values, each with its code and pointer', async () => {
    const res = await withHeaders('/refused', [
      { name: 'Host', value: 'elsewhere.example' },
      { name: 'x-ccms-signature', value: 't=1,v1=00' },
      { name: 'Proxy-Authorization', value: 'Basic eA==' },
      { name: 'Content-Length', value: '1' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'Bad Name', value: 'x' },
      { name: 'X-Injected', value: 'a\r\nX-Evil: 1' },
      { name: 'X-Twice', value: '1' },
      { name: 'x-twice', value: '2' },
      { name: 'X-Empty' },
      { name: 'X-New-Secret', secret: true },
    ]);
    expect(res.status).toBe(422);
    expect(errors(res.body).map((e) => [e.code, e.source?.pointer])).toEqual([
      ['header-name-refused', '/data/attributes/headers/0/name'],
      ['header-name-refused', '/data/attributes/headers/1/name'],
      ['header-name-refused', '/data/attributes/headers/2/name'],
      ['header-name-refused', '/data/attributes/headers/3/name'],
      ['header-name-refused', '/data/attributes/headers/4/name'],
      ['header-name-invalid', '/data/attributes/headers/5/name'],
      ['header-value-invalid', '/data/attributes/headers/6/value'],
      ['header-name-duplicate', '/data/attributes/headers/8/name'],
      ['header-value-required', '/data/attributes/headers/9/value'],
      ['header-value-required', '/data/attributes/headers/10/value'],
    ]);
    expect(JSON.stringify(res.body)).not.toContain('X-Evil');
    const many = await withHeaders(
      '/many',
      Array.from({ length: 21 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })),
    );
    expect(errors(many.body).map((e) => e.code)).toEqual(['too-many-headers']);
    const large = await withHeaders('/large', [
      { name: 'X-Big', value: 'a'.repeat(8_190) },
    ]);
    expect(errors(large.body).map((e) => e.code)).toEqual([
      'headers-too-large',
    ]);
    t.actAs(manager);
    expect(
      WebhookPageDocument.parse((await t.get('/webhooks')).body).data,
    ).toEqual([]);
  });

  it('keeps a secret header left without a value, replaces and removes it; a new URL needs it again', async () => {
    const created = await withHeaders('/keep', [
      { name: 'Authorization', value: TOKEN, secret: true },
    ]);
    const id = WebhookWithSecretDocument.parse(created.body).data.id;

    // Kept: the editor sends it back without its value.
    const kept = await patch(id, {
      description: 'Kept',
      headers: [
        { name: 'authorization', secret: true },
        { name: 'X-Plain', value: 'one' },
      ],
    });
    expect(kept.status).toBe(200);
    expect((await ping(id)).hit?.headers['authorization']).toBe(TOKEN);

    // Replaced.
    const replaced = await patch(id, {
      headers: [
        { name: 'Authorization', value: 'Bearer replaced', secret: true },
        { name: 'X-Plain', value: 'one' },
      ],
    });
    expect(replaced.status).toBe(200);
    expect((await ping(id)).hit?.headers['authorization']).toBe(
      'Bearer replaced',
    );
    t.actAs(admin);
    const audit = AuditEventPageDocument.parse(
      (await t.get(`/audit-events?filter[subject]=webhook/${id}`)).body,
    ).data;
    expect(audit.map((e) => e.attributes.data['headers'])).toContainEqual({
      added: [],
      removed: [],
      changed: [],
      secretChanged: ['Authorization'],
    });
    expect(JSON.stringify(audit)).not.toContain('replaced');
    t.actAs(manager);

    // A new URL: the secret is not sent there unless given again.
    const moved = await patch(id, { url: `${base}/moved` });
    expect(moved.status).toBe(422);
    expect(errors(moved.body).map((e) => [e.code, e.source?.pointer])).toEqual([
      ['header-value-required', '/data/attributes/headers'],
    ]);
    const movedKeeping = await patch(id, {
      url: `${base}/moved`,
      headers: [{ name: 'Authorization', secret: true }],
    });
    expect(errors(movedKeeping.body).map((e) => e.code)).toEqual([
      'header-value-required',
    ]);

    // Removed: no longer sent.
    const removed = await patch(id, {
      url: `${base}/moved`,
      headers: [{ name: 'X-Plain', value: 'one' }],
    });
    expect(removed.status).toBe(200);
    expect(WebhookDocument.parse(removed.body).data.attributes.headers).toEqual(
      [{ name: 'X-Plain', secret: false, value: 'one' }],
    );
    const { hit } = await ping(id);
    expect(hit?.headers['authorization']).toBeUndefined();
    expect(hit?.headers['x-plain']).toBe('one');
  });

  it('lets only the owner or a manager covering any owner change another’s headers', async () => {
    t.actAs(everyOwner);
    const created = await t.post('/webhooks').send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          attributes: {
            url: `${base}/others`,
            events: ['release.withdrawn'],
            headers: [{ name: 'X-Api-Key', value: 'k-1', secret: true }],
          },
        },
      }),
    );
    const id = WebhookWithSecretDocument.parse(created.body).data.id;
    // `manager` sees it (it covers any owner of `release.withdrawn`), but
    // not any owner of any webhook: it may not change the headers...
    t.actAs(manager);
    const refused = await patch(id, { headers: [] });
    expect(refused.status).toBe(403);
    expect(errors(refused.body).map((e) => e.code)).toEqual(['forbidden']);
    // ...though handing them back unchanged with another change is fine.
    expect(
      (
        await patch(id, {
          description: 'Renamed',
          headers: [{ name: 'X-Api-Key', secret: true }],
        })
      ).status,
    ).toBe(200);
    t.actAs(publicManager);
    expect((await patch(id, { headers: [] })).status).toBe(404);
    t.actAs(everyOwner);
    expect((await patch(id, { headers: [] })).status).toBe(200);
  });
});
