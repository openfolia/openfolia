import { definePermissions } from '../access/core/permission-registry.js';

/** The translations component's permissions (`src/permissions.ts` registers them). */
export const TRANSLATION_PERMISSIONS = definePermissions('translations', [
  {
    key: 'translation.manage',
    labelKey: 'editor.admin.permissions.translationManage',
    description: 'Order and accept translations.',
  },
]);
