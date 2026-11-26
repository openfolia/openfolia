import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/** The releases component's audit actions (`src/audit-actions.ts` registers them). */
export const RELEASE_AUDIT_ACTIONS = defineAuditActions('releases', [
  'maintenance-line.close',
  'maintenance-line.start',
  'release.output-retry',
  'release.outputs-plan',
  'release.publish',
  'release.withdraw',
]);
