import type { NestExpressApplication } from '@nestjs/platform-express';
import { JSON_API } from './json-api.js';

/** The largest request body read; a larger one is answered 413. */
export const MAX_BODY = '1mb';

/**
 * Parses JSON:API request bodies (`application/vnd.api+json`, which Nest's
 * own JSON parser does not read). `JsonApiInterceptor` refuses bodies of
 * any other type on JSON:API routes. Call before `init()`/`listen()`.
 */
export function setUpRequestBodies(app: NestExpressApplication): void {
  // And SCIM's (#377), with the plain JSON some directories send: on SCIM's routes only, as
  // `JsonApiInterceptor` refuses both on every other route (`ScimInterceptor`).
  app.useBodyParser('json', {
    type: [JSON_API, 'application/scim+json', 'application/json'],
    limit: MAX_BODY,
  });
}
