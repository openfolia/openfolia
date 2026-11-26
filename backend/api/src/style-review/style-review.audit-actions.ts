import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The style review's audit actions (`src/audit-actions.ts` registers them). */
export const STYLE_REVIEW_AUDIT_ACTIONS = defineAuditActions('style-review', [
  'module.style-review',
]);
