import { ApiExtension } from '@nestjs/swagger';

/** The OpenAPI extension that puts an operation into an audience's document. */
export const AUDIENCE_EXTENSION = 'x-audience';
export const DELIVERY_AUDIENCE = 'delivery';

/**
 * Marks a route as part of the delivery API: the read routes a consumer
 * building their own viewer or integration needs, published as
 * `/openapi/delivery.json`. An explicit opt-in per route, never derived
 * from the permission. `tests/delivery-api.e2e.spec.ts` fails for a delivery route
 * that is not a `GET` or `HEAD`, or needs more than `content.read`.
 */
export const DeliveryApi = () =>
  ApiExtension(AUDIENCE_EXTENSION, DELIVERY_AUDIENCE);

/**
 * Query parameters of delivery routes that only authors use (a change set's
 * working copies, #237): left out of the delivery document, which names no
 * authoring feature. The route still takes them, with their own checks.
 */
export const AUTHORING_PARAMETERS: ReadonlySet<string> = new Set([
  'workingCopy',
]);
