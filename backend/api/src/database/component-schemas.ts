import * as access from '../access/access.schema.js';
import * as assets from '../assets/assets.schema.js';
import * as audit from '../audit/audit.schema.js';
import { AUDIT_SCHEMA_SQL } from '../audit/audit.schema-sql.js';
import * as backups from '../backups/backups.schema.js';
import * as branding from '../branding/branding.schema.js';
import * as changeSets from '../change-sets/change-sets.schema.js';
import { CHANGE_SETS_SCHEMA_SQL } from '../change-sets/change-sets.schema-sql.js';
import * as changes from '../changes/changes.schema.js';
import * as comments from '../comments/comments.schema.js';
import * as imports from '../imports/imports.schema.js';
import * as jobs from '../jobs/jobs.schema.js';
import * as mail from '../mail/mail.schema.js';
import * as modules from '../modules/modules.schema.js';
import * as notifications from '../notifications/notifications.schema.js';
import * as outbox from '../outbox/outbox.schema.js';
import * as preferences from '../preferences/preferences.schema.js';
import * as releases from '../releases/releases.schema.js';
import { RELEASES_SCHEMA_SQL } from '../releases/releases.schema-sql.js';
import * as scim from '../scim/scim.schema.js';
import * as search from '../search/search.schema.js';
import { SEARCH_SCHEMA_SQL } from '../search/search.schema-sql.js';
import * as secrets from '../secrets/secrets.schema.js';
import * as settings from '../settings/settings.schema.js';
import * as storageUsage from '../storage-usage/storage-usage.schema.js';
import { STORAGE_USAGE_SCHEMA_SQL } from '../storage-usage/storage-usage.schema-sql.js';
import * as translations from '../translations/translations.schema.js';
import * as webhooks from '../webhooks/webhooks.schema.js';

/**
 * What a component's migrations write by hand, because drizzle-kit does not track it (an
 * extension, a function, a trigger, a grant, a row the app needs), as it stands now: `before`
 * runs ahead of the tables, `after` once they exist. In `src/<component>/<component>.schema-sql.ts`.
 */
export interface SchemaSql {
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/** One component's part of the database. */
export interface ComponentSchema {
  /** Its schema file's exports (`src/<component>/<component>.schema.ts`): its tables. */
  readonly tables: Readonly<Record<string, unknown>>;
  readonly sql?: SchemaSql;
}

/**
 * Every component that has tables, by its folder in `src/`, the same as `schema.ts` collects (a
 * test holds both the same). The baseline migration (`baseline.ts`) writes the chosen ones' tables
 * and SQL in this order.
 */
export const COMPONENT_SCHEMAS: Readonly<Record<string, ComponentSchema>> = {
  access: { tables: access },
  audit: { tables: audit, sql: AUDIT_SCHEMA_SQL },
  'change-sets': { tables: changeSets, sql: CHANGE_SETS_SCHEMA_SQL },
  assets: { tables: assets },
  comments: { tables: comments },
  outbox: { tables: outbox },
  notifications: { tables: notifications },
  releases: { tables: releases, sql: RELEASES_SCHEMA_SQL },
  modules: { tables: modules },
  translations: { tables: translations },
  imports: { tables: imports },
  webhooks: { tables: webhooks },
  'storage-usage': { tables: storageUsage, sql: STORAGE_USAGE_SCHEMA_SQL },
  secrets: { tables: secrets },
  branding: { tables: branding },
  changes: { tables: changes },
  jobs: { tables: jobs },
  search: { tables: search, sql: SEARCH_SCHEMA_SQL },
  backups: { tables: backups },
  settings: { tables: settings },
  mail: { tables: mail },
  preferences: { tables: preferences },
  scim: { tables: scim },
};
