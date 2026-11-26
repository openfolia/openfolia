import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The notifications component's audit actions (`src/audit-actions.ts` registers them). */
export const NOTIFICATION_AUDIT_ACTIONS = defineAuditActions('notifications', [
  'notification.unsubscribe',
]);
