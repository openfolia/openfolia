import { defineWebhookEvents } from '../webhooks/core/webhook-event-registry.js';

/** The translations component's webhook events (`src/webhook-events.ts` registers them). */
export const TRANSLATION_WEBHOOK_EVENTS = defineWebhookEvents('translations', [
  {
    type: 'translation.imported',
    topic: 'translation.imported',
    description: 'A translation import committed (#51).',
  },
]);
