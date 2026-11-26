import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { type Module } from '@openfolia/content-model';
import { and, DrizzleQueryError, eq, sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { roleAssignments } from '../src/access/repos/access.tables.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { UnavailableError } from '../src/base/core/errors.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { NotificationsConsumer } from '../src/notifications/api/notifications-consumer.js';
import { UnsubscribedDocument } from '../src/notifications/api/unsubscribe.controller.js';
import { NotificationPageDocument } from '../src/notifications/api/notification.resources.js';
import { DeliverNotificationsAction } from '../src/notifications/core/actions/deliver-notifications.action.js';
import { PruneNotificationsAction } from '../src/notifications/core/actions/prune-notifications.action.js';
import {
  COALESCE_MS,
  LEASE_MS,
  SendNotificationEmailsAction,
} from '../src/notifications/core/actions/send-notification-emails.action.js';
import { FanOut } from '../src/notifications/core/fan-out.js';
import { NotificationEmailQueue } from '../src/notifications/core/notification-email-queue.js';
import { UnsubscribeTokens } from '../src/notifications/core/unsubscribe-tokens.js';
import {
  notificationEmailSends,
  notificationEmails,
} from '../src/notifications/repos/notification-emails.tables.js';
import { PreferencesDocument } from '../src/preferences/api/preferences.resources.js';
import { nextDigestAt } from '../src/preferences/core/notification-settings.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import {
  headersOf,
  parts,
  startMailServer,
  type TestMailServer,
} from './mail-server.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Notifications by email (#884), end to end: the fan-out, each person's choices, the sender and
 * the `mail.send` job, through an SMTP server in the test process.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

const author = user('mail-author', ['content.edit']);
const reviewer = user('mail-reviewer', ['content.review'], {
  languages: ['en'],
});
/** Reviews, but may not read drafts: never told of one. */
const blindReviewer: Actor = {
  ...actorWith(['content.read', 'content.review']),
  id: 'mail-blind-reviewer',
};
const lateReviewer = user('mail-late-reviewer', ['content.review']);
const publisher = user('mail-publisher', ['release.publish']);
const reader: Actor = { ...actorWith(['content.read']), id: 'mail-reader' };
const quiet = user('mail-quiet', ['content.review']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const everyone = [
  author,
  reviewer,
  blindReviewer,
  lateReviewer,
  publisher,
  reader,
  quiet,
];
const addressOf = (a: Actor) => `${a.id}@example.com`;

let server: TestMailServer;
let t: TestApp;

beforeAll(async () => {
  server = await startMailServer();
  t = await createTestApp({
    CCMS_MAIL_URL: `smtp://localhost:${server.port}`,
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_MAIL_CA_FILE: server.caFile,
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
  });
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: everyone.flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: everyone.map((a) => ({
        id: a.id,
        name: a.id === author.id ? 'Ada Author' : a.id,
        email: addressOf(a),
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});
afterEach(() => t?.actAs(undefined));

/** The clock the sender is run with: moved on by each test. */
let clock = Date.now();
const deliver = () => t.app.get(NotificationsConsumer).runOnce();
/** Runs the sender at `clock` (past the burst's gathering), then the email jobs. */
async function send(at = (clock += COALESCE_MS + 61_000)) {
  const report = await t.app
    .get(SendNotificationEmailsAction)
    .handle({ now: () => at });
  for (let i = 0; i < 5; i++) if ((await t.runJobs()) === 0) break;
  return report;
}
const to = (a: Actor) =>
  server.received.filter((m) => m.to.includes(addressOf(a)));
const textOf = (raw: string) =>
  parts(raw).find((p) => /Content-Type: text\/plain/i.test(p.headers))?.body ??
  '';
const htmlOf = (raw: string) =>
  parts(raw).find((p) => /Content-Type: text\/html/i.test(p.headers))?.body ??
  '';

async function preferences(actor: Actor, notifications?: object) {
  t.actAs(actor);
  const res = notifications
    ? await t.patch('/me/preferences').send(
        JSON.stringify({
          data: { type: 'Preferences', attributes: { notifications } },
        }),
      )
    : await t.get('/me/preferences');
  expect(res.status).toBe(200);
  return PreferencesDocument.parse(res.body).data;
}

/** A change set by `author` changing `charging`, submitted for review. */
async function submitted(title: string): Promise<string> {
  t.actAs(author);
  const created = await t
    .post('/change-sets')
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
    );
  expect(created.status).toBe(201);
  const { id } = ChangeSetDocument.parse(created.body).data;
  expect(
    (
      await t.post(`/change-sets/${id}/locks`).send(
        JSON.stringify({
          data: { type: 'Lock', attributes: { subject: charging } },
        }),
      )
    ).status,
  ).toBe(201);
  const path = `/change-sets/${id}/modules/en/charging/working-copy`;
  const read = ModuleWorkingCopyDocument.parse((await t.get(path)).body).data
    .attributes;
  const content = read.content as Module;
  const saved = await t.put(path).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            ...content,
            blocks: [
              {
                type: 'paragraph',
                id: 'typed',
                content: [{ type: 'text', text: `${title}.` }],
              },
            ],
          },
        },
      },
      meta: { version: read.version, baseCommit: read.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
  expect((await t.post(`/change-sets/${id}/submit`).send('')).status).toBe(200);
  await t.database.db.execute(sql`delete from locks`);
  return id;
}

async function bell(actor: Actor) {
  t.actAs(actor);
  const res = await t.get('/me/notifications');
  return NotificationPageDocument.parse(res.body).data;
}

describe('notification emails', () => {
  it('reach a reviewer at once, once, branded, with a one-click unsubscribe', async () => {
    await preferences(quiet, { choices: { 'change-set.submit': 'off' } });
    const id = await submitted('Clearer charging');
    await deliver();
    // Gathering: nothing before the burst's window has passed.
    expect(
      (
        await t.app
          .get(SendNotificationEmailsAction)
          .handle({ now: () => clock })
      ).sent,
    ).toBe(0);
    const report = await send();
    expect(report.sent).toBeGreaterThanOrEqual(1);
    const mails = to(reviewer);
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    const headers = headersOf(mail.raw);
    expect(headers.get('subject')).toContain('Ada Author asked you to review');
    expect(headers.get('list-unsubscribe')).toMatch(
      /^<https:\/\/docs\.example\.com\/api\/notifications\/unsubscribe\/[A-Za-z0-9_-]+>$/,
    );
    expect(headers.get('list-unsubscribe-post')).toBe(
      'List-Unsubscribe=One-Click',
    );
    expect(headers.get('message-id')).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    const text = textOf(mail.raw);
    expect(text).toContain(`https://docs.example.com/review?cs=${id}`);
    expect(text).toContain('You get this email because');
    expect(text).toMatch(
      /https:\/\/docs\.example\.com\/unsubscribe#[\w-]+&kinds=change-set\.submit$/m,
    );
    expect(htmlOf(mail.raw)).toContain('prefers-color-scheme:dark');
    // Not the author, not someone who may not read the draft, not someone who turned it off.
    expect(to(author)).toEqual([]);
    expect(to(blindReviewer)).toEqual([]);
    expect(to(quiet)).toEqual([]);
    // …who has no bell entry for it either.
    expect(
      (await bell(quiet)).map((n) => n.attributes.subject.id),
    ).not.toContain(id);
    // Sent once: another pass sends nothing more.
    await deliver();
    await send();
    expect(to(reviewer)).toHaveLength(1);
    // Recorded with its kind and recipient, never the address.
    const sent = await t.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'mail.sent'));
    const mine = sent.filter(
      (e) => (e.data as { recipient?: string }).recipient === reviewer.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toEqual({
      recipient: reviewer.id,
      kinds: ['change-set.submit'],
      template: 'notification',
    });
    expect(JSON.stringify(sent.map((e) => e.data))).not.toContain(
      '@example.com',
    );
  });

  it('are checked again when they go: someone who lost access is not emailed', async () => {
    const id = await submitted('Checked again');
    await deliver();
    // Scheduled for the late reviewer, who then loses their role before it goes.
    const [row] = await t.database.db
      .select()
      .from(notificationEmails)
      .where(eq(notificationEmails.recipientId, lateReviewer.id));
    expect(row).toBeDefined();
    await t.database.db
      .delete(roleAssignments)
      .where(eq(roleAssignments.userId, lateReviewer.id));
    const before = to(lateReviewer).length;
    await send();
    expect(to(lateReviewer)).toHaveLength(before);
    expect(
      await t.database.db
        .select()
        .from(notificationEmails)
        .where(eq(notificationEmails.recipientId, lateReviewer.id)),
    ).toEqual([]);
    expect(to(reviewer).some((m) => textOf(m.raw).includes(id))).toBe(true);
  });

  it('neither lose nor double an email when a sender stops halfway', async () => {
    const id = await submitted('Crash in between');
    await deliver();
    // A sender claims the rows and dies before it queues the email.
    const queue = t.app.get(NotificationEmailQueue);
    const claimed = await queue.claim(
      {
        mode: 'now',
        recipient: reviewer.id,
        kind: 'change-set.submit',
        subject: { type: 'change-set', id },
      },
      LEASE_MS,
      100,
    );
    expect(claimed?.items).toHaveLength(1);
    const before = to(reviewer).length;
    // Held: no other sender takes them meanwhile.
    await send();
    expect(to(reviewer)).toHaveLength(before);
    // The lease runs out: the next sender sends it, once.
    await t.database.db
      .update(notificationEmails)
      .set({ claimedUntil: new Date(Date.now() - 1_000) })
      .where(eq(notificationEmails.claim, claimed!.claim));
    await send();
    await send();
    const about = to(reviewer).filter((m) => textOf(m.raw).includes(id));
    expect(about).toHaveLength(1);
    // The dead sender's late completion writes nothing.
    expect(
      await t.app.get(UnitOfWork).run((tx) =>
        queue.complete(tx, claimed!.claim, [claimed!.items[0]!.id], {
          key: `now:${reviewer.id}:late`,
          recipient: reviewer.id,
          mode: 'now',
        }),
      ),
    ).toBe(false);
  });

  it('put a release in the next daily summary', async () => {
    await preferences(reader, { timeZone: 'Europe/Vienna', language: 'de' });
    t.actAs(publisher);
    const res = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '7.0', major: true },
        },
      }),
    );
    expect(res.status).toBe(201);
    const release = ReleaseDocument.parse(res.body).data;
    await deliver();
    // Not at once.
    await send(Date.now() + COALESCE_MS + 1_000);
    expect(to(reader)).toEqual([]);
    // At 08:00 in Vienna.
    const due = nextDigestAt(new Date(), 8, 'Europe/Vienna').getTime();
    clock = due + 1_000;
    await send(clock);
    const mails = to(reader);
    expect(mails).toHaveLength(1);
    expect(headersOf(mails[0]!.raw).get('subject')).toBe(
      'Ihre tägliche Zusammenfassung: 1 Neuigkeit',
    );
    const text = textOf(mails[0]!.raw);
    expect(text).toContain('Veröffentlichung north 7.0 ist erschienen');
    expect(text).toContain(
      `https://docs.example.com/releases?release=${release.id}`,
    );
    expect(headersOf(mails[0]!.raw).get('content-language')).toBe('de');
  });

  it('unsubscribe from the email’s link: that kind only, without signing in', async () => {
    const mail = to(reviewer)[0]!;
    const url = headersOf(mail.raw)
      .get('list-unsubscribe')!
      .slice(1, -1)
      .replace('https://docs.example.com/api', '');
    const token = url.split('/').pop()!;
    // What a mail client sends (RFC 8058): a form body, no Origin, no credentials.
    const res = await t
      .anonymous()
      .post(url)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(UnsubscribedDocument.parse(res.body).meta).toEqual({
      kinds: ['change-set.submit'],
      changed: ['change-set.submit'],
    });
    const after = (await preferences(reviewer)).attributes.notifications;
    expect(after.choices['change-set.submit']).toBe('app');
    expect(after.choices['change-set.return']).toBe('email');
    expect(after.emailPaused).toBe(false);
    // Again: nothing more to change.
    const again = await t.anonymous().post(url).send();
    expect(UnsubscribedDocument.parse(again.body).meta.changed).toEqual([]);
    expect(UnsubscribedDocument.parse(again.body).meta.kinds).toEqual([
      'change-set.submit',
    ]);
    // A token changed by one character, or made up: 404, nothing changed.
    const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    for (const bad of [flipped, 'x'.repeat(40)]) {
      const refused = await t
        .anonymous()
        .post(`/notifications/unsubscribe/${bad}`)
        .send();
      expect(refused.status).toBe(404);
      expect(ErrorDocument.parse(refused.body).errors[0]?.code).toBe(
        'unsubscribe-link-invalid',
      );
    }
    // A summary's link leaves an email at once as it is.
    const digestToken = t.app
      .get(UnsubscribeTokens)
      .issue(reviewer.id, ['change-set.return'], 'digest');
    const kept = await t
      .anonymous()
      .post(`/notifications/unsubscribe/${digestToken}`)
      .send();
    expect(UnsubscribedDocument.parse(kept.body).meta.changed).toEqual([]);
    expect(UnsubscribedDocument.parse(kept.body).meta.kinds).toEqual([]);
    expect(
      (await preferences(reviewer)).attributes.notifications.choices[
        'change-set.return'
      ],
    ).toBe('email');
    // Recorded, by no one signed in.
    const [event] = await t.database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'notification.unsubscribe'),
          eq(auditEvents.subjectId, reviewer.id),
        ),
      );
    expect(event?.data).toEqual({ kinds: ['change-set.submit'] });
  });

  it('“Turn off all notifications” silences that person alone', async () => {
    await preferences(reviewer, { allOff: true });
    await preferences(quiet, { choices: { 'change-set.submit': 'email' } });
    const id = await submitted('All off');
    await deliver();
    await send();
    const about = (a: Actor) =>
      to(a).filter((m) => textOf(m.raw).includes(id)).length;
    expect(
      (await bell(reviewer)).map((n) => n.attributes.subject.id),
    ).not.toContain(id);
    expect(about(reviewer)).toBe(0);
    // Someone else still hears of it, in the bell and by email.
    expect((await bell(quiet)).map((n) => n.attributes.subject.id)).toContain(
      id,
    );
    expect(about(quiet)).toBe(1);
  });

  /** The rows still waiting for `actor`, by their mode. */
  const waiting = async (actor: Actor) =>
    (
      await t.database.db
        .select({ mode: notificationEmails.mode })
        .from(notificationEmails)
        .where(eq(notificationEmails.recipientId, actor.id))
    ).map((r) => r.mode);
  /** Starts `actor` with nothing waiting (the release's summary, say). */
  const nothingWaiting = (actor: Actor) =>
    t.database.db
      .delete(notificationEmails)
      .where(eq(notificationEmails.recipientId, actor.id));

  it('go in the summary instead when the kind’s choice changed before they went', async () => {
    await nothingWaiting(quiet);
    await preferences(quiet, { choices: { 'change-set.submit': 'email' } });
    const id = await submitted('Changed my mind');
    await deliver();
    expect(await waiting(quiet)).toEqual(['now']);
    await preferences(quiet, { choices: { 'change-set.submit': 'digest' } });
    const report = await send();
    expect(report.deferred).toBeGreaterThanOrEqual(1);
    expect(to(quiet).some((m) => textOf(m.raw).includes(id))).toBe(false);
    expect(await waiting(quiet)).toEqual(['digest']);
    // Turned off now: the summary drops it.
    await preferences(quiet, { choices: { 'change-set.submit': 'off' } });
    clock += 86_400_000;
    await send(clock);
    expect(await waiting(quiet)).toEqual([]);
    expect(to(quiet).some((m) => textOf(m.raw).includes(id))).toBe(false);
  });

  it('wait for the summary past the hourly cap', async () => {
    await nothingWaiting(quiet);
    await preferences(quiet, { choices: { 'change-set.submit': 'email' } });
    const id = await submitted('Over the cap');
    await deliver();
    const at = (clock += COALESCE_MS + 61_000);
    // 20 emails (the default cap) went to them in the last hour.
    await t.database.db.insert(notificationEmailSends).values(
      Array.from({ length: 20 }, (_, i) => ({
        key: `now:${quiet.id}:cap-${i}`,
        recipientId: quiet.id,
        mode: 'now',
        sentAt: new Date(at - 1_000),
      })),
    );
    const report = await send(at);
    expect(report.deferred).toBeGreaterThanOrEqual(1);
    // Not on its own: in the summary (due at once here, the test's clock being days ahead).
    const about = to(quiet).filter((m) => textOf(m.raw).includes(id));
    expect(about.map((m) => headersOf(m.raw).get('subject'))).toEqual([
      expect.stringMatching(/^Your daily summary/),
    ]);
  });

  it('try again later what could not be checked for an outage, never dropping it', async () => {
    await nothingWaiting(reviewer);
    await preferences(reviewer, {
      allOff: false,
      choices: { 'change-set.submit': 'email' },
    });
    const id = await submitted('Checked later');
    await deliver();
    const fanOut = t.app.get(FanOut);
    const spy = vi
      .spyOn(fanOut, 'of')
      .mockRejectedValue(
        new UnavailableError(
          'content-unavailable',
          'The content is not readable now.',
          5,
        ),
      );
    const before = to(reviewer).length;
    try {
      await send();
    } finally {
      spy.mockRestore();
    }
    expect(to(reviewer)).toHaveLength(before);
    // Held for its lease, not dropped: the next pass after it sends it.
    expect(await waiting(reviewer)).toEqual(['now']);
    await t.database.db
      .update(notificationEmails)
      .set({ claimedUntil: new Date(Date.now() - 1_000) })
      .where(eq(notificationEmails.recipientId, reviewer.id));
    await send();
    expect(to(reviewer).filter((m) => textOf(m.raw).includes(id))).toHaveLength(
      1,
    );
  });

  describe('a database error, whose message holds its parameters', () => {
    const address = 'a.person@secret.example';
    const failed = () =>
      new DrizzleQueryError(
        'select * from "users" where "email" = $1',
        [address, 'The text of a notification'],
        new Error('the connection was lost'),
      );
    /** What `run` logs, each argument as a logger would print it. */
    async function logged(run: () => Promise<unknown>): Promise<string> {
      const lines: string[] = [];
      const spies = (['warn', 'error', 'log'] as const).map((level) =>
        vi
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(args.map((a) => inspect(a)).join(' '));
          }),
      );
      try {
        await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return lines.join('\n');
    }
    const saysWhyOnly = (log: string, what: RegExp) => {
      expect(log).toMatch(what);
      expect(log).toContain('Failed query: select * from');
      expect(log).not.toContain(address);
      expect(log).not.toContain('The text of a notification');
    };

    it('is not logged with them when a notification cannot be checked', async () => {
      await nothingWaiting(reviewer);
      await submitted('Not checked');
      await deliver();
      const spy = vi.spyOn(t.app.get(FanOut), 'of').mockRejectedValue(failed());
      try {
        saysWhyOnly(await logged(() => send()), /could not be checked again/);
      } finally {
        spy.mockRestore();
      }
    });

    it('is not logged with them when a group fails', async () => {
      await nothingWaiting(reviewer);
      await submitted('Not claimed');
      await deliver();
      const spy = vi
        .spyOn(t.app.get(NotificationEmailQueue), 'claim')
        .mockRejectedValue(failed());
      try {
        saysWhyOnly(
          await logged(() => send()),
          /for mail-reviewer was not sent this pass/,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('is not logged with them when the delivery fails, retries or passes a row over', async () => {
      const deliverAction = t.app.get(DeliverNotificationsAction);
      const row = { position: { id: 7 }, topic: 'change-set.submitted' };
      const spy = vi.spyOn(deliverAction, 'handle').mockResolvedValue({
        skipped: [{ ...row, reason: 'failed', error: failed() }],
        retry: { ...row, error: failed() },
      } as never);
      try {
        const log = await logged(deliver);
        saysWhyOnly(log, /Notified nobody of outbox row 7/);
        saysWhyOnly(log, /tried again next run/);
        spy.mockRejectedValue(failed());
        saysWhyOnly(await logged(deliver), /Delivering notifications failed/);
      } finally {
        spy.mockRestore();
      }
    });

    it('is not logged with them when old notifications cannot be removed', async () => {
      const later = Date.now() + 3 * 3_600_000;
      const now = vi.spyOn(Date, 'now').mockReturnValue(later);
      const spy = vi
        .spyOn(t.app.get(PruneNotificationsAction), 'handle')
        .mockRejectedValue(failed());
      try {
        saysWhyOnly(await logged(deliver), /Removing old notifications failed/);
      } finally {
        spy.mockRestore();
        now.mockRestore();
      }
    });

    it('is not logged with them when the whole pass fails', async () => {
      const spy = vi
        .spyOn(t.app.get(SendNotificationEmailsAction), 'handle')
        .mockRejectedValue(failed());
      try {
        saysWhyOnly(
          await logged(deliver),
          /Sending notification emails failed/,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
});
