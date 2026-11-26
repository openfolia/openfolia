import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import {
  WebhookDeliveryPageDocument,
  WebhookPageDocument,
  WebhookWithSecretDocument,
} from '../src/webhooks/api/webhook.resources.js';
import { WebhooksConsumer } from '../src/webhooks/api/webhooks-consumer.js';
import { WEBHOOK_EVENTS } from '../src/webhooks/core/webhook.js';
import { idempotencyKey } from '../src/webhooks/core/webhook-events.js';
import { webhooks } from '../src/webhooks/repos/webhooks.tables.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// What every registered webhook event tells, and to whom, pinned exactly as the full app sends
// it: for each event, a subscriber whose owner may read what it names gets this body, and one
// whose owner may not gets nothing. A change here changes what subscribers receive.

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
/** Reads every released content: every event but imports. */
const reader = user('pin-reader', ['webhook.manage', 'content.read']);
/** Reads public content only. */
const publicReader = user('pin-public', ['webhook.manage', 'content.read'], {
  maxAudience: 'public',
});
/** Manages webhooks, reads nothing: hears of nothing. */
const blind = user('pin-blind', ['webhook.manage']);
/** Reads drafts and manages translations too: every event. */
const everything = user('pin-everything', [
  'webhook.manage',
  'content.read',
  'content.read.draft',
  'translation.manage',
]);
/** Manages translations, reads no drafts: no import. */
const translatorOnly = user('pin-translator', [
  'webhook.manage',
  'content.read',
  'translation.manage',
]);
/** Reads drafts, manages no translations: no import. */
const draftsOnly = user('pin-drafts', [
  'webhook.manage',
  'content.read',
  'content.read.draft',
]);
const publisher = user('pin-publisher', ['content.read', 'release.publish']);

interface Body {
  type: string;
  idempotencyKey: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

let t: TestApp;
let receiver: Server;
let base: string;
const received: { path: string; body: string }[] = [];

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const consume = () => t.app.get(WebhooksConsumer).runOnce();
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
/** Every delivery so far is history: only what follows is looked at. */
const settle = async () => {
  await consume();
  await deliverAll();
  received.length = 0;
};
const bodies = (path: string): Body[] =>
  received
    .filter((r) => r.path === path)
    .map((r) => JSON.parse(r.body) as Body)
    .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
/** Sorted as `bodies` sorts them. */
const sorted = (expected: Body[]) =>
  [...expected].sort((a, b) =>
    a.idempotencyKey.localeCompare(b.idempotencyKey),
  );

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(200).end();
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
  const actors = [
    reader,
    publicReader,
    blind,
    everything,
    translatorOnly,
    draftsOnly,
    publisher,
  ];
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
});
afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});
afterEach(async () => {
  t?.actAs(undefined);
  received.length = 0;
  if (t) await t.database.db.delete(webhooks);
});

const subscribe = async (
  path: string,
  owner: Actor,
  events: readonly string[] = WEBHOOK_EVENTS,
  maxAudience?: string,
) => {
  t.actAs(owner);
  const res = await t.post('/webhooks').send(
    JSON.stringify({
      data: {
        type: 'Webhook',
        attributes: {
          url: `${base}${path}`,
          events,
          ...(maxAudience !== undefined && { maxAudience }),
        },
      },
    }),
  );
  expect(res.status).toBe(201);
  return WebhookWithSecretDocument.parse(res.body).data.id;
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
        attributes: { product: 'north', revision: `8.${revisions++}` },
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

/** Writes outbox rows as their components write them, and when they were written. */
const write = async (
  rows: { topic: string; key: string; payload: Record<string, unknown> }[],
) => {
  const made = await t.database.db.insert(outbox).values(rows).returning();
  return made.map((r) => r.createdAt.toISOString());
};

describe('the payload of every registered event, and who gets it', () => {
  it('covers every registered event', () => {
    // A new event brings its rows here.
    expect([...WEBHOOK_EVENTS]).toEqual([
      'manual.released',
      'module.released',
      'module.deprecated',
      'manual.deprecated',
      'release.withdrawn',
      'translation.imported',
    ]);
  });

  it('manual.released and module.released: what the release changed, as the owner reads it', async () => {
    await subscribe('/reader', reader, ['manual.released', 'module.released']);
    await subscribe('/public', publicReader, [
      'manual.released',
      'module.released',
    ]);
    await subscribe('/capped', reader, ['manual.released'], 'public');
    await subscribe('/blind', blind, ['manual.released', 'module.released']);
    await subscribe('/everything', everything);
    await cut();
    await settle();

    await reword();
    const release = await cut();
    await consume();
    await deliverAll();
    const at = release.attributes.commit;
    const [occurredAt] = (
      await t.database.db.execute<{ created_at: string }>(
        sql`select created_at from outbox where topic = 'release.published' order by id desc limit 1`,
      )
    ).rows.map((r) => new Date(r.created_at).toISOString());
    const about = {
      releaseId: release.id,
      product: 'north',
      revision: release.attributes.revision,
      tag: release.attributes.tag,
      commit: at,
      major: false,
    };
    const manual = (manualId: string, languages: unknown[]): Body => ({
      type: 'manual.released',
      idempotencyKey: idempotencyKey('manual.released', release.id, manualId),
      occurredAt: occurredAt!,
      data: { ...about, manualId, languages, complete: true },
    });
    const contentHash = git('rev-parse', `${at}:modules/en/charging.adoc`);
    const module: Body = {
      type: 'module.released',
      idempotencyKey: idempotencyKey(
        'module.released',
        release.id,
        'en/charging',
        contentHash,
      ),
      occurredAt: occurredAt!,
      data: {
        ...about,
        moduleId: 'charging',
        lang: 'en',
        change: 'changed',
        contentHash,
        complete: true,
      },
    };
    const changed = [{ lang: 'en', change: 'changed' }];
    const all = sorted([
      manual('operating', changed),
      manual('service', changed),
      module,
    ]);
    expect(bodies('/reader')).toEqual(all);
    expect(bodies('/everything')).toEqual(all);
    // The internal manual is outside the public reader's scope, and so is the module's new text:
    // to them it is gone.
    expect(bodies('/public')).toEqual(
      sorted([
        manual('operating', changed),
        {
          type: 'module.released',
          idempotencyKey: idempotencyKey(
            'module.released',
            release.id,
            'en/charging',
            'removed',
          ),
          occurredAt: occurredAt!,
          data: {
            ...about,
            moduleId: 'charging',
            lang: 'en',
            change: 'removed',
            contentHash: null,
            complete: true,
          },
        },
      ]),
    );
    // An audience limit cuts what the owner reads.
    expect(bodies('/capped')).toEqual([manual('operating', changed)]);
    expect(bodies('/blind')).toEqual([]);
  });

  it('release.withdrawn, module.deprecated, manual.deprecated and translation.imported: each to whom may read what it names', async () => {
    await subscribe('/reader', reader);
    await subscribe('/public', publicReader);
    await subscribe('/capped', reader, WEBHOOK_EVENTS, 'public');
    await subscribe('/blind', blind);
    await subscribe('/everything', everything);
    await subscribe('/translator', translatorOnly, ['translation.imported']);
    await subscribe('/drafts', draftsOnly, ['translation.imported']);
    await settle();
    const commit = git('rev-parse', 'refs/heads/main');
    const occurred = await write([
      {
        topic: 'release.withdrawn',
        key: 'pin/withdrawn',
        payload: {
          releaseId: 'pin-release',
          product: 'north',
          revision: '7.0',
          tag: 'north/7.0',
          commit,
          reason: 'Recalled.',
        },
      },
      {
        topic: 'module.deprecated',
        key: 'pin/safety-note',
        payload: {
          moduleId: 'safety-note',
          lang: 'en',
          commit,
          reason: 'Superseded.',
          replacedBy: 'internals',
        },
      },
      {
        topic: 'module.deprecated',
        key: 'pin/internals',
        payload: { moduleId: 'internals', commit },
      },
      {
        topic: 'manual.deprecated',
        key: 'pin/operating',
        payload: {
          manualId: 'operating',
          reason: 'Merged.',
          replacedBy: 'service',
          changeSetId: 'pin',
          commit,
        },
      },
      {
        topic: 'manual.deprecated',
        key: 'pin/service',
        payload: {
          manualId: 'service',
          reason: 'Merged.',
          replacedBy: null,
          changeSetId: 'pin',
          commit,
        },
      },
      {
        topic: 'translation.imported',
        key: 'pin/import',
        payload: { importId: 'pin-import', changeSetId: 'pin-change-set' },
      },
      // Not what its topic writes: nothing, to anyone.
      { topic: 'manual.deprecated', key: 'pin/bad', payload: { manualId: 1 } },
    ]);
    expect((await consume())?.deliveries).toBeGreaterThan(0);
    await deliverAll();
    const [
      withdrawnAt,
      safetyNoteAt,
      internalsAt,
      operatingAt,
      serviceAt,
      importAt,
    ] = occurred as [string, string, string, string, string, string];

    const withdrawn: Body = {
      type: 'release.withdrawn',
      idempotencyKey: idempotencyKey('release.withdrawn', 'pin-release'),
      occurredAt: withdrawnAt,
      data: {
        releaseId: 'pin-release',
        product: 'north',
        revision: '7.0',
        tag: 'north/7.0',
        commit,
        reason: 'Recalled.',
      },
    };
    const safetyNote = (replacedBy: string | null): Body => ({
      type: 'module.deprecated',
      idempotencyKey: idempotencyKey(
        'module.deprecated',
        'safety-note',
        'en',
        commit,
      ),
      occurredAt: safetyNoteAt,
      data: {
        moduleId: 'safety-note',
        lang: 'en',
        commit,
        reason: 'Superseded.',
        replacedBy,
      },
    });
    const internals: Body = {
      type: 'module.deprecated',
      idempotencyKey: idempotencyKey(
        'module.deprecated',
        'internals',
        '',
        commit,
      ),
      occurredAt: internalsAt,
      data: { moduleId: 'internals', commit, reason: null, replacedBy: null },
    };
    const operating = (replacedBy: string | null): Body => ({
      type: 'manual.deprecated',
      idempotencyKey: idempotencyKey('manual.deprecated', 'operating', commit),
      occurredAt: operatingAt,
      data: { manualId: 'operating', commit, reason: 'Merged.', replacedBy },
    });
    const service: Body = {
      type: 'manual.deprecated',
      idempotencyKey: idempotencyKey('manual.deprecated', 'service', commit),
      occurredAt: serviceAt,
      data: {
        manualId: 'service',
        commit,
        reason: 'Merged.',
        replacedBy: null,
      },
    };
    const imported: Body = {
      type: 'translation.imported',
      idempotencyKey: idempotencyKey('translation.imported', 'pin-import'),
      occurredAt: importAt,
      data: { importId: 'pin-import', changeSetId: 'pin-change-set' },
    };

    const released = [
      withdrawn,
      safetyNote('internals'),
      internals,
      operating('service'),
      service,
    ];
    expect(bodies('/reader')).toEqual(sorted(released));
    expect(bodies('/everything')).toEqual(sorted([...released, imported]));
    // Neither the internal module and manual nor a replacement that is internal; no import.
    const narrowed = [withdrawn, safetyNote(null), operating(null)];
    expect(bodies('/public')).toEqual(sorted(narrowed));
    // The audience limit narrows as the scope does; a withdrawal names no content.
    expect(bodies('/capped')).toEqual(sorted(narrowed));
    expect(bodies('/blind')).toEqual([]);
    // An import needs both translation.manage and content.read.draft.
    expect(bodies('/translator')).toEqual([]);
    expect(bodies('/drafts')).toEqual([]);
  });

  it('shows a subscriber, and a delivery’s body, only to its owner or to whom covers any owner of its events', async () => {
    const imports = await subscribe('/imports', everything, [
      'translation.imported',
    ]);
    const releases = await subscribe('/releases', everything, [
      'release.withdrawn',
    ]);
    await settle();
    await write([
      {
        topic: 'translation.imported',
        key: 'pin/shown',
        payload: { importId: 'pin-shown' },
      },
      {
        topic: 'release.withdrawn',
        key: 'pin/shown',
        payload: {
          releaseId: 'pin-shown',
          product: 'north',
          revision: '7.1',
          tag: 'north/7.1',
          commit: git('rev-parse', 'refs/heads/main'),
          reason: '',
        },
      },
    ]);
    await consume();
    await deliverAll();
    const listed = async (as: Actor) => {
      t.actAs(as);
      return WebhookPageDocument.parse(
        (await t.get('/webhooks')).body,
      ).data.map((w) => w.id);
    };
    const payloads = async (as: Actor, id: string) => {
      t.actAs(as);
      const res = await t.get(`/webhooks/${id}/deliveries`);
      if (res.status !== 200) return res.status;
      return WebhookDeliveryPageDocument.parse(res.body).data.map(
        (d) => d.attributes.payload !== null,
      );
    };
    expect(await listed(everything)).toEqual([imports, releases]);
    expect(await listed(reader)).toEqual([releases]);
    expect(await listed(publicReader)).toEqual([]);
    expect(await listed(blind)).toEqual([]);
    // Covering an import's owners needs both, restricting nothing.
    expect(await listed(translatorOnly)).toEqual([releases]);
    expect(await listed(draftsOnly)).toEqual([releases]);
    expect(await payloads(everything, imports)).toEqual([true]);
    expect(await payloads(reader, imports)).toBe(404);
    expect(await payloads(translatorOnly, imports)).toBe(404);
    expect(await payloads(draftsOnly, imports)).toBe(404);
    expect(await payloads(reader, releases)).toEqual([true]);
    expect(await payloads(publicReader, releases)).toBe(404);
  });
});
