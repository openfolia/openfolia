import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import {
  FakeMailBrandSource,
  FakeMailer,
  FakeMailSettings,
  FakeMailStore,
} from '../../../../tests/fakes/fake-mail.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import {
  ForbiddenError,
  NotConfiguredError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { MAIL_ACTOR } from '../mail.js';
import { SEND_MAIL } from '../mail-job.js';
import { MailOutbox } from '../mail-outbox.js';
import { MailSendError } from '../mail-ports.js';
import { DEFAULT_PRODUCT_NAME } from '../../../branding/core/branding.js';
import {
  GetMailSettingsAction,
  SendTestMailAction,
} from './mail-settings.actions.js';
import {
  FailMailAction,
  MailAttemptFailed,
  SendMailAction,
  STALE_AFTER_MS,
} from './send-mail.action.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

const ADMIN = actorWith(['admin.roles']);

function setUp(sandbox: Sandbox = Sandbox.OFF) {
  const settings = new FakeMailSettings();
  const store = new FakeMailStore();
  const sealer = fakeSealer(1);
  const jobs = new FakeJobQueue();
  const unit = new FakeUnitOfWork();
  const audit = new FakeAuditLog();
  const brand = new FakeMailBrandSource();
  const mailer = new FakeMailer();
  const users = new FakeUserDirectory([ADMIN], { [ADMIN.id]: 'Ada Admin' });
  users.emails.set(ADMIN.id, 'ada@example.com');
  const outbox = new MailOutbox(settings, store, sealer, jobs, sandbox);
  const fail = new FailMailAction(store, audit, unit);
  const send = new SendMailAction(
    store,
    settings,
    sealer,
    brand,
    mailer,
    fail,
    unit,
  );
  const sendTest = new SendTestMailAction(settings, outbox, users, audit, unit);
  const getSettings = new GetMailSettingsAction(settings, brand);
  const queue = (language?: string | null, address = 'reader@example.com') =>
    unit.run((tx) =>
      outbox.queue(tx, {
        to: { address, name: 'Rea Reader' },
        template: 'test',
        params: {},
        language,
      }),
    );
  return {
    settings,
    store,
    sealer,
    jobs,
    unit,
    audit,
    brand,
    mailer,
    users,
    outbox,
    send,
    fail,
    sendTest,
    getSettings,
    queue,
  };
}

describe('MailOutbox', () => {
  it('writes the email and its job with the transaction that caused it', async () => {
    const t = setUp();
    const queued = await t.queue('de');
    expect(queued).toEqual({ id: expect.any(String), language: 'de' });
    const row = t.store.rows.get(queued!.id)!;
    expect(row).toMatchObject({
      toAddress: 'reader@example.com',
      toName: 'Rea Reader',
      template: 'test',
      language: 'de',
    });
    // Sealed, for this email only.
    expect(row.paramsSealed).toBe(`sealed:1:mail-params:v1:${queued!.id}:{}`);
    expect(t.jobs.jobs).toEqual([
      expect.objectContaining({
        queue: SEND_MAIL.name,
        key: queued!.id,
        payload: { messageId: queued!.id },
      }),
    ]);
  });

  it('writes nothing when the transaction rolls back', async () => {
    const t = setUp();
    await expect(
      t.unit.run(async (tx) => {
        await t.outbox.queue(tx, {
          to: { address: 'reader@example.com' },
          template: 'test',
          params: {},
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(t.store.rows.size).toBe(0);
    expect(t.jobs.jobs).toEqual([]);
  });

  it.each(['off', 'no-secret-key'] as const)(
    'queues nothing while email is %s',
    async (state) => {
      const t = setUp();
      t.settings.state = state;
      expect(t.outbox.enabled).toBe(false);
      expect(await t.queue()).toBeNull();
      expect(t.store.rows.size).toBe(0);
      expect(t.jobs.jobs).toEqual([]);
    },
  );

  it.each([
    'reader@example.com\r\nBcc: other@example.com',
    'Rea <reader@example.com>',
    'reader@example.com, other@example.com',
    'no-at-sign',
  ])('refuses %j as an address', async (address) => {
    const t = setUp();
    await expect(t.queue(null, address)).rejects.toThrow(
      'Not an email address',
    );
  });

  it('falls back to the installation’s language for one it has no email in', async () => {
    const t = setUp();
    t.settings.language = 'de';
    expect((await t.queue('fr'))!.language).toBe('de');
    expect((await t.queue('en-GB'))!.language).toBe('en');
    expect((await t.queue(null))!.language).toBe('de');
  });
});

describe('SendMailAction', () => {
  it('sends the email in its language and removes it', async () => {
    const t = setUp();
    const { id } = (await t.queue('de'))!;
    expect(await t.send.handle({ messageId: id })).toBe('sent');
    expect(t.mailer.sent).toHaveLength(1);
    const [mail] = t.mailer.sent;
    expect(mail!.subject).toBe('Test-E-Mail von Docs');
    expect(mail!.language).toBe('de');
    expect(mail!.html).toContain('<html lang="de">');
    expect(mail!.text).toContain('E-Mail funktioniert');
    expect(mail!.text).toContain(
      'Gesendet von Docs · https://docs.example.com/',
    );
    expect(mail!.to).toEqual({
      address: 'reader@example.com',
      name: 'Rea Reader',
    });
    // Nothing of it is kept.
    expect(t.store.rows.size).toBe(0);
    // Sent once: a second run finds it gone.
    expect(await t.send.handle({ messageId: id })).toBe('gone');
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('writes English with the link to the public URL', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    await t.send.handle({ messageId: id });
    const [mail] = t.mailer.sent;
    expect(mail!.subject).toBe('Test email from Docs');
    expect(mail!.html).toContain('href="https://docs.example.com/"');
    expect(mail!.text).toContain('Open Docs:\nhttps://docs.example.com/');
    expect(mail!.text).toContain(
      'You get this email because you sent a test email from Admin › System.',
    );
  });

  it('has no link and no URL in the footer without a public URL', async () => {
    const t = setUp();
    t.settings.publicUrl = null;
    const { id } = (await t.queue('en'))!;
    await t.send.handle({ messageId: id });
    const [mail] = t.mailer.sent;
    expect(mail!.html).not.toContain('href=');
    expect(mail!.text).toMatch(/Sent by Docs\n$/);
  });

  it('takes the branding: sender name, colour and the logo inline', async () => {
    const t = setUp();
    const png = Buffer.from('png bytes');
    t.brand.brand = {
      productName: 'Manuals',
      primary: '#0b5394',
      logo: { png, width: 120, height: 40 },
    };
    const { id } = (await t.queue('en'))!;
    await t.send.handle({ messageId: id });
    const [mail] = t.mailer.sent;
    expect(mail!.from).toEqual({
      name: 'Manuals',
      address: 'docs@example.com',
    });
    expect(mail!.subject).toBe('Test email from Manuals');
    expect(mail!.html).toContain('background:#0b5394');
    expect(mail!.html).toContain('color:#ffffff');
    expect(mail!.html).toContain(
      '<img src="cid:logo" width="120" height="40" alt="Manuals"',
    );
    expect(mail!.images).toEqual([
      {
        cid: 'logo',
        filename: 'logo.png',
        contentType: 'image/png',
        content: png,
      },
    ]);
    // No remote image, ever.
    expect(mail!.html).not.toMatch(/<img[^>]+src="(?!cid:)/);
  });

  it('uses dark text on a light primary, and the theme’s on one neither reads on', async () => {
    const t = setUp();
    t.brand.brand = { ...t.brand.brand, primary: '#ffd966' };
    await t.send.handle({ messageId: (await t.queue('en'))!.id });
    expect(t.mailer.sent[0]!.html).toContain('background:#ffd966');
    expect(t.mailer.sent[0]!.html).toContain('color:#1f2a2c');

    t.brand.brand = { ...t.brand.brand, primary: '#808080' };
    await t.send.handle({ messageId: (await t.queue('en'))!.id });
    expect(t.mailer.sent[1]!.html).not.toContain('background:#808080');
  });

  it('shows the default product name when the branding sets none', async () => {
    const t = setUp();
    t.brand.brand = {
      productName: DEFAULT_PRODUCT_NAME,
      primary: null,
      logo: null,
    };
    await t.send.handle({ messageId: (await t.queue('en'))!.id });
    expect(t.mailer.sent[0]!.from.name).toBe(DEFAULT_PRODUCT_NAME);
  });

  it('escapes the product name in the HTML and keeps it to one header line', async () => {
    const t = setUp();
    t.brand.brand = {
      productName: '<b>Docs</b>\r\nBcc: evil@example.com',
      primary: null,
      logo: null,
    };
    await t.send.handle({ messageId: (await t.queue('en'))!.id });
    const [mail] = t.mailer.sent;
    expect(mail!.html).not.toContain('<b>');
    expect(mail!.html).toContain('&lt;b&gt;Docs&lt;/b&gt;');
    expect(mail!.subject).not.toMatch(/[\r\n]/);
    expect(mail!.from.name).not.toMatch(/[\r\n]/);
    expect(mail!.from.name).toBe('<b>Docs</b> Bcc: evil@example.com');
  });

  it('retries a failed attempt, then sends it', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    t.mailer.failWith.push(new MailSendError('unavailable', 'ECONNREFUSED'));
    await expect(t.send.handle({ messageId: id })).rejects.toBeInstanceOf(
      MailAttemptFailed,
    );
    expect(t.store.rows.get(id)).toMatchObject({
      attempts: 1,
      lastError: 'unavailable',
    });
    expect(t.audit.events).toEqual([]);
    expect(await t.send.handle({ messageId: id })).toBe('sent');
    expect(t.store.rows.size).toBe(0);
  });

  it('never puts an address or reply in the attempt’s error', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    t.mailer.failWith.push(new MailSendError('tls', 'ETLS'));
    const error = await t.send.handle({ messageId: id }).catch((e) => e);
    expect(String(error.message)).not.toContain('reader@example.com');
    expect(error.message).toContain('tls');
  });

  it('records a failure for good once the job gave up, without the address', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    t.mailer.failWith.push(new MailSendError('auth', 'EAUTH'));
    await expect(t.send.handle({ messageId: id })).rejects.toThrow();
    // The job's last attempt failed: `failed()`.
    await t.fail.handle({ messageId: id });
    expect(t.store.rows.size).toBe(0);
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        actor: { kind: MAIL_ACTOR.kind, id: MAIL_ACTOR.id },
        action: 'mail.failed',
        subject: { type: 'mail', id },
        data: { template: 'test', reason: 'auth', attempts: 1 },
      }),
    ]);
    expect(JSON.stringify(t.audit.events)).not.toContain('example.com');
    // Once only.
    await t.fail.handle({ messageId: id });
    expect(t.audit.events).toHaveLength(1);
  });

  it('fails at once when the server refuses it for good', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    t.mailer.failWith.push(new MailSendError('rejected', 'EENVELOPE 550'));
    expect(await t.send.handle({ messageId: id })).toBe('failed');
    expect(t.store.rows.size).toBe(0);
    expect(t.audit.events[0]).toMatchObject({
      action: 'mail.failed',
      data: { reason: 'rejected', attempts: 1 },
    });
  });

  it('fails at once when the params do not open (another key)', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    const row = t.store.rows.get(id)!;
    const other = fakeSealer(2);
    t.store.rows.set(id, {
      ...row,
      paramsSealed: other.seal('{}', `mail-params:v1:${id}`),
    });
    expect(await t.send.handle({ messageId: id })).toBe('failed');
    expect(t.mailer.sent).toEqual([]);
    expect(t.audit.events[0]).toMatchObject({
      data: { reason: 'unreadable' },
    });
  });

  it('params sealed for one email do not open for another', async () => {
    const t = setUp();
    const a = (await t.queue('en'))!;
    const b = (await t.queue('en'))!;
    const rowB = t.store.rows.get(b.id)!;
    t.store.rows.set(b.id, {
      ...rowB,
      paramsSealed: t.store.rows.get(a.id)!.paramsSealed,
    });
    expect(await t.send.handle({ messageId: b.id })).toBe('failed');
  });

  it('fails when email was turned off after it was queued', async () => {
    const t = setUp();
    const { id } = (await t.queue('en'))!;
    t.settings.state = 'no-secret-key';
    expect(await t.send.handle({ messageId: id })).toBe('failed');
    expect(t.audit.events[0]).toMatchObject({ data: { reason: 'off' } });
  });

  it('removes emails left queued past two days after a send', async () => {
    const t = setUp();
    const old = (await t.queue('en'))!;
    const row = t.store.rows.get(old.id)!;
    t.store.rows.set(old.id, {
      ...row,
      createdAt: new Date(Date.now() - STALE_AFTER_MS - 1000),
    });
    await t.send.handle({ messageId: (await t.queue('en'))!.id });
    expect(t.store.rows.size).toBe(0);
  });
});

describe('SendTestMailAction', () => {
  it('queues the test email to the admin, recorded as mail.test', async () => {
    const t = setUp();
    const queued = await t.sendTest.handle({ actor: ADMIN, language: 'de' });
    expect(queued).toEqual({
      id: expect.any(String),
      to: 'ada@example.com',
      language: 'de',
    });
    expect(t.store.rows.get(queued.id)).toMatchObject({
      toAddress: 'ada@example.com',
      toName: 'Ada Admin',
    });
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        action: 'mail.test',
        subject: { type: 'mail', id: queued.id },
        data: { template: 'test' },
      }),
    ]);
  });

  it.each(['off', 'no-secret-key'] as const)(
    'is not-configured while email is %s, naming why',
    async (state) => {
      const t = setUp();
      t.settings.state = state;
      const error = await t.sendTest
        .handle({ actor: ADMIN })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotConfiguredError);
      expect((error as NotConfiguredError).meta).toEqual({ reason: state });
      expect(t.audit.events).toEqual([]);
    },
  );

  it('refuses an admin without an email address', async () => {
    const t = setUp();
    t.users.emails.clear();
    await expect(t.sendTest.handle({ actor: ADMIN })).rejects.toMatchObject({
      constructor: UnprocessableError,
      code: 'no-email-address',
    });
    expect(t.store.rows.size).toBe(0);
  });

  it('needs admin.roles', async () => {
    const t = setUp();
    await expect(t.sendTest.handle({ actor: NOBODY })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      t.getSettings.handle({ actor: NOBODY }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('GetMailSettingsAction', () => {
  it('reports the server, never a password, and the sender’s name', async () => {
    const t = setUp();
    expect(await t.getSettings.handle({ actor: ADMIN })).toEqual({
      state: 'on',
      server: {
        host: 'mail.example.com',
        port: 587,
        tls: 'starttls',
        authenticated: true,
      },
      from: 'docs@example.com',
      senderName: 'Docs',
      language: 'en',
    });
  });
});

describe('MailOutbox in a public sandbox (#826)', () => {
  it('drops every email, even with email set up: no row, no job, nothing sent', async () => {
    const t = setUp(
      Sandbox.on({
        limits: {
          moduleBytes: 1_000,
          commentLength: 100,
          changeSets: 5,
          modules: 5,
          manuals: 5,
          releasesPerHour: 5,
          renderJobs: 1,
          writeBytes: 1_000_000,
        },
        lifetime: { idleMinutes: 30, maxMinutes: 90 },
      }),
    );
    expect(t.settings.state).toBe('on');
    expect(t.outbox.enabled).toBe(false);
    expect(t.outbox.linksEnabled).toBe(false);
    expect(await t.queue('en')).toBeNull();
    expect(t.jobs.jobs).toEqual([]);
    expect(t.store.rows.size).toBe(0);
    expect(t.mailer.sent).toEqual([]);
  });
});
