import type { Actor } from './actor.js';

/**
 * Who a request with the shared API token (`CCMS_API_TOKEN`, set only for
 * local use and demo mode) acts as: a service that reads every ref,
 * released or not, and changes nothing. Service accounts (#38) act as
 * themselves (`serviceAccountActor`).
 */
export const API_TOKEN_ACTOR: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:api-token',
  roles: Object.freeze([
    Object.freeze({
      id: 'api-token-reader',
      name: 'API token (read-only)',
      permissions: Object.freeze(['content.read', 'content.read.draft']),
      scope: Object.freeze({}),
    }),
  ]),
}) as Actor;

/** The name shown for a service actor. */
export const API_TOKEN_NAME = 'API token';
