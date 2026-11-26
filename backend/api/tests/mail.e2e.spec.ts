import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { BrandingImageDocument } from '../src/branding/api/branding.resources.js';
import {
  MailMessageDocument,
  MailSettingsDocument,
} from '../src/mail/api/mail.resources.js';
import { mailMessages } from '../src/mail/repos/mail.tables.js';
import { createTestDatabase, type PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { parts, startMailServer, type TestMailServer } from './mail-server.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const admin: Actor = {
  ...actorWith(['admin.roles', 'admin.branding']),
  id: 'mail-admin',
};
const noAddress: Actor = {
  ...actorWith(['admin.roles']),
  id: 'mail-no-address',
};

let server: TestMailServer;
let t: TestApp;
let database: PgliteDatabase;

const testMail = (language?: string) =>
  JSON.stringify({
    data: {
      type: 'MailTest',
      ...(language !== undefined && { attributes: { language } }),
    },
  });

/** Runs the queued jobs (a failed attempt is retried later, not now) until none is due. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) if ((await t.runJobs()) === 0) return;
}

beforeAll(async () => {
  server = await startMailServer({
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
          name: 'Mail Admin',
          email: 'admin@example.com',
          roles: admin.roles.map((r) => r.id),
        },
        {
          id: noAddress.id,
          name: 'No Address',
          roles: noAddress.roles.map((r) => r.id),
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
      CCMS_MAIL_LANGUAGE: 'de',
      CCMS_PUBLIC_URL: 'https://docs.example.com/',
    },
    { database },
  );
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});
afterEach(() => t?.actAs(undefined));

describe('email through an SMTP server with STARTTLS', () => {
  it('shows the settings to administrators, never the user or the password', async () => {
    t.actAs(admin);
    const res = await t.get('/mail');
    expect(res.status).toBe(200);
    expect(MailSettingsDocument.parse(res.body).data.attributes).toEqual({
      state: 'on',
      host: 'localhost',
      port: server.port,
      tls: 'starttls',
      authenticated: true,
      from: 'docs@example.com',
      senderName: 'OpenFolia',
      language: 'de',
    });
    expect(MailSettingsDocument.parse(res.body).data.meta.failures).toEqual({
      count: 0,
      last: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('mail-password-1');
    expect(JSON.stringify(res.body)).not.toContain('mailer');
  });

  it('sends the branded test email, HTML and text, over TLS, and keeps nothing of it', async () => {
    // The branding: a name, a colour and a logo (WebP, sent as PNG).
    t.actAs(admin);
    const logo = await sharp({
      create: { width: 480, height: 96, channels: 4, background: '#0b5394' },
    })
      .webp()
      .toBuffer();
    const uploaded = await t
      .post('/branding/images')
      .set('Content-Type', 'multipart/form-data')
      .set(REQUEST_HEADER, '1')
      .attach('file', logo, 'logo.webp');
    expect([200, 201]).toContain(uploaded.status);
    const reference = BrandingImageDocument.parse(uploaded.body).data.attributes
      .reference;
    const patched = await t.patch('/branding').send(
      JSON.stringify({
        data: {
          type: 'Branding',
          id: 'branding',
          attributes: {
            productName: 'Example <Docs>',
            primary: '#0b5394',
            logoLight: reference,
          },
        },
      }),
    );
    expect(patched.status).toBe(200);

    const res = await t.post('/mail/test').send(testMail('en'));
    expect(res.status).toBe(202);
    const queued = MailMessageDocument.parse(res.body).data;
    expect(queued.attributes).toEqual({
      template: 'test',
      to: 'admin@example.com',
      language: 'en',
      status: 'queued',
    });
    expect(server.received).toHaveLength(0);

    await drain();
    expect(server.received).toHaveLength(1);
    const [mail] = server.received;
    expect(mail!.secure).toBe(true);
    expect(mail!.user).toBe('mailer');
    expect(mail!.from).toBe('docs@example.com');
    expect(mail!.to).toEqual(['admin@example.com']);
    expect(mail!.raw).toMatch(/^From: "Example <Docs>" <docs@example\.com>$/m);
    expect(mail!.raw).toMatch(/^To: Mail Admin <admin@example\.com>$/m);
    expect(mail!.raw).toMatch(/^Subject: Test email from Example <Docs>$/m);
    expect(mail!.raw).toMatch(/^Content-Language: en$/m);
    expect(mail!.raw).toMatch(/^Auto-Submitted: auto-generated$/m);

    const all = parts(mail!.raw);
    const text = all.find((p) => /Content-Type: text\/plain/i.test(p.headers));
    const html = all.find((p) => /Content-Type: text\/html/i.test(p.headers));
    const image = all.find((p) => /Content-Type: image\/png/i.test(p.headers));
    expect(text?.body).toContain('Email works');
    expect(text?.body).toContain(
      'Open Example <Docs>:\nhttps://docs.example.com/',
    );
    expect(html?.body).toContain('Example &lt;Docs&gt;');
    expect(html?.body).not.toContain('<Docs>');
    expect(html?.body).toContain('src="cid:logo"');
    expect(html?.body).toContain('background:#0b5394');
    expect(html?.body).not.toMatch(/<img[^>]+src="(?!cid:)/);
    expect(image?.headers).toMatch(/Content-ID: <logo>/i);
    expect(image?.headers).toMatch(/Content-Disposition: inline/i);

    // Removed once sent: nothing of the email is kept.
    expect(await database.db.select().from(mailMessages)).toEqual([]);

    // Recorded as mail.test, with the message's ID only.
    const audit = await t.get('/audit-events?filter[action]=mail.test');
    expect(audit.status).toBe(200);
    const events = AuditEventPageDocument.parse(audit.body).data;
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes).toMatchObject({
      action: 'mail.test',
      subject: { type: 'mail', id: queued.id },
    });
    expect(JSON.stringify(events)).not.toContain('admin@example.com');
  });

  it('writes in the installation’s language when none is asked for', async () => {
    t.actAs(admin);
    server.received.length = 0;
    const res = await t.post('/mail/test').send(testMail());
    expect(res.status).toBe(202);
    expect(MailMessageDocument.parse(res.body).data.attributes.language).toBe(
      'de',
    );
    await drain();
    expect(server.received[0]!.raw).toMatch(/^Subject: Test-E-Mail von /m);
    expect(server.received[0]!.raw).toMatch(/^Content-Language: de$/m);
  });

  it('refuses an administrator without an address, and others altogether', async () => {
    t.actAs(noAddress);
    const res = await t.post('/mail/test').send(testMail());
    expect(res.status).toBe(422);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'no-email-address',
    );

    t.actAs({ ...actorWith(['content.read']), id: 'mail-reader' });
    expect((await t.get('/mail')).status).toBe(403);
    expect((await t.post('/mail/test').send(testMail())).status).toBe(403);
  });

  it('takes only a language it writes in', async () => {
    t.actAs(admin);
    const res = await t.post('/mail/test').send(testMail('fr'));
    expect(res.status).toBe(400);
  });
});
