import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The imports component's audit actions (`src/audit-actions.ts` registers them). */
export const IMPORT_AUDIT_ACTIONS = defineAuditActions('imports', [
  'import.apply',
]);
