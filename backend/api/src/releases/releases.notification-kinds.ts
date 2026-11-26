import { defineNotificationKinds } from '../notifications/core/notification-kind-registry.js';

/**
 * The releases component's notification kinds (`src/notification-kinds.ts` registers them): a
 * release's file that failed is an alert an administrator acts on, by email at once.
 */
export const RELEASE_NOTIFICATION_KINDS = defineNotificationKinds('releases', [
  { kind: 'release.published', section: 'releases', defaultChoice: 'digest' },
  { kind: 'release.output-failed', section: 'admin', defaultChoice: 'email' },
  {
    kind: 'release.output-recovered',
    section: 'releases',
    defaultChoice: 'digest',
  },
]);
