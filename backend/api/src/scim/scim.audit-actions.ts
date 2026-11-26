import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/**
 * The SCIM component's audit actions (`src/audit-actions.ts` registers them). Provisioning also
 * writes access's `user.create`, `user.update` and `user.identity-link`.
 */
export const SCIM_AUDIT_ACTIONS = defineAuditActions('scim', [
  'scim-group.create',
  'scim-group.delete',
  'scim-group.update',
  'user.identity-unlink',
]);
