import { defineNotificationKinds } from '../notifications/core/notification-kind-registry.js';

/** The backups component's notification kinds (`src/notification-kinds.ts` registers them). */
export const BACKUP_NOTIFICATION_KINDS = defineNotificationKinds('backups', [
  { kind: 'backup.failed', section: 'admin', defaultChoice: 'email' },
  { kind: 'backup.overdue', section: 'admin', defaultChoice: 'email' },
]);
