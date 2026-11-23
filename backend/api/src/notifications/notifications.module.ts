import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { NotificationsConsumer } from './api/notifications-consumer.js';
import { NotificationsController } from './api/notifications.controller.js';
import { DeliverNotificationsAction } from './core/actions/deliver-notifications.action.js';
import {
  CountUnreadNotificationsAction,
  GetNotificationAction,
  ListNotificationsAction,
} from './core/actions/list-notifications.action.js';
import { MarkNotificationsReadAction } from './core/actions/mark-notifications-read.action.js';
import { PruneNotificationsAction } from './core/actions/prune-notifications.action.js';
import { FanOut } from './core/fan-out.js';
import { NotificationStore } from './core/notification-store.js';
import { DrizzleNotificationStore } from './repos/drizzle-notification-store.js';

/**
 * A per-person inbox (#252): an outbox consumer (`NotificationsConsumer`)
 * fans each event out to the people it concerns (`FanOut`), and
 * `/me/notifications` lists and marks a person's own. `ChangeSetStore`
 * comes from `AuthoredBranchesModule` (global).
 */
@Module({
  imports: [AccessModule, ChangeSetsModule, ContentModule, OutboxModule],
  controllers: [NotificationsController],
  providers: [
    FanOut,
    DeliverNotificationsAction,
    PruneNotificationsAction,
    NotificationsConsumer,
    ListNotificationsAction,
    GetNotificationAction,
    CountUnreadNotificationsAction,
    MarkNotificationsReadAction,
    { provide: NotificationStore, useClass: DrizzleNotificationStore },
  ],
})
export class NotificationsModule {}
