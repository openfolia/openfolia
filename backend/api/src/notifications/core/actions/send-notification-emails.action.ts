import { Injectable, Logger } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { errorLine } from '../../../base/core/error-line.js';
import {
  ConflictError,
  DomainError,
  UnavailableError,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { isMailAddress } from '../../../mail/core/mail.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import {
  MAX_DIGEST_ITEMS,
  type NotificationMailItem,
} from '../../../mail/core/templates/notification-templates.js';
import { OutboxFeed } from '../../../outbox/core/outbox-feed.js';
import { NotificationEmailOptions } from '../../../preferences/core/notification-email-options.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  deliveryOf,
  nextDigestAt,
  type NotificationSettings,
} from '../../../preferences/core/notification-settings.js';
import { PreferenceStore } from '../../../preferences/core/preference-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import { FanOut, type People } from '../fan-out.js';
import {
  ChosenKind,
  type Notification,
  type NotificationKind,
} from '../notification.js';
import {
  type ClaimedEmails,
  type EmailGroup,
  NotificationEmailQueue,
} from '../notification-email-queue.js';
import { UnsubscribeTokens } from '../unsubscribe-tokens.js';

/** How long a burst gathers before its email goes: a few changes on one item, one email. */
export const COALESCE_MS = 2 * 60_000;
/** How long a sender holds the rows it claimed: one that dies hands them back after this. */
export const LEASE_MS = 5 * 60_000;
/** The most groups (bursts, summaries) one pass sends. */
export const GROUPS_PER_PASS = 50;
/** How often a pass looks for summaries that are due. */
export const DIGEST_CHECK_MS = 60_000;
/** The most rows one email takes: a burst's, a summary's. */
export const CLAIM_NOW = 100;
export const CLAIM_DIGEST = 1_000;
/** How long the sends and the rows never sent (mail was off since) are kept. */
export const KEEP_MS = 3 * 86_400_000;

/** What a pass did. */
export interface EmailReport {
  /** Emails queued (each goes out through `mail.send`). */
  sent: number;
  /** Notifications that go out by email no more (turned off since, no address, no access). */
  dropped: number;
  /** Notifications moved to the summary (the kind's choice changed, or the hourly cap). */
  deferred: number;
}

/** A time zone's clock for a person who has none. */
const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Sends the notification emails that are due (#884), each pass of the notifications' consumer:
 * the bursts of one kind on one subject that have gathered for `COALESCE_MS`, and the daily
 * summaries whose hour has come in the person's time zone. Each group is claimed for a lease,
 * checked again (the person's choices now; their address; and the fan-out of each notification's
 * outbox row run again, so nobody is emailed of what they may no longer read), then removed in
 * the transaction that queues its email, under an idempotency key: a restart neither loses nor
 * doubles one. Past `perHour` emails in an hour, a person's emails wait for their summary.
 *
 * Runs for nobody: `NotificationsConsumer` starts it.
 */
@Injectable()
export class SendNotificationEmailsAction implements UnguardedAction {
  readonly policy = 'internal';
  private lastDigestCheck = 0;
  private readonly logger = new Logger('NotificationEmails');

  constructor(
    private readonly queue: NotificationEmailQueue,
    private readonly preferences: PreferenceStore,
    private readonly users: UserDirectory,
    private readonly outbox: OutboxFeed,
    private readonly fanOut: FanOut,
    private readonly releases: ReleaseStore,
    private readonly mail: MailOutbox,
    private readonly tokens: UnsubscribeTokens,
    private readonly options: NotificationEmailOptions,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(
    budget: { readonly deadline?: number; readonly now?: () => number } = {},
  ): Promise<EmailReport> {
    const now = budget.now ?? Date.now;
    const report: EmailReport = { sent: 0, dropped: 0, deferred: 0 };
    // Nothing is scheduled while email is off; rows from before wait for it (or `KEEP_MS`).
    if (!this.mail.linksEnabled) return report;
    const people = this.fanOut.people();
    const names = new Map<string, Promise<string | undefined>>();
    const labels = new Map<string, Promise<string | undefined>>();
    const context = { people, names, labels };
    const overBudget = () =>
      budget.deadline !== undefined && now() >= budget.deadline;

    let left = GROUPS_PER_PASS;
    for (const group of await this.queue.dueNow(
      new Date(now() - COALESCE_MS),
      left,
    )) {
      if (overBudget()) return report;
      left--;
      await this.sendOrSkip(group, now, report, context);
    }
    if (left > 0 && now() - this.lastDigestCheck >= DIGEST_CHECK_MS) {
      this.lastDigestCheck = now();
      const waiting = await this.queue.waitingDigests(1_000);
      const settings = await this.preferences.notificationSettings(
        waiting.map((w) => w.recipient),
      );
      for (const w of waiting) {
        if (left <= 0 || overBudget()) break;
        const s = settings.get(w.recipient) ?? DEFAULT_NOTIFICATION_SETTINGS;
        const due = nextDigestAt(
          w.oldest,
          s.digestHour ?? this.options.digestHour,
          s.timeZone ?? DEFAULT_TIME_ZONE,
        );
        if (now() < due.getTime()) continue;
        left--;
        await this.sendOrSkip(
          { mode: 'digest', recipient: w.recipient },
          now,
          report,
          context,
        );
      }
    }
    return report;
  }

  /** Removes the sends and the never-sent rows older than `KEEP_MS`. */
  prune(now = Date.now()): Promise<number> {
    return this.queue.prune(new Date(now - KEEP_MS), 1_000);
  }

  /**
   * `send`, a failure logged and the pass going on: the group's rows stay held until their lease
   * runs out, then the next pass tries them again (or `KEEP_MS` removes them).
   */
  private async sendOrSkip(
    group: EmailGroup,
    now: () => number,
    report: EmailReport,
    context: Context,
  ): Promise<void> {
    try {
      await this.send(group, now, report, context);
    } catch (error) {
      this.logger.warn(
        `A ${group.mode === 'now' ? 'notification email' : 'daily summary'} for ${group.recipient} was not sent this pass: ${errorLine(error)}`,
      );
    }
  }

  private async send(
    group: EmailGroup,
    now: () => number,
    report: EmailReport,
    context: Context,
  ): Promise<void> {
    const claimed = await this.queue.claim(
      group,
      LEASE_MS,
      group.mode === 'now' ? CLAIM_NOW : CLAIM_DIGEST,
    );
    if (!claimed) return;
    const all = claimed.items.map((i) => i.id);
    const user = await this.users.findUser(group.recipient);
    const actor = await this.users.findActor(group.recipient);
    if (
      !user ||
      user.deactivatedAt !== null ||
      actor?.kind !== 'user' ||
      // No role left: nothing of the content concerns them any more.
      actor.roles.length === 0 ||
      user.email === null ||
      !isMailAddress(user.email)
    ) {
      await this.drop(claimed, all, report);
      return;
    }
    const settings =
      (await this.preferences.notificationSettings([group.recipient])).get(
        group.recipient,
      ) ?? DEFAULT_NOTIFICATION_SETTINGS;
    const { keep, toDigest, drop } = this.sort(claimed, group, settings);
    const still: { id: number; notification: Emailed }[] = [];
    for (const item of keep) {
      let concerns: boolean;
      try {
        concerns = await this.stillConcerns(item.notification, context.people);
      } catch (error) {
        // An outage, a contended lock or anything not the API's own refusal: not known now. Left
        // to its lease, the rest goes on. (`DeliverNotificationsAction`'s order.)
        // shortcut: retried each lease until `KEEP_MS`, no attempt count; add one if it ever spams the log.
        if (
          error instanceof UnavailableError ||
          error instanceof ConflictError ||
          !(error instanceof DomainError)
        ) {
          this.logger.warn(
            `Notification ${item.notification.id} could not be checked again: ${errorLine(error)}`,
          );
          continue;
        }
        concerns = false;
      }
      if (concerns) still.push(item);
      else drop.push(item.id);
    }
    await this.queue.release(claimed.claim, toDigest, 'digest');
    report.deferred += toDigest.length;
    await this.drop(claimed, drop, report);
    if (still.length === 0) return;
    const ids = still.map((i) => i.id);
    if (
      group.mode === 'now' &&
      (await this.queue.sentSince(
        group.recipient,
        new Date(now() - 3_600_000),
      )) >= this.options.perHour
    ) {
      await this.queue.release(claimed.claim, ids, 'digest');
      report.deferred += ids.length;
      return;
    }
    const notes = still.map((i) => i.notification);
    const kinds = [...new Set(notes.map((n) => n.kind))];
    const items = await Promise.all(
      notes
        .slice(0, group.mode === 'now' ? 1 : MAX_DIGEST_ITEMS)
        .map((n) => this.itemOf(n, context)),
    );
    const token = this.tokens.issue(group.recipient, kinds, group.mode);
    const first = Math.min(...notes.map((n) => Number(n.id)));
    const key = `${group.mode}:${group.recipient}:${first}`;
    const queued = await this.unit.run(async (tx) => {
      if (
        !(await this.queue.complete(tx, claimed.claim, ids, {
          key,
          recipient: group.recipient,
          mode: group.mode,
        }))
      ) {
        return false;
      }
      const request = {
        to: { address: user.email!, name: user.name },
        language: settings.language,
        audit: { recipient: group.recipient, kinds },
      };
      await (group.mode === 'now'
        ? this.mail.queue(tx, {
            ...request,
            template: 'notification',
            params: { item: items[0]!, repeats: notes.length, token },
          })
        : this.mail.queue(tx, {
            ...request,
            template: 'notification-digest',
            params: {
              items,
              more: Math.max(0, notes.length - items.length),
              kinds,
              token,
            },
          }));
      return true;
    }, BOUNDED);
    if (queued) report.sent++;
  }

  /** The claimed rows by what the person's choices say now. */
  private sort(
    claimed: ClaimedEmails,
    group: EmailGroup,
    settings: NotificationSettings,
  ) {
    const keep: { id: number; notification: Emailed }[] = [];
    const toDigest: number[] = [];
    const drop: number[] = [];
    for (const item of claimed.items) {
      const { id, notification } = item;
      const choice = deliveryOf(settings, notification.kind);
      if (choice === 'off' || choice === 'app' || !isEmailed(notification)) {
        drop.push(id);
      } else if (group.mode === 'now' && choice === 'digest') {
        toDigest.push(id);
      } else keep.push({ id, notification });
    }
    return { keep, toDigest, drop };
  }

  private async drop(
    claimed: ClaimedEmails,
    ids: readonly number[],
    report: EmailReport,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.queue.release(claimed.claim, ids, 'drop');
    report.dropped += ids.length;
  }

  /**
   * Whether the notification still concerns its recipient: the fan-out of its outbox row, run
   * again with the people as they are now, still names them. A row no longer there: no.
   */
  private async stillConcerns(
    notification: Notification,
    people: People,
  ): Promise<boolean> {
    const event = await this.outbox.find(notification.outboxId);
    if (!event || event.topic !== notification.kind) return false;
    const made = await this.fanOut.of(event, people);
    return made?.some((m) => m.recipient === notification.recipient) ?? false;
  }

  /** What the email says of a notification: the bell's words, and where it opens. */
  private async itemOf(
    n: Emailed,
    context: Context,
  ): Promise<NotificationMailItem> {
    const p = n.payload;
    const str = (v: unknown, max: number) =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1
        ? Math.min(v, 100_000)
        : undefined;
    const enc = encodeURIComponent;
    const changeSetId = str(p['changeSetId'], 200);
    const item: {
      -readonly [K in keyof NotificationMailItem]: NotificationMailItem[K];
    } = {
      kind: n.kind,
    };
    const title = str(p['title'], 300);
    if (title) item.title = title;
    const by = await this.nameOf(p['by'], context);
    if (by) item.by = by;
    switch (kindGroup(n.kind)) {
      case 'change-set':
        item.path = `review?cs=${enc(changeSetId ?? n.subject.id)}`;
        if (n.kind === 'lock.break') item.count = num(p['count']) ?? 1;
        break;
      case 'translation':
        item.path = changeSetId
          ? `review?cs=${enc(changeSetId)}`
          : `translations?import=${enc(n.subject.id)}`;
        if (n.kind === 'translation.import-failed') {
          item.path = `translations?import=${enc(n.subject.id)}`;
        }
        break;
      case 'release': {
        item.path = `releases?release=${enc(n.subject.id)}`;
        const label = await this.labelOf(n.subject.id, context);
        if (label) item.release = label;
        if (n.kind === 'release.published') {
          item.count = Array.isArray(p['manualIds'])
            ? Math.max(1, p['manualIds'].length)
            : 1;
        }
        break;
      }
      case 'backup':
        item.path = 'admin/backups';
        if (n.kind === 'backup.overdue') {
          const hours = num(p['warnAfterHours']);
          if (hours) item.hours = hours;
        }
        break;
    }
    return item;
  }

  /** A person's name from a payload's `by`; undefined for a service or nobody known. */
  private nameOf(
    value: unknown,
    context: Context,
  ): Promise<string | undefined> {
    if (typeof value !== 'object' || value === null) {
      return Promise.resolve(undefined);
    }
    const { kind, id } = value as Record<string, unknown>;
    if (kind !== 'user' || typeof id !== 'string') {
      return Promise.resolve(undefined);
    }
    let name = context.names.get(id);
    if (!name) {
      name = this.users
        .findUser(id)
        .then((u) => u?.name.slice(0, 200) || undefined)
        .catch(() => undefined);
      context.names.set(id, name);
    }
    return name;
  }

  /** A release's label (`<product> <revision>`); undefined when it is not found. */
  private labelOf(id: string, context: Context): Promise<string | undefined> {
    let label = context.labels.get(id);
    if (!label) {
      label = this.releases
        .find(id)
        .then((r) =>
          r ? `${r.product} ${r.revision}`.slice(0, 200) : undefined,
        )
        .catch(() => undefined);
      context.labels.set(id, label);
    }
    return label;
  }
}

interface Context {
  readonly people: People;
  readonly names: Map<string, Promise<string | undefined>>;
  readonly labels: Map<string, Promise<string | undefined>>;
}

/** A notification of a kind that goes out by email from here. */
type Emailed = Notification & { readonly kind: ChosenKind };
const isEmailed = (n: Notification): n is Emailed =>
  ChosenKind.safeParse(n.kind).success;

function kindGroup(
  kind: NotificationKind,
): 'change-set' | 'translation' | 'release' | 'backup' {
  if (kind.startsWith('change-set.') || kind === 'lock.break') {
    return 'change-set';
  }
  if (kind.startsWith('translation.')) return 'translation';
  if (kind.startsWith('release.')) return 'release';
  return 'backup';
}
