import { defineWebhookEvents } from '../webhooks/core/webhook-event-registry.js';

/**
 * The releases component's webhook events (`src/webhook-events.ts` registers them), in two lists
 * only to keep the order subscribers and the webhooks reference have always had them in.
 */
export const RELEASED_WEBHOOK_EVENTS = defineWebhookEvents('releases', [
  {
    type: 'manual.released',
    topic: 'release.published',
    description:
      'A manual a release changed (one per manual, with its languages).',
  },
  {
    type: 'module.released',
    topic: 'release.published',
    description: 'A module a release changed, per language.',
  },
]);

/** The releases component's withdrawal event (`src/webhook-events.ts` registers it). */
export const WITHDRAWN_WEBHOOK_EVENTS = defineWebhookEvents('releases', [
  {
    type: 'release.withdrawn',
    topic: 'release.withdrawn',
    description: 'A release withdrawn.',
  },
]);
