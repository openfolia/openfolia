import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The backups component's audit actions (`src/audit-actions.ts` registers them). */
export const BACKUP_AUDIT_ACTIONS = defineAuditActions('backups', [
  'backup-key.create',
  'backup-key.rotate',
  'backup-settings.update',
  'backup.request',
]);
