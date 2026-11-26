/**
 * The database schema: every component's tables, re-exported from its schema file
 * (`src/<component>/<component>.schema.ts`, which re-exports the component's
 * `repos/<name>.tables.ts`). drizzle-kit reads this file to generate migrations; `Database`
 * passes it to Drizzle so relational queries know the tables. A component listed here is listed
 * in `component-schemas.ts` too (a test holds both the same), which the baseline migration reads.
 */
export * from '../access/access.schema.js';
export * from '../audit/audit.schema.js';
export * from '../change-sets/change-sets.schema.js';
export * from '../assets/assets.schema.js';
export * from '../comments/comments.schema.js';
export * from '../outbox/outbox.schema.js';
export * from '../notifications/notifications.schema.js';
export * from '../releases/releases.schema.js';
export * from '../modules/modules.schema.js';
export * from '../translations/translations.schema.js';
export * from '../imports/imports.schema.js';
export * from '../webhooks/webhooks.schema.js';
export * from '../storage-usage/storage-usage.schema.js';
export * from '../secrets/secrets.schema.js';
export * from '../branding/branding.schema.js';
export * from '../changes/changes.schema.js';
export * from '../jobs/jobs.schema.js';
export * from '../search/search.schema.js';
export * from '../backups/backups.schema.js';
export * from '../settings/settings.schema.js';
export * from '../mail/mail.schema.js';
export * from '../preferences/preferences.schema.js';
export * from '../scim/scim.schema.js';
