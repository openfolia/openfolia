import { DEPRECATION_WEBHOOK_EVENTS } from './change-sets/change-sets.webhook-events.js';
import {
  RELEASED_WEBHOOK_EVENTS,
  WITHDRAWN_WEBHOOK_EVENTS,
} from './releases/releases.webhook-events.js';
import { TRANSLATION_WEBHOOK_EVENTS } from './translations/translations.webhook-events.js';
import { registerWebhookEvents } from './webhooks/core/webhook-event-registry.js';

/**
 * Every webhook event there is: each component's own (`<component>.webhook-events.ts`),
 * registered here once as the API starts, the way `app.module.ts` lists the components.
 * `webhooks/` reads them through `webhooks/core/webhook.ts` and names none of another
 * component's.
 *
 * The order is the one the API's enum, the OpenAPI document and the webhooks reference list the
 * events in: a new event goes at the end. A type registered twice stops the API from starting.
 * Adding an event: `backend/api/README.md`, "Webhooks".
 */
export const REGISTERED_WEBHOOK_EVENTS = registerWebhookEvents([
  RELEASED_WEBHOOK_EVENTS,
  DEPRECATION_WEBHOOK_EVENTS,
  WITHDRAWN_WEBHOOK_EVENTS,
  TRANSLATION_WEBHOOK_EVENTS,
]);
