import { definePermissions } from '../access/core/permission-registry.js';

/** The webhooks component's permissions (`src/permissions.ts` registers them). */
export const WEBHOOK_PERMISSIONS = definePermissions('webhooks', [
  {
    key: 'webhook.manage',
    labelKey: 'editor.admin.permissions.webhookManage',
    description: 'Configure webhooks.',
    global: true,
  },
]);
