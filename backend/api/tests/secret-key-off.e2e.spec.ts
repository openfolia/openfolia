import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { MailSettingsDocument } from '../src/mail/api/mail.resources.js';
import { SecretKeyDocument } from '../src/secrets/api/secret-key.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Generation turned off (a hosted setup) and no key set (#470): the server
// starts, webhooks are off (404 not-configured), and no key file is made.
const keyDir = mkdtempSync(join(tmpdir(), 'openfolia-secret-key-off-'));
const keyFile = join(keyDir, 'ccms-secret.key');

const manager: Actor = {
  ...actorWith(['webhook.manage', 'content.read', 'admin.roles']),
  id: 'off-manager',
};

let t: TestApp;
const warnings: string[] = [];

beforeAll(async () => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
    warnings.push(String(message));
  });
  t = await createTestApp({
    CCMS_SECRET_KEY: '',
    CCMS_SECRET_KEY_FILE: keyFile,
    CCMS_SECRET_KEY_GENERATE: 'false',
    // A mail server, which needs the key too (#609).
    CCMS_MAIL_URL: 'smtp://mail.example.com',
    CCMS_MAIL_FROM: 'docs@example.com',
  });
  await seedAccess(
    t.database,
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
  await t?.close();
  rmSync(keyDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('with key generation turned off and no key', () => {
  it('starts with webhooks off, says so, and writes no key file', async () => {
    expect(warnings).toContainEqual(
      expect.stringMatching(/There is no secret key[\s\S]*webhooks are off/),
    );
    expect(existsSync(keyFile)).toBe(false);
    expect(readdirSync(keyDir)).toEqual([]);

    t.actAs(manager);
    const res = await t.post('/webhooks').send(
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
    expect(res.status).toBe(404);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'not-configured',
    );

    const shown = await t.get('/secret-key');
    expect(SecretKeyDocument.parse(shown.body).data.attributes).toEqual({
      origin: 'none',
      file: null,
      variable: null,
      generate: false,
    });
  });

  it('keeps email off too, and says why', async () => {
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /CCMS_MAIL_URL is set, but email is off: it needs the instance secret key/,
      ),
    );
    t.actAs(manager);
    const shown = await t.get('/mail');
    expect(
      MailSettingsDocument.parse(shown.body).data.attributes,
    ).toMatchObject({ state: 'no-secret-key', host: 'mail.example.com' });
    const res = await t
      .post('/mail/test')
      .send(JSON.stringify({ data: { type: 'MailTest' } }));
    expect(res.status).toBe(404);
    expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
      code: 'not-configured',
      meta: { reason: 'no-secret-key' },
    });
  });

  it('shows where the key is to administrators only', async () => {
    t.actAs({ ...actorWith(['webhook.manage']), id: 'not-admin' });
    const res = await t.get('/secret-key');
    expect(res.status).toBe(403);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
  });
});
