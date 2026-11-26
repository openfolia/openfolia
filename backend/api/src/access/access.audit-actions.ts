import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/**
 * The access component's audit actions (`src/audit-actions.ts` registers them). `role.update` is
 * also written in SQL, by migrations that grant a new permission.
 */
export const ACCESS_AUDIT_ACTIONS = defineAuditActions('access', [
  'group-mapping.create',
  'group-mapping.delete',
  'role.assign',
  'role.create',
  'role.delete',
  'role.unassign',
  'role.update',
  'service-account.create',
  'service-account.deactivate',
  'service-account.reactivate',
  'service-account.update',
  'service-token.issue',
  'service-token.revoke',
  'settings.sign-ins-ended',
  'user.break-glass-sign-in',
  'user.create',
  'user.deactivate',
  'user.email-code-requested',
  'user.identity-link',
  'user.invite',
  'user.invite-withdraw',
  'user.password-changed',
  'user.password-reset-requested',
  'user.password-set',
  'user.reactivate',
  'user.second-factor-off',
  'user.second-factor-on',
  'user.second-factor-recovery-codes',
  'user.second-factor-reset',
  'user.sign-in',
  'user.sign-out',
  'user.update',
]);
