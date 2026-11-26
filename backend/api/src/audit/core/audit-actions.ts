import { REGISTERED_AUDIT_ACTIONS } from '../../audit-actions.js';

/** An action from the catalogue. */
export type AuditActionName =
  (typeof REGISTERED_AUDIT_ACTIONS)[number]['action'];

/**
 * Every action the API writes to the audit log, as `<subject>.<verb>`: the
 * catalogue, sorted. Each component registers the ones it writes
 * (`src/audit-actions.ts`, each component's `<component>.audit-actions.ts`).
 * `AuditLog.record` takes only these (`NewAuditEvent`), so an action that
 * writes a new one registers it first, and the editor's translation test
 * (`frontend/editor/tools/i18n.test.mjs`) then asks for its label in every
 * language. An action no longer written stays registered: the log keeps
 * the events it wrote. Includes the ones written in SQL (`role.update` by
 * migrations, `audit-log.prune` by retention).
 */
export const AUDIT_ACTIONS: readonly AuditActionName[] = Object.freeze(
  REGISTERED_AUDIT_ACTIONS.map((a) => a.action).sort(),
);
