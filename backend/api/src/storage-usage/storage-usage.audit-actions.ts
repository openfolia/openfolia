import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The storage usage component's audit actions (`src/audit-actions.ts` registers them). */
export const STORAGE_AUDIT_ACTIONS = defineAuditActions('storage-usage', [
  'storage.limit-change',
  'storage.upload-refused',
]);
