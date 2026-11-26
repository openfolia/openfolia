import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/**
 * The installation settings' audit actions (`src/audit-actions.ts` registers them). Ending every
 * sign-in (`settings.sign-ins-ended`) is access's.
 */
export const SETTINGS_AUDIT_ACTIONS = defineAuditActions('settings', [
  'settings.break-glass',
  'settings.second-factor',
  'settings.self-approval',
  'settings.session-limits',
  'settings.single-sign-on',
]);
