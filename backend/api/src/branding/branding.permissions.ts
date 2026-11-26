import { definePermissions } from '../access/core/permission-registry.js';

/** The branding component's permissions (`src/permissions.ts` registers them). */
export const BRANDING_PERMISSIONS = definePermissions('branding', [
  {
    key: 'admin.branding',
    labelKey: 'editor.admin.permissions.adminBranding',
    description:
      "Set the platform's branding: name, logos, icons and colours (#169).",
    global: true,
  },
]);
