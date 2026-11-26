import { defineAuditActions } from '../audit/core/audit-action-registry.js';

/**
 * The change sets' audit actions (`src/audit-actions.ts` registers them): the workflow, the
 * locks, and one `<type>.write` or `<type>.delete` per file a commit changes
 * (`core/commit-recorder.ts`).
 */
export const CHANGE_SET_AUDIT_ACTIONS = defineAuditActions('change-sets', [
  'change-set.abandon',
  'change-set.approve',
  'change-set.carry-forward',
  'change-set.commit',
  'change-set.create',
  'change-set.edit',
  'change-set.merge',
  'change-set.rebase',
  'change-set.refresh',
  'change-set.return',
  'change-set.revert',
  'change-set.sign-off',
  'change-set.submit',
  'config.delete',
  'config.write',
  'design.delete',
  'design.write',
  'lock.acquire',
  'lock.break',
  'lock.release',
  'manual.delete',
  'manual.write',
  'module.delete',
  'module.rename',
  'module.write',
  'template.delete',
  'template.write',
  'term.delete',
  'term.write',
]);
