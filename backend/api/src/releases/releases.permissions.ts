import { definePermissions } from '../access/core/permission-registry.js';

/** The releases component's permissions (`src/permissions.ts` registers them). */
export const RELEASE_PERMISSIONS = definePermissions('releases', [
  {
    key: 'release.publish',
    labelKey: 'editor.admin.permissions.releasePublish',
    description: 'Cut a release.',
  },
]);
