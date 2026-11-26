import { defineNotificationKinds } from '../notifications/core/notification-kind-registry.js';

/**
 * The change sets' notification kinds (`src/notification-kinds.ts` registers them): what is
 * addressed to a person in review (a request, a decision on their change set) by email at once,
 * a broken lock in the bell.
 */
export const CHANGE_SET_NOTIFICATION_KINDS = defineNotificationKinds(
  'change-sets',
  [
    { kind: 'change-set.submit', section: 'review', defaultChoice: 'email' },
    { kind: 'change-set.return', section: 'review', defaultChoice: 'email' },
    { kind: 'change-set.approve', section: 'review', defaultChoice: 'email' },
    { kind: 'change-set.sign-off', section: 'review', defaultChoice: 'email' },
    { kind: 'change-set.merge', section: 'review', defaultChoice: 'email' },
    { kind: 'lock.break', section: 'review', defaultChoice: 'app' },
  ],
);
