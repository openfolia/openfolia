import { defineNotificationKinds } from '../notifications/core/notification-kind-registry.js';

/**
 * The access component's notification kinds (`src/notification-kinds.ts` registers them): a use
 * of the emergency account, which nobody chooses about. Administrators are always told, in the
 * bell and by email (`OutboxSignInEvents`, #378).
 */
export const ACCESS_NOTIFICATION_KINDS = defineNotificationKinds('access', [
  { kind: 'sign-in.break-glass', chosen: false },
]);
