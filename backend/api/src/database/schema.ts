/**
 * The database schema: every Drizzle table, re-exported from its
 * component's `repos/` folder (e.g. `export * from '../audit/repos/audit.tables.js'`).
 * drizzle-kit reads this file to generate migrations; `Database` passes it
 * to Drizzle so relational queries know the tables.
 */
export * from '../access/repos/access.tables.js';
export * from '../access/repos/service-accounts.tables.js';
export * from '../access/repos/sign-in.tables.js';
export * from '../access/repos/passwords.tables.js';
export * from '../access/repos/email-codes.tables.js';
export * from '../audit/repos/audit.tables.js';
export * from '../change-sets/repos/change-sets.tables.js';
export * from '../change-sets/repos/locks.tables.js';
export * from '../change-sets/repos/working-copies.tables.js';
export * from '../change-sets/repos/outbox.tables.js';
export * from '../change-sets/repos/change-set-approvals.tables.js';
export * from '../change-sets/repos/commit-intents.tables.js';
export * from '../change-sets/repos/carry-forwards.tables.js';
export * from '../change-sets/repos/supersessions.tables.js';
export * from '../change-sets/repos/refresh-conflicts.tables.js';
export * from '../assets/repos/asset-uploads.tables.js';
export * from '../assets/repos/asset-renditions.tables.js';
export * from '../assets/repos/asset-deletions.tables.js';
export * from '../assets/repos/asset-references.tables.js';
export * from '../comments/repos/comments.tables.js';
export * from '../outbox/repos/outbox-consumers.tables.js';
export * from '../notifications/repos/notifications.tables.js';
export * from '../releases/repos/releases.tables.js';
export * from '../releases/repos/maintenance-lines.tables.js';
export * from '../modules/repos/module-index.tables.js';
export * from '../translations/repos/translations.tables.js';
export * from '../imports/repos/imports.tables.js';
export * from '../webhooks/repos/webhooks.tables.js';
export * from '../storage-usage/repos/storage-usage.tables.js';
export * from '../secrets/repos/secrets.tables.js';
export * from '../releases/repos/release-diffs.tables.js';
export * from '../branding/repos/branding.tables.js';
export * from '../changes/repos/change-feed.tables.js';
export * from '../jobs/repos/job-consumers.tables.js';
export * from '../search/repos/search-index.tables.js';
export * from '../backups/repos/backups.tables.js';
export * from '../settings/repos/installation-settings.tables.js';
export * from '../mail/repos/mail.tables.js';
export * from '../preferences/repos/preferences.tables.js';
