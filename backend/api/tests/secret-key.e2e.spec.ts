import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { StartupError } from '../src/config/startup-error.js';
import { SecretKeyDocument } from '../src/secrets/api/secret-key.resources.js';
import { rotateSecretKey } from '../src/secrets/rotate-secret-key.js';
import {
  WebhookDeliveryDocument,
  WebhookWithSecretDocument,
} from '../src/webhooks/api/webhook.resources.js';
import { verifyWebhookSignature } from '../src/webhooks/core/webhook-signature.js';
import { webhooks } from '../src/webhooks/repos/webhooks.tables.js';
import { createTestDatabase, PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The instance secret key from the key file (#470): no CCMS_SECRET_KEY, so
// the first start makes the file. The settings are read once per test file
// (`createTestApp`), so every app here has these.
const keyDir = mkdtempSync(join(tmpdir(), 'openfolia-secret-key-'));
const keyFile = join(keyDir, 'data', 'ccms-secret.key');
const env = {
  CCMS_SECRET_KEY: '',
  CCMS_SECRET_KEY_FILE: keyFile,
  CCMS_WEBHOOKS_ALLOW_HTTP: 'true',
  CCMS_WEBHOOKS_ALLOW_PRIVATE: 'true',
  CCMS_WEBHOOKS_TIMEOUT_MS: '2000',
};

/** The same PGlite for several apps in turn: closing one app leaves it open. */
class SharedDatabase extends PgliteDatabase {
  override async close(): Promise<void> {
    // The test closes the real one.
  }
}

const manager: Actor = {
  ...actorWith(['webhook.manage', 'content.read', 'admin.roles']),
  id: 'key-manager',
};

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let receiver: Server;
let base: string;
const received: Received[] = [];
let database: PgliteDatabase;
let t: TestApp | undefined;

const start = () =>
  createTestApp(env, { database: new SharedDatabase(database.client) });
const stop = async () => {
  await t?.close();
  t = undefined;
};
const keyText = () => readFileSync(keyFile, 'utf8');

/** The secret custom header (#457) the subscriber sends: it must arrive, rotation or not. */
const TOKEN = 'Bearer key-rotation-token-7f3a';

/** A signed test event to the subscriber `id`, which must arrive signed with `secret` and with its secret header. */
async function ping(app: TestApp, id: string, secret: string): Promise<void> {
  received.length = 0;
  app.actAs(manager);
  const res = await app.post(`/webhooks/${id}/test`);
  expect(res.status).toBe(200);
  expect(WebhookDeliveryDocument.parse(res.body).data.attributes).toMatchObject(
    { status: 'succeeded' },
  );
  const [hit] = received;
  expect(hit?.headers['authorization']).toBe(TOKEN);
  expect(
    verifyWebhookSignature(
      String(hit?.headers['x-ccms-signature']),
      hit?.body ?? '',
      secret,
    ),
  ).toBe(true);
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  database = await createTestDatabase();
  await seedAccess(
    database,
    Seed.parse({
      roles: manager.roles,
      users: [
        {
          id: manager.id,
          name: manager.id,
          roles: manager.roles.map((r) => r.id),
        },
      ],
    }),
  );
});
afterAll(async () => {
  await stop();
  await database?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  rmSync(keyDir, { recursive: true, force: true });
});

describe('the instance secret key from the key file', () => {
  // In order: each step starts the API again on the same database and key file.
  let hookId = '';
  let secret = '';

  it('a fresh start makes the key file with mode 0600, and webhooks work', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    expect(existsSync(keyFile)).toBe(false);
    t = await start();
    expect(existsSync(keyFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    }
    const key = keyText().trim();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`Made a new secret key in ${keyFile}`),
    );

    t.actAs(manager);
    const created = await t.post('/webhooks').send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          attributes: {
            url: `${base}/hook`,
            events: ['release.withdrawn'],
            headers: [{ name: 'Authorization', value: TOKEN, secret: true }],
          },
        },
      }),
    );
    expect(created.status).toBe(201);
    const doc = WebhookWithSecretDocument.parse(created.body);
    hookId = doc.data.id;
    const [stored] = await database.db
      .select({ headers: webhooks.headers })
      .from(webhooks)
      .where(eq(webhooks.id, hookId));
    expect(JSON.stringify(stored)).not.toContain('key-rotation-token');
    secret = doc.meta.secret;
    await ping(t, hookId, secret);

    // Admin → System says where the key is, never the key.
    const shown = await t.get('/secret-key');
    expect(shown.status).toBe(200);
    expect(SecretKeyDocument.parse(shown.body).data.attributes).toEqual({
      origin: 'file',
      file: keyFile,
      variable: null,
      generate: true,
    });
    expect(JSON.stringify(shown.body)).not.toContain(key);
    // Nor any log line, nor the audit log.
    expect(JSON.stringify(log.mock.calls)).not.toContain(key);
    const audit = await t.get('/audit-events?page[size]=100');
    expect(
      AuditEventPageDocument.parse(audit.body).data.length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(audit.body)).not.toContain(key);
    log.mockRestore();
    await stop();
  });

  it('a restart reads the same key, and the stored secret still signs', async () => {
    const before = keyText();
    t = await start();
    expect(keyText()).toBe(before);
    await ping(t, hookId, secret);
    t.actAs(manager);
    expect(
      SecretKeyDocument.parse((await t.get('/secret-key')).body).data.attributes
        .origin,
    ).toBe('file');
    await stop();
  });

  it('refuses to start, and makes no new key, when the key file is lost while secrets are sealed', async () => {
    const saved = keyText();
    rmSync(keyFile);
    const failure = start();
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(
      /there is no key to open them[\s\S]*restore the key file from a backup/,
    );
    expect(existsSync(keyFile)).toBe(false);

    // Restored from the backup: it starts again.
    writeFileSync(keyFile, saved, { mode: 0o600 });
    t = await start();
    await ping(t, hookId, secret);
    await stop();
  });

  it('rotation re-seals every secret under a new key in the key file, and deliveries keep working', async () => {
    const before = keyText();
    // A previous secret past its end, unreadable besides: cleared, not re-sealed.
    await database.db
      .update(webhooks)
      .set({
        previousSecretSealed: 'v1.garbage.garbage.garbage',
        previousSecretUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(webhooks.id, hookId));
    const rotated = await rotateSecretKey(
      {
        CCMS_CONTENT_DIR: '/unused',
        CCMS_SECRET_KEY_FILE: keyFile,
        CCMS_SECRET_KEY_GENERATE: true,
      },
      database,
    );
    expect(rotated.origin).toMatchObject({ kind: 'file', path: keyFile });
    expect(rotated.resealed).toEqual([
      { name: 'webhook signing secrets', count: 1, unreadable: 0 },
      { name: 'webhook header secrets', count: 1, unreadable: 0 },
      { name: 'backup S3 secret', count: 0, unreadable: 0 },
      { name: 'backup key identity', count: 0, unreadable: 0 },
      { name: 'queued email params', count: 0, unreadable: 0 },
    ]);
    const [row] = await database.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, hookId));
    expect(row).toMatchObject({
      previousSecretSealed: null,
      previousSecretUntil: null,
    });
    expect(keyText()).not.toBe(before);
    expect(existsSync(`${keyFile}.next`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    }

    t = await start();
    // The receiver's secret and the secret header are unchanged: only how
    // they are stored changed.
    await ping(t, hookId, secret);
    await stop();
  });

  it('refuses to start under the key from before a rotation', async () => {
    const current = keyText();
    await rotateSecretKey(
      {
        CCMS_CONTENT_DIR: '/unused',
        CCMS_SECRET_KEY_FILE: keyFile,
        CCMS_SECRET_KEY_GENERATE: true,
      },
      database,
    );
    writeFileSync(keyFile, current, { mode: 0o600 });
    await expect(start()).rejects.toThrow(
      /The key file .* does not open the secrets the database holds/,
    );
  });
});
