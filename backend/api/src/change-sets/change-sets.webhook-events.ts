import { defineWebhookEvents } from '../webhooks/core/webhook-event-registry.js';

/**
 * The change sets' webhook events (`src/webhook-events.ts` registers them): a merge into `main`
 * writes a deprecation's outbox row (`core/deprecation-events.ts`, #266).
 */
export const DEPRECATION_WEBHOOK_EVENTS = defineWebhookEvents('change-sets', [
  {
    type: 'module.deprecated',
    topic: 'module.deprecated',
    description: 'A module deprecated on `main`.',
  },
  {
    type: 'manual.deprecated',
    topic: 'manual.deprecated',
    description: 'A manual deprecated on `main` (sent since #558).',
  },
]);
