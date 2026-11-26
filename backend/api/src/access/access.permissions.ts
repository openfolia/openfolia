import { definePermissions } from './core/permission-registry.js';

/** The access component's own permissions (`src/permissions.ts` registers them). */
export const ACCESS_PERMISSIONS = definePermissions('access', [
  {
    key: 'admin.roles',
    labelKey: 'editor.admin.permissions.adminRoles',
    description: 'Define roles and assign them.',
    global: true,
  },
]);
