import { definePermissions } from '../access/core/permission-registry.js';

/** The backups component's permissions (`src/permissions.ts` registers them). */
export const BACKUP_PERMISSIONS = definePermissions('backups', [
  {
    key: 'admin.backups',
    labelKey: 'editor.admin.permissions.adminBackups',
    description:
      "Configure the instance's backups, see their runs and hold the backup key (#529).",
    global: true,
  },
]);
