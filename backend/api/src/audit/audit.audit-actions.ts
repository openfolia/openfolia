import { defineAuditActions } from './core/audit-action-registry.js';

/**
 * The audit log's own actions (`src/audit-actions.ts` registers them). The reads (#877, kind
 * `read`, `READ_ACTIONS`): `api.read`, a service account's request that changes nothing, and
 * `api.read-gap`, reads of an account that could not be recorded one by one, with their count.
 * `audit-log.prune` is written in SQL, by the retention.
 */
export const AUDIT_LOG_AUDIT_ACTIONS = defineAuditActions('audit', [
  'api.read',
  'api.read-gap',
  'audit-log.export',
  'audit-log.prune',
]);
