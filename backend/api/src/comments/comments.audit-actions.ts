import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The comments component's audit actions (`src/audit-actions.ts` registers them). */
export const COMMENT_AUDIT_ACTIONS = defineAuditActions('comments', [
  'comment.create',
  'comment.delete',
  'comment.edit',
  'comment.reopen',
  'comment.resolve',
]);
