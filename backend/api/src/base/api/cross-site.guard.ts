import {
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { JSON_API, REQUEST_HEADER } from './json-api.js';
import {
  BODY_TYPES,
  isJsonApiContentType,
  mediaTypeOf,
} from './json-api.decorators.js';
import { JsonApiException } from './json-api.exception.js';

/** Methods that change nothing; every other method is checked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery: every request that may change state (any
 * method but GET, HEAD and OPTIONS), on every route, public or not, must
 * carry something a cross-site HTML form (or a `fetch` without a CORS
 * preflight) cannot send:
 *
 * - `Content-Type: application/vnd.api+json`, with a body or without one; or
 * - on a route that takes another body type (`@AcceptsBodyOf`), that type
 *   together with `X-Ccms-Request` (the form-safe types `multipart/form-data`,
 *   `application/x-www-form-urlencoded` and `text/plain` need the header).
 *
 * Otherwise 415 (`content-type-required` without a `Content-Type`,
 * `unsupported-media-type` with another one) or 403
 * (`request-header-required`). Registered globally (`APP_GUARD`), so a new
 * route is covered without opting in.
 */
@Injectable()
export class CrossSiteRequestGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    const contentType = req.headers['content-type'];
    if (isJsonApiContentType(contentType)) return true;

    const bodyTypes =
      this.reflector.getAllAndMerge<string[]>(BODY_TYPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (contentType && bodyTypes.includes(mediaTypeOf(contentType))) {
      const header = req.headers[REQUEST_HEADER.toLowerCase()];
      if (typeof header === 'string' && header.trim() !== '') return true;
      throw new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'request-header-required',
          detail: `A ${mediaTypeOf(contentType)} request to this route needs the ${REQUEST_HEADER} header.`,
        },
      ]);
    }
    const accepted = [JSON_API, ...bodyTypes].join(' or ');
    throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
      contentType
        ? {
            code: 'unsupported-media-type',
            detail: `Send ${req.method} requests as ${accepted}, without extensions.`,
          }
        : {
            code: 'content-type-required',
            detail: `A ${req.method} request needs Content-Type: ${accepted}, also without a body.`,
          },
    ]);
  }
}
