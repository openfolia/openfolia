import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The branding component's audit actions (`src/audit-actions.ts` registers them). */
export const BRANDING_AUDIT_ACTIONS = defineAuditActions('branding', [
  'branding.image-delete',
  'branding.image-upload',
  'branding.update',
]);
