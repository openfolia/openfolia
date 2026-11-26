import { ACCESS_NOTIFICATION_KINDS } from './access/access.notification-kinds.js';
import { BACKUP_NOTIFICATION_KINDS } from './backups/backups.notification-kinds.js';
import { CHANGE_SET_NOTIFICATION_KINDS } from './change-sets/change-sets.notification-kinds.js';
import { registerNotificationKinds } from './notifications/core/notification-kind-registry.js';
import { RELEASE_NOTIFICATION_KINDS } from './releases/releases.notification-kinds.js';
import { TRANSLATION_NOTIFICATION_KINDS } from './translations/translations.notification-kinds.js';

/**
 * The groups the notification settings page shows the kinds in, in order (the editor's page has
 * the same): review, releases, translations, and the alerts an administrator acts on.
 */
export const NOTIFICATION_SECTIONS = Object.freeze([
  'review',
  'releases',
  'translations',
  'admin',
] as const);

/** The kinds of thing a notification opens, in the order the API's enum lists them. */
export const NOTIFICATION_SUBJECTS = Object.freeze([
  'change-set',
  'release',
  'import',
  'backup',
  'user',
] as const);

/**
 * Every notification kind there is: each component's own (`<component>.notification-kinds.ts`,
 * the outbox topics it writes that notify someone), registered here once as the API starts, the
 * way `app.module.ts` lists the components. `notifications/` and `preferences/` read them through
 * `notifications/core/notification.ts` and `preferences/core/notification-settings.ts`, and name
 * none of another component's.
 *
 * The order is the one the API's enums, the OpenAPI document and a person's `choices` list the
 * kinds in: a new component's kinds go at the end. A kind registered twice stops the API from
 * starting. Adding a kind: `backend/api/README.md`, "Notifications".
 */
export const REGISTERED_NOTIFICATION_KINDS = registerNotificationKinds(
  [
    CHANGE_SET_NOTIFICATION_KINDS,
    TRANSLATION_NOTIFICATION_KINDS,
    RELEASE_NOTIFICATION_KINDS,
    BACKUP_NOTIFICATION_KINDS,
    ACCESS_NOTIFICATION_KINDS,
  ],
  NOTIFICATION_SECTIONS,
);
