import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { MailSettingsDocument } from '../src/mail/api/mail.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const admin: Actor = { ...actorWith(['admin.roles']), id: 'off-admin' };

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

describe('without a mail server', () => {
  it('shows email off, and sends no test email', async () => {
    t.actAs(admin);
    const shown = await t.get('/mail');
    expect(shown.status).toBe(200);
    expect(MailSettingsDocument.parse(shown.body).data.attributes).toEqual({
      state: 'off',
      host: null,
      port: null,
      tls: null,
      authenticated: false,
      from: null,
      senderName: 'OpenFolia',
      language: 'en',
    });
    const res = await t
      .post('/mail/test')
      .send(JSON.stringify({ data: { type: 'MailTest' } }));
    expect(res.status).toBe(404);
    expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
      code: 'not-configured',
      meta: { reason: 'off' },
    });
  });
});
