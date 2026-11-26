import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The webhooks component's audit actions (`src/audit-actions.ts` registers them). */
export const WEBHOOK_AUDIT_ACTIONS = defineAuditActions('webhooks', [
  'webhook.create',
  'webhook.delete',
  'webhook.disable',
  'webhook.retry',
  'webhook.rotate-secret',
  'webhook.test',
  'webhook.update',
]);
