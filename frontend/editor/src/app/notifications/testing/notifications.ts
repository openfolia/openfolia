import type { NotificationItem, NotificationKind } from '../notification-model';

/** A notification as the API sends it, for tests. */
export const notification = (
  id: string,
  kind: NotificationKind,
  payload: Record<string, unknown>,
  options: {
    subject?: NotificationItem['attributes']['subject'];
    createdAt?: string;
    readAt?: string | null;
  } = {},
): NotificationItem => ({
  type: 'Notification',
  id,
  attributes: {
    kind,
    subject: options.subject ?? {
      type: 'change-set',
      id: String(payload['changeSetId'] ?? 'cs-1'),
    },
    payload,
    createdAt: options.createdAt ?? new Date().toISOString(),
    readAt: options.readAt ?? null,
  },
});
