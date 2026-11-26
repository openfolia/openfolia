import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { MailOutbox } from '../../mail/core/mail-outbox.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  deliveryOf,
} from '../../preferences/core/notification-settings.js';
import { PreferenceStore } from '../../preferences/core/preference-store.js';
import type { NewNotification } from './notification.js';
import {
  NotificationEmailQueue,
  type ScheduledEmail,
} from './notification-email-queue.js';

/** What the fan-out keeps of a batch, and what of it goes out by email. */
export interface Routed {
  readonly keep: NewNotification[];
  readonly email: ScheduledEmail[];
}

/**
 * Each person's choices applied to what the fan-out made (#884): a kind they turned off (or
 * every kind, "Turn off all notifications") is neither stored nor emailed; one they chose by
 * email is scheduled at once (`now`) or for the daily summary (`digest`), unless they paused
 * email. Nothing is scheduled while email cannot be sent (`MailOutbox.linksEnabled`: a mail
 * server, the secret key and the public URL). Applies from the moment it is read: notifications
 * stored before a change stay.
 */
@Injectable()
export class NotificationRouting {
  constructor(
    private readonly preferences: PreferenceStore,
    private readonly emails: NotificationEmailQueue,
    private readonly mail: MailOutbox,
  ) {}

  async route(made: readonly NewNotification[]): Promise<Routed> {
    if (made.length === 0) return { keep: [], email: [] };
    const settings = await this.preferences.notificationSettings(
      made.map((n) => n.recipient),
    );
    const mailOn = this.mail.linksEnabled;
    const keep: NewNotification[] = [];
    const email: ScheduledEmail[] = [];
    for (const n of made) {
      const choice = deliveryOf(
        settings.get(n.recipient) ?? DEFAULT_NOTIFICATION_SETTINGS,
        n.kind,
      );
      if (choice === 'off') continue;
      keep.push(n);
      if (mailOn && (choice === 'email' || choice === 'digest')) {
        email.push({
          outboxId: n.outboxId,
          recipient: n.recipient,
          mode: choice === 'email' ? 'now' : 'digest',
        });
      }
    }
    return { keep, email };
  }

  /** Schedules `email` inside `tx`, the transaction that stores its notifications. */
  schedule(tx: Transaction, email: readonly ScheduledEmail[]): Promise<number> {
    return email.length === 0
      ? Promise.resolve(0)
      : this.emails.schedule(tx, email);
  }
}
