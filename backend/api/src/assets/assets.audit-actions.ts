import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The assets component's audit actions (`src/audit-actions.ts` registers them). */
export const ASSET_AUDIT_ACTIONS = defineAuditActions('assets', [
  'asset.delete',
  'asset.upload',
]);
