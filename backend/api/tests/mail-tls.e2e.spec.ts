import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { MailMessageDocument } from '../src/mail/api/mail.resources.js';
import { SendMailJobHandler } from '../src/mail/api/send-mail.handler.js';
import { mailMessages } from '../src/mail/repos/mail.tables.js';
import { createTestDatabase, type PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { startMailServer, type TestMailServer } from './mail-server.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// A server that offers no STARTTLS (and would take a plain sign-in): with
// CCMS_MAIL_REQUIRE_TLS at its default, nothing is sent to it.
const admin: Actor = { ...actorWith(['admin.roles']), id: 'tls-admin' };

let server: TestMailServer;
let t: TestApp;
let database: PgliteDatabase;

beforeAll(async () => {
  server = await startMailServer({
    starttls: false,
    auth: { user: 'mailer', pass: 'mail-password-1' },
  });
  database = await createTestDatabase();
  await seedAccess(
    database,
    Seed.parse({
      roles: [...admin.roles],
      users: [
        {
          id: admin.id,
          name: 'TLS Admin',
          email: 'admin@example.com',
          roles: admin.roles.map((r) => r.id),
        },
      ],
    }),
  );
  t = await createTestApp(
    {
      CCMS_MAIL_URL: `smtp://localhost:${server.port}`,
      CCMS_MAIL_FROM: 'docs@example.com',
      CCMS_MAIL_USER: 'mailer',
      CCMS_MAIL_PASSWORD: 'mail-password-1',
      CCMS_MAIL_CA_FILE: server.caFile,
    },
    { database },
  );
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});

describe('STARTTLS required', () => {
  it('sends nothing to a server without STARTTLS, retries, then records the failure', async () => {
    t.actAs(admin);
    const res = await t
      .post('/mail/test')
      .send(JSON.stringify({ data: { type: 'MailTest' } }));
    expect(res.status).toBe(202);
    const { id } = MailMessageDocument.parse(res.body).data;

    await t.runJobs();
    // Not sent, not signed in to, no address given in plain text.
    expect(server.received).toEqual([]);
    expect(server.plainCommands).toEqual([]);
    const [row] = await database.db.select().from(mailMessages);
    expect(row).toMatchObject({ id, attempts: 1, lastError: 'tls' });

    // The job's last attempt failed: the email is removed and the failure recorded.
    await t.app.get(SendMailJobHandler).failed({ messageId: id });
    expect(await database.db.select().from(mailMessages)).toEqual([]);
    const audit = await t.get('/audit-events?filter[action]=mail.failed');
    const events = AuditEventPageDocument.parse(audit.body).data;
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes).toMatchObject({
      action: 'mail.failed',
      subject: { type: 'mail', id },
      data: { template: 'test', reason: 'tls', attempts: 1 },
    });
    expect(JSON.stringify(events)).not.toContain('admin@example.com');
  });
});
