import { definePermissions } from '../access/core/permission-registry.js';

/** The SCIM component's permissions (`src/permissions.ts` registers them). */
export const SCIM_PERMISSIONS = definePermissions('scim', [
  {
    key: 'scim.provision',
    labelKey: 'editor.admin.permissions.scimProvision',
    description:
      "Provision users and groups from a directory over SCIM 2.0 (#377): held by the service account a directory's token belongs to, and only there (`/scim/v2` refuses anyone else).",
    global: true,
  },
]);
