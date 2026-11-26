import { ACCESS_AUDIT_ACTIONS } from './access/access.audit-actions.js';
import { ASSET_AUDIT_ACTIONS } from './assets/assets.audit-actions.js';
import { AUDIT_LOG_AUDIT_ACTIONS } from './audit/audit.audit-actions.js';
import { registerAuditActions } from './audit/core/audit-action-registry.js';
import { BACKUP_AUDIT_ACTIONS } from './backups/backups.audit-actions.js';
import { BRANDING_AUDIT_ACTIONS } from './branding/branding.audit-actions.js';
import { CHANGE_SET_AUDIT_ACTIONS } from './change-sets/change-sets.audit-actions.js';
import { COMMENT_AUDIT_ACTIONS } from './comments/comments.audit-actions.js';
import { IMPORT_AUDIT_ACTIONS } from './imports/imports.audit-actions.js';
import { MAIL_AUDIT_ACTIONS } from './mail/mail.audit-actions.js';
import { NOTIFICATION_AUDIT_ACTIONS } from './notifications/notifications.audit-actions.js';
import { RELEASE_AUDIT_ACTIONS } from './releases/releases.audit-actions.js';
import { SCIM_AUDIT_ACTIONS } from './scim/scim.audit-actions.js';
import { SETTINGS_AUDIT_ACTIONS } from './settings/settings.audit-actions.js';
import { STORAGE_AUDIT_ACTIONS } from './storage-usage/storage-usage.audit-actions.js';
import { STYLE_REVIEW_AUDIT_ACTIONS } from './style-review/style-review.audit-actions.js';
import { TRANSLATION_AUDIT_ACTIONS } from './translations/translations.audit-actions.js';
import { WEBHOOK_AUDIT_ACTIONS } from './webhooks/webhooks.audit-actions.js';

/**
 * Every action the API writes to the audit log: each component's own
 * (`<component>.audit-actions.ts`), registered here once as the API starts, the way
 * `app.module.ts` lists the components. `audit/` reads them through `audit/core/audit-actions.ts`
 * (sorted, whatever the order here) and names none of another component's. An action registered
 * twice stops the API from starting. Adding an action: `backend/api/README.md`, "Audit log".
 */
export const REGISTERED_AUDIT_ACTIONS = registerAuditActions([
  ACCESS_AUDIT_ACTIONS,
  ASSET_AUDIT_ACTIONS,
  AUDIT_LOG_AUDIT_ACTIONS,
  BACKUP_AUDIT_ACTIONS,
  BRANDING_AUDIT_ACTIONS,
  CHANGE_SET_AUDIT_ACTIONS,
  COMMENT_AUDIT_ACTIONS,
  IMPORT_AUDIT_ACTIONS,
  MAIL_AUDIT_ACTIONS,
  NOTIFICATION_AUDIT_ACTIONS,
  RELEASE_AUDIT_ACTIONS,
  SCIM_AUDIT_ACTIONS,
  SETTINGS_AUDIT_ACTIONS,
  STORAGE_AUDIT_ACTIONS,
  STYLE_REVIEW_AUDIT_ACTIONS,
  TRANSLATION_AUDIT_ACTIONS,
  WEBHOOK_AUDIT_ACTIONS,
]);
