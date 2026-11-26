import { ACCESS_PERMISSIONS } from './access/access.permissions.js';
import { registerPermissions } from './access/core/permission-registry.js';
import { BACKUP_PERMISSIONS } from './backups/backups.permissions.js';
import { BRANDING_PERMISSIONS } from './branding/branding.permissions.js';
import { CONTENT_PERMISSIONS } from './content/content.permissions.js';
import { RELEASE_PERMISSIONS } from './releases/releases.permissions.js';
import { SCIM_PERMISSIONS } from './scim/scim.permissions.js';
import { TRANSLATION_PERMISSIONS } from './translations/translations.permissions.js';
import { WEBHOOK_PERMISSIONS } from './webhooks/webhooks.permissions.js';

/**
 * Every permission there is: each component's own (`<component>.permissions.ts`), registered
 * here once as the API starts, the way `app.module.ts` lists the components. `access/` reads them
 * through `access/core/permissions.ts` and names none of another component's.
 *
 * The order is the one roles store and answer permissions in (and the editor and the permissions
 * reference list them in): a new component's group goes at the end. A key registered twice stops
 * the API from starting. Adding, renaming or removing a permission: `backend/api/README.md`,
 * "Users, roles and permissions".
 */
export const REGISTERED_PERMISSIONS = registerPermissions([
  CONTENT_PERMISSIONS,
  RELEASE_PERMISSIONS,
  TRANSLATION_PERMISSIONS,
  WEBHOOK_PERMISSIONS,
  ACCESS_PERMISSIONS,
  BRANDING_PERMISSIONS,
  BACKUP_PERMISSIONS,
  SCIM_PERMISSIONS,
]);
