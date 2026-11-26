import { defineNotificationKinds } from '../notifications/core/notification-kind-registry.js';

/** The translations component's notification kinds (`src/notification-kinds.ts` registers them). */
export const TRANSLATION_NOTIFICATION_KINDS = defineNotificationKinds(
  'translations',
  [
    {
      kind: 'translation.imported',
      section: 'translations',
      defaultChoice: 'digest',
    },
    {
      kind: 'translation.import-failed',
      section: 'translations',
      defaultChoice: 'digest',
    },
  ],
);
