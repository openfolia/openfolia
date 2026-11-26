import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The translations component's audit actions (`src/audit-actions.ts` registers them). */
export const TRANSLATION_AUDIT_ACTIONS = defineAuditActions('translations', [
  'translation-job.cancel',
  'translation-job.export',
  'translation.import',
  'translation.mark-current',
]);
