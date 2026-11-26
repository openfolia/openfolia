import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { SecretKeyDocument } from '../src/secrets/api/secret-key.resources.js';
import { rotateSecretKey } from '../src/secrets/rotate-secret-key.js';
import { WebhookWithSecretDocument } from '../src/webhooks/api/webhook.resources.js';
import { webhookSecretContext } from '../src/webhooks/repos/sealed-webhook-secrets.js';
import { webhooks } from '../src/webhooks/repos/webhooks.tables.js';
import { AesSecretSealer } from '../src/base/repos/aes-secret-sealer.js';
import { createTestDatabase, PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The key set by the operator under its old name (#42's CCMS_WEBHOOKS_SECRET_KEY),
// with a key file path set too: the variable wins and no file is written (#470).
const keyDir = mkdtempSync(join(tmpdir(), 'openfolia-secret-key-env-'));
const keyFile = join(keyDir, 'ccms-secret.key');
const OLD_KEY = Buffer.alloc(32, 0x11);

class SharedDatabase extends PgliteDatabase {
  override async close(): Promise<void> {
    // The test closes the real one.
  }
}

const manager: Actor = {
  ...actorWith(['webhook.manage', 'content.read', 'admin.roles']),
  id: 'env-key-manager',
};

let database: PgliteDatabase;
let t: TestApp | undefined;
const warnings: string[] = [];

beforeAll(async () => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
    warnings.push(String(message));
  });
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
  t = await createTestApp(
    {
      CCMS_SECRET_KEY: '',
      CCMS_WEBHOOKS_SECRET_KEY: OLD_KEY.toString('base64'),
      CCMS_SECRET_KEY_FILE: keyFile,
    },
    { database: new SharedDatabase(database.client) },
  );
});
afterAll(async () => {
  await t?.close();
  await database?.close();
  rmSync(keyDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('a secret key set by the operator', () => {
  it('wins over the key file: none is written, and the old name still works, with a warning', async () => {
    expect(existsSync(keyFile)).toBe(false);
    expect(readdirSync(keyDir)).toEqual([]);
    expect(warnings).toContainEqual(
      expect.stringMatching(/CCMS_WEBHOOKS_SECRET_KEY, its old name/),
    );
    t!.actAs(manager);
    const shown = await t!.get('/secret-key');
    expect(SecretKeyDocument.parse(shown.body).data.attributes).toEqual({
      origin: 'environment',
      file: null,
      variable: 'CCMS_WEBHOOKS_SECRET_KEY',
      generate: true,
    });
  });

  it('seals as before #470: a secret sealed under the old name opens with the same key', async () => {
    t!.actAs(manager);
    const created = await t!.post('/webhooks').send(
      JSON.stringify({
        data: {
          type: 'Webhook',
          attributes: {
            url: 'https://receiver.example/hook',
            events: ['release.withdrawn'],
          },
        },
      }),
    );
    expect(created.status).toBe(201);
    const doc = WebhookWithSecretDocument.parse(created.body);
    const [row] = await database.db.select().from(webhooks);
    expect(row?.secretSealed).not.toContain(doc.meta.secret);
    expect(
      new AesSecretSealer(OLD_KEY).open(
        row!.secretSealed,
        webhookSecretContext(doc.data.id),
      ),
    ).toBe(doc.meta.secret);
    expect(existsSync(keyFile)).toBe(false);
  });

  it('rotates only to a new key the operator gives, and writes no file', async () => {
    await t?.close();
    t = undefined;
    const settings = {
      CCMS_CONTENT_DIR: '/unused',
      CCMS_WEBHOOKS_SECRET_KEY: OLD_KEY,
      CCMS_SECRET_KEY_FILE: keyFile,
      CCMS_SECRET_KEY_GENERATE: true,
    };
    await expect(rotateSecretKey(settings, database)).rejects.toThrow(
      /set CCMS_SECRET_KEY_NEW to the new key/,
    );
    const next = Buffer.alloc(32, 0x22);
    const rotated = await rotateSecretKey(
      { ...settings, CCMS_SECRET_KEY_NEW: next },
      database,
    );
    expect(rotated.resealed).toEqual([
      { name: 'webhook signing secrets', count: 1, unreadable: 0 },
      { name: 'webhook header secrets', count: 0, unreadable: 0 },
      { name: 'backup S3 secret', count: 0, unreadable: 0 },
      { name: 'backup key identity', count: 0, unreadable: 0 },
      { name: 'queued email params', count: 0, unreadable: 0 },
      { name: 'two-factor secrets', count: 0, unreadable: 0 },
    ]);
    const [row] = await database.db.select().from(webhooks);
    expect(() =>
      new AesSecretSealer(next).open(
        row!.secretSealed,
        webhookSecretContext(row!.id),
      ),
    ).not.toThrow();
    expect(readdirSync(keyDir)).toEqual([]);
  });
});
