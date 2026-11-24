import dns from 'node:dns';
import net from 'node:net';
import { PERMISSIONS } from '../src/access/core/permissions.js';
import { IdentityProviders } from '../src/access/core/identity-provider.js';
import { AuditSink } from '../src/audit/core/audit-sink.js';
import { NoAuditSink } from '../src/audit/audit.module.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { BlobStore } from '../src/blobs/core/blob-store.js';
import { FsBlobStore } from '../src/blobs/repos/fs-blob-store.js';
import { SandboxBlobStore } from '../src/blobs/repos/sandbox-blob-store.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { Mailer } from '../src/mail/core/mail-ports.js';
import { NoMailer } from '../src/mail/mail.module.js';
import { SandboxDocument } from '../src/sandbox/api/sandbox.resources.js';
import { Sandbox } from '../src/sandbox/core/sandbox.js';
import { Embedder } from '../src/search/core/embedder.js';
import { NoEmbedder } from '../src/search/repos/no-embedder.js';
import { StyleReviewer } from '../src/style-review/core/style-reviewer.js';
import { NoStyleReviewer } from '../src/style-review/repos/no-style-reviewer.js';
import { StableAddressSettings } from '../src/addresses/core/stable-address.js';
import { WebhookSender } from '../src/webhooks/core/webhook-ports.js';
import { SandboxWebhookSender } from '../src/webhooks/repos/sandbox-webhook-sender.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';
import { SANDBOX_REFUSED_SETTINGS } from '../src/config/sandbox-env.js';

/**
 * A public sandbox (#826) over the real app: nothing leaves the instance (every adapter that
 * reaches the network is its sandbox one, and no connection leaves this machine while the tests
 * run), nothing reaches other people (403 `sandbox-not-allowed`), and what one visitor makes is
 * bounded (422 `sandbox-limit-reached`).
 */
let t: TestApp;
/** Every connection or lookup a test made to anything but this machine. */
const outbound: string[] = [];
const loopback = (host: unknown) =>
  typeof host !== 'string' ||
  host === 'localhost' ||
  host === '::1' ||
  host === '' ||
  /^127\./.test(host) ||
  /^::ffff:127\./.test(host);
const restore: (() => void)[] = [];

beforeAll(async () => {
  // Watches the sockets and the resolver for the whole file: an adapter that slipped through
  // would try one of them.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    // `net.connect` hands over its arguments normalized, as an array.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const options =
      typeof first === 'object' && first !== null
        ? (first as { host?: unknown; path?: unknown })
        : { host: args[1] };
    if (options.path === undefined && !loopback(options.host ?? 'localhost')) {
      outbound.push(`connect ${String(options.host)}`);
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  restore.push(() => (net.Socket.prototype.connect = connect));
  const lookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (!loopback(host)) outbound.push(`lookup ${host}`);
    return (lookup as (...a: unknown[]) => unknown)(host, ...rest);
  };
  restore.push(() => ((dns as { lookup: unknown }).lookup = lookup));
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!loopback(url.hostname)) outbound.push(`fetch ${url.hostname}`);
    return fetch(input, init);
  };
  restore.push(() => (globalThis.fetch = fetch));

  t = await createTestApp({
    // Whatever the machine's settings hold, none of the refused ones (blank is unset).
    ...Object.fromEntries(SANDBOX_REFUSED_SETTINGS.map((name) => [name, ''])),
    CCMS_BLOB_DRIVER: 'fs',
    CCMS_ROLE: 'all',
    CCMS_AUTH_MODE: 'demo',
    CCMS_PUBLIC_SANDBOX: 'on',
    CCMS_SANDBOX_MAX_CHANGE_SETS: '3',
    CCMS_SANDBOX_MAX_COMMENT_LENGTH: '20',
    CCMS_SANDBOX_MAX_MODULE_BYTES: '8000',
    CCMS_SANDBOX_MAX_MODULES: '1',
    CCMS_SANDBOX_RELEASES_PER_HOUR: '1',
    CCMS_SANDBOX_PORTAL_URL: 'https://manuals.example.org/',
  });
  t.actAs(EVERYTHING);
});
afterAll(async () => {
  await t?.close();
  for (const undo of restore.reverse()) undo();
});

/** Holds every permission: each refusal is the sandbox's, never a missing permission. */
const EVERYTHING = { ...actorWith([...PERMISSIONS]), id: 'sample-admin' };

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const json = (body: unknown) => JSON.stringify(body);

let changeSetCount = 0;
async function changeSet(): Promise<string> {
  const res = await t.post('/change-sets').send(
    json({
      data: { type: 'ChangeSet', attributes: { title: 'Sandbox' } },
    }),
  );
  expect(res.status).toBe(201);
  changeSetCount += 1;
  return ChangeSetDocument.parse(res.body).data.id;
}

const upload = (path: string) =>
  t
    .anonymous()
    .post(path)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set(REQUEST_HEADER, '1')
    .attach('file', Buffer.from('not read'), {
      filename: 'picture.png',
      contentType: 'image/png',
    });

describe('a public sandbox (#826)', () => {
  it('says so: GET /sandbox with its caps and its end', async () => {
    const res = await t.get('/sandbox');
    expect(res.status).toBe(200);
    const { data } = SandboxDocument.parse(res.body);
    expect(data.attributes).toEqual({
      limits: {
        moduleBytes: 8000,
        commentLength: 20,
        changeSets: 3,
        modules: 1,
        manuals: 10,
        releasesPerHour: 1,
        renderJobs: 1,
        writeBytes: 67_108_864,
      },
      idleMinutes: 30,
      maxMinutes: 90,
      portalUrl: 'https://manuals.example.org/',
    });
    expect(Date.parse(data.meta.endsAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(data.meta.endsAt)).toBeLessThanOrEqual(
      Date.parse(data.meta.startedAt) + 90 * 60_000,
    );
  });

  it('moves its idle end on with each request, but not with the banner’s reads or the unread-count poll', async () => {
    const endsAt = async () =>
      Date.parse(
        SandboxDocument.parse((await t.get('/sandbox')).body).data.meta.endsAt,
      );
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    await t.get('/modules');
    const before = await endsAt();
    await pause();
    await t.get('/me/notifications/unread-count');
    await t.get('/health');
    expect(await endsAt()).toBe(before);
    await pause();
    await t.get('/modules');
    expect(await endsAt()).toBeGreaterThan(before);
  });

  it('takes the adapter of each port that reaches the network that never connects', () => {
    expect(t.app.get(Sandbox).on).toBe(true);
    expect(t.app.get(Mailer)).toBeInstanceOf(NoMailer);
    expect(t.app.get(WebhookSender)).toBeInstanceOf(SandboxWebhookSender);
    expect(t.app.get(Embedder)).toBeInstanceOf(NoEmbedder);
    expect(t.app.get(StyleReviewer)).toBeInstanceOf(NoStyleReviewer);
    expect(t.app.get(AuditSink)).toBeInstanceOf(NoAuditSink);
    expect(t.app.get(IdentityProviders).list()).toEqual([]);
    // The instance's own disk, every byte put spent against the write budget.
    const blobs = t.app.get(BlobStore);
    expect(blobs).toBeInstanceOf(SandboxBlobStore);
    expect((blobs as unknown as { store: unknown }).store).toBeInstanceOf(
      FsBlobStore,
    );
    // Stable addresses and their QR codes open only for who is in the instance.
    expect(t.app.get(StableAddressSettings).maxAccess).toBe('signed-in');
  });

  it('refuses whatever would reach other people or leave the instance: 403 sandbox-not-allowed', async () => {
    const cs = await changeSet();
    const refused: [
      string,
      () => Promise<{ status: number; body: unknown }>,
      string,
    ][] = [
      [
        'POST /users',
        () =>
          t.post('/users').send(
            json({
              data: {
                type: 'User',
                id: 'stranger',
                attributes: { name: 'Stranger', email: 'stranger@example.org' },
              },
            }),
          ),
        'users',
      ],
      [
        'POST /users/:userId/invite',
        () => t.post('/users/sample-author/invite'),
        'invitations',
      ],
      [
        'POST /users/:userId/password-reset',
        () => t.post('/users/sample-author/password-reset'),
        'invitations',
      ],
      [
        'POST /service-accounts',
        () =>
          t.post('/service-accounts').send(
            json({
              data: {
                type: 'ServiceAccount',
                id: 'robot',
                attributes: { name: 'Robot', description: null },
              },
            }),
          ),
        'service-accounts',
      ],
      [
        'POST /service-accounts/:id/tokens',
        () =>
          t.post('/service-accounts/robot/tokens').send(
            json({
              data: { type: 'ServiceToken', attributes: { name: 'CI' } },
            }),
          ),
        'tokens',
      ],
      [
        'POST /change-sets/:id/assets',
        () => upload(`/change-sets/${cs}/assets`),
        'uploads',
      ],
      [
        'POST /change-sets/:id/assets?kind=attachment',
        () => upload(`/change-sets/${cs}/assets?kind=attachment`),
        'uploads',
      ],
      [
        'POST /change-sets/:id/assets?kind=font',
        () => upload(`/change-sets/${cs}/assets?kind=font`),
        'uploads',
      ],
      ['POST /branding/images', () => upload('/branding/images'), 'uploads'],
      ['POST /imports', () => upload('/imports'), 'imports'],
      [
        'POST /imports/:id/apply',
        () => t.post('/imports/00000000-0000-7000-8000-000000000000/apply'),
        'imports',
      ],
      [
        'POST /translations/imports',
        () => upload('/translations/imports'),
        'imports',
      ],
      [
        'POST /translations/imports/:id/apply',
        () =>
          t.post(
            '/translations/imports/00000000-0000-7000-8000-000000000000/apply',
          ),
        'imports',
      ],
      [
        'PUT …/page-design-templates/:id/files/working-copy',
        () =>
          t
            .put(
              `/change-sets/${cs}/page-design-templates/house/files/working-copy?path=manual.typ`,
            )
            .send(
              json({
                data: {
                  type: 'WorkingCopy',
                  attributes: {
                    content: {
                      schemaVersion: 1,
                      text: '#set page(width: 1cm)',
                    },
                  },
                },
                meta: { version: 0, baseCommit: t.commits.main },
              }),
            ),
        'templates',
      ],
      [
        'POST /webhooks',
        () =>
          t.post('/webhooks').send(
            json({
              data: {
                type: 'Webhook',
                attributes: {
                  url: 'https://hooks.example.com/x',
                  events: ['manual.released'],
                },
              },
            }),
          ),
        'webhooks',
      ],
      [
        'POST /mail/test',
        () => t.post('/mail/test').send(json({ data: { type: 'MailTest' } })),
        'mail',
      ],
      [
        'PATCH /backup-settings',
        () =>
          t.patch('/backup-settings').send(
            json({
              data: {
                type: 'BackupSettings',
                id: 'instance',
                attributes: { enabled: true },
              },
            }),
          ),
        'backups',
      ],
      [
        'POST /backup-keys',
        () => t.post('/backup-keys').send(json({})),
        'backups',
      ],
      [
        'POST /backup-requests',
        () =>
          t.post('/backup-requests').send(
            json({
              data: { type: 'BackupRequest', attributes: { kind: 'run' } },
            }),
          ),
        'backups',
      ],
    ];
    for (const [route, send, what] of refused) {
      const res = await send();
      expect([route, res.status]).toEqual([route, 403]);
      expect([route, error(res.body)]).toEqual([
        route,
        expect.objectContaining({
          code: 'sandbox-not-allowed',
          meta: { refused: what },
        }),
      ]);
    }
  });

  it('caps a module’s size and the modules it makes: 422 sandbox-limit-reached', async () => {
    const cs = await changeSet();
    const lockOn = async (subject: unknown) =>
      expect(
        (
          await t
            .post(`/change-sets/${cs}/locks`)
            .send(json({ data: { type: 'Lock', attributes: { subject } } }))
        ).status,
      ).toBe(201);
    const copy = (id: string) =>
      `/change-sets/${cs}/modules/en/${id}/working-copy`;
    await lockOn({ type: 'module', lang: 'en', moduleId: 'charging' });
    const committed = ModuleWorkingCopyDocument.parse(
      (await t.get(copy('charging'))).body,
    ).data.attributes.content;
    const save = (id: string, content: unknown) =>
      t.put(copy(id)).send(
        json({
          data: { type: 'WorkingCopy', attributes: { content } },
          meta: { version: 0, baseCommit: t.commits.main },
        }),
      );
    const big = await save('charging', {
      ...committed,
      blocks: [
        {
          type: 'paragraph',
          id: 'long',
          content: [{ type: 'text', text: 'x'.repeat(9_000) }],
        },
      ],
    });
    expect(big.status).toBe(422);
    expect(error(big.body)).toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'moduleBytes', max: 8000 },
    });
    // A new module: the one the cap allows, then no more.
    const fresh = (id: string) => ({
      ...committed,
      id,
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: 'New.' }],
        },
      ],
    });
    await lockOn({ type: 'module', lang: 'en', moduleId: 'sandbox-one' });
    await lockOn({ type: 'module', lang: 'en', moduleId: 'sandbox-two' });
    expect((await save('sandbox-one', fresh('sandbox-one'))).status).toBe(200);
    const second = await save('sandbox-two', fresh('sandbox-two'));
    expect(second.status).toBe(422);
    expect(error(second.body)).toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'modules', max: 1 },
    });
  });

  it('caps a comment’s length', async () => {
    const cs = await changeSet();
    const res = await t.post(`/change-sets/${cs}/comments`).send(
      json({
        data: {
          type: 'Comment',
          attributes: {
            body: 'This comment is far too long for the sandbox.',
            subject: { type: 'module', lang: 'en', moduleId: 'charging' },
            blockId: 'x',
          },
        },
      }),
    );
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'commentLength', max: 20 },
    });
  });

  it('caps the revisions it makes', async () => {
    while (changeSetCount < 3) await changeSet();
    const res = await t.post('/change-sets').send(
      json({
        data: { type: 'ChangeSet', attributes: { title: 'One more' } },
      }),
    );
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'changeSets', max: 3 },
    });
    const status = SandboxDocument.parse((await t.get('/sandbox')).body);
    expect(status.data.meta.used).toMatchObject({ changeSets: 3, modules: 1 });
  });

  it('caps the releases it cuts in an hour', async () => {
    const cut = (revision: string) =>
      t.post('/releases').send(
        json({
          data: {
            type: 'Release',
            attributes: { product: 'north', revision, notes: 'Sandbox.' },
          },
        }),
      );
    expect((await cut('1.0')).status).toBe(201);
    const second = await cut('1.1');
    expect(second.status).toBe(422);
    expect(error(second.body)).toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'releasesPerHour', max: 1 },
    });
  });

  it('made no connection and no lookup beyond this machine, jobs included', async () => {
    await t.runJobs();
    expect(outbound).toEqual([]);
    // The watch itself sees an outbound attempt (TEST-NET-1, never routed): it is no empty check.
    const socket = net.connect({ host: '192.0.2.1', port: 9 });
    socket.on('error', () => undefined);
    socket.destroy();
    const aborted = new AbortController();
    aborted.abort();
    await fetch('http://192.0.2.1/', { signal: aborted.signal }).catch(
      () => undefined,
    );
    expect(outbound).toEqual(['connect 192.0.2.1', 'fetch 192.0.2.1']);
  });
});
