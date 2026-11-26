import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { MailModule } from '../mail/mail.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PreferencesModule } from '../preferences/preferences.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { NotificationsConsumer } from './api/notifications-consumer.js';
import { NotificationsController } from './api/notifications.controller.js';
import { UnsubscribeController } from './api/unsubscribe.controller.js';
import { DeliverNotificationsAction } from './core/actions/deliver-notifications.action.js';
import {
  CountUnreadNotificationsAction,
  GetNotificationAction,
  ListNotificationsAction,
} from './core/actions/list-notifications.action.js';
import { MarkNotificationsReadAction } from './core/actions/mark-notifications-read.action.js';
import { PruneNotificationsAction } from './core/actions/prune-notifications.action.js';
import { SendNotificationEmailsAction } from './core/actions/send-notification-emails.action.js';
import { UnsubscribeAction } from './core/actions/unsubscribe.action.js';
import { FanOut } from './core/fan-out.js';
import { NotificationEmailQueue } from './core/notification-email-queue.js';
import { NotificationRouting } from './core/notification-routing.js';
import { NotificationStore } from './core/notification-store.js';
import { UnsubscribeTokens } from './core/unsubscribe-tokens.js';
import { DrizzleNotificationEmailQueue } from './repos/drizzle-notification-email-queue.js';
import { DrizzleNotificationStore } from './repos/drizzle-notification-store.js';

/**
 * A per-person inbox (#252): an outbox consumer (`NotificationsConsumer`)
 * fans each event out to the people it concerns (`FanOut`), and
 * `/me/notifications` lists and marks a person's own. Each person's choices
 * (#884, their preferences) decide what is kept and what goes out by email,
 * at once or in the daily summary (`SendNotificationEmailsAction`, through
 * the mail component), with a one-click unsubscribe
 * (`/notifications/unsubscribe/:token`). `ChangeSetStore` comes from
 * `AuthoredBranchesModule` (global).
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    ChangeSetsModule,
    ContentModule,
    MailModule,
    OutboxModule,
    PreferencesModule,
    ReleasesModule,
  ],
  controllers: [NotificationsController, UnsubscribeController],
  providers: [
    FanOut,
    NotificationRouting,
    DeliverNotificationsAction,
    SendNotificationEmailsAction,
    PruneNotificationsAction,
    NotificationsConsumer,
    ListNotificationsAction,
    GetNotificationAction,
    CountUnreadNotificationsAction,
    MarkNotificationsReadAction,
    UnsubscribeTokens,
    UnsubscribeAction,
    { provide: NotificationStore, useClass: DrizzleNotificationStore },
    {
      provide: NotificationEmailQueue,
      useClass: DrizzleNotificationEmailQueue,
    },
  ],
})
export class NotificationsModule {}
