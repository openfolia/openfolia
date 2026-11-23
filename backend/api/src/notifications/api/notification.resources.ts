import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import {
  MAX_MARKED,
  type Notification,
  NotificationId,
  NotificationKind,
  NotificationSubjectType,
} from '../core/notification.js';

export const NotificationAttributes = z
  .object({
    kind: NotificationKind.describe(
      'What happened: the event’s topic. `change-set.submit` (a change set to review), `change-set.return`, `change-set.approve`, `change-set.sign-off`, `change-set.merge` (your change set), `lock.break` (your locks were broken), `translation.imported`, `translation.import-failed` (your import), `release.output-failed`, `release.output-recovered` (a file told failed is ready after all), `release.published` (a major release of a manual you read).',
    ),
    subject: z
      .object({ type: NotificationSubjectType, id: z.string() })
      .describe(
        'What it opens: `{ type: "change-set" | "release" | "import", id }`.',
      ),
    payload: z
      .record(z.string(), z.unknown())
      .describe(
        'What a client builds its sentence from, by kind: IDs, a change set’s `title`, `by` (who did it: `{ kind, id }`), `state` (where a change set went), `reason`, `count` and `subjects` (broken locks), `manualIds`, `level`. Never text written for people on the server.',
      ),
    createdAt: z.iso
      .datetime({ offset: true })
      .describe('When the event happened.'),
    readAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When you marked it read; null while unread.'),
  })
  .meta({ id: 'NotificationAttributes' });

export const NotificationResource = resourceObject('Notification', {
  attributes: NotificationAttributes,
}).meta({ id: 'NotificationResource' });

export const NotificationDocument = singleDocument(NotificationResource).meta({
  id: 'NotificationDocument',
});

const UnreadCount = z
  .int()
  .min(0)
  .describe('How many of your notifications are unread, whatever the filter.');

export const NotificationPageDocument = z
  .object({
    data: z.array(NotificationResource),
    meta: z.object({ page: PageMeta, unreadCount: UnreadCount }),
    links: PageLinks,
  })
  .meta({ id: 'NotificationPageDocument' });

export const UnreadCountDocument = z
  .object({
    meta: z.object({
      unreadCount: UnreadCount,
      latest: z
        .string()
        .nullable()
        .describe(
          'Your newest notification’s ID, read or not; null when there is none. It changes when one arrives.',
        ),
    }),
  })
  .meta({ id: 'UnreadCountDocument' });

/** `POST /me/notifications/read`: the IDs, or all. */
export const MarkReadDocument = z
  .strictObject({
    meta: z.union([
      z.strictObject({
        ids: z
          .array(NotificationId)
          .min(1)
          .max(MAX_MARKED)
          .describe(
            `Your notifications to mark read, 1 to ${MAX_MARKED} IDs. Any that is not yours (or none at all) is 404, and nothing is marked.`,
          ),
      }),
      z.strictObject({
        all: z.literal(true).describe('Mark all of your notifications read.'),
      }),
    ]),
  })
  .meta({ id: 'MarkReadDocument' });
export type MarkReadDocument = z.output<typeof MarkReadDocument>;

export const MarkReadResultDocument = z
  .object({
    meta: z.object({
      marked: z.int().min(0).describe('How many were unread and are now read.'),
      unreadCount: UnreadCount,
    }),
  })
  .meta({ id: 'MarkReadResultDocument' });

/** Filter parameters of `GET /me/notifications`. */
export const notificationFilters = {
  unread: z
    .enum(['true', 'false'], 'true or false')
    .transform((value) => value === 'true'),
};

export function toNotificationResource(
  notification: Notification,
): z.infer<typeof NotificationResource> {
  return {
    type: 'Notification',
    id: notification.id,
    attributes: {
      kind: notification.kind,
      subject: notification.subject,
      payload: { ...notification.payload },
      createdAt: notification.createdAt.toISOString(),
      readAt: notification.readAt?.toISOString() ?? null,
    },
  };
}
