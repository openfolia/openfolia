import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The mail component's audit actions (`src/audit-actions.ts` registers them). */
export const MAIL_AUDIT_ACTIONS = defineAuditActions('mail', [
  'mail.failed',
  'mail.sent',
  'mail.test',
]);
