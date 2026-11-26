import {
  HttpStatus,
  Injectable,
  SetMetadata,
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
import { TOKEN_ONLY } from './token-only.decorator.js';

export const OWN_AUTHORITY = 'openfolia:own-authority';

/**
 * Marks a public route whose request carries its own authority in its path (a sealed token
 * that names exactly what it may change) and that uses no ambient credential (no session
 * cookie, no token, no actor): a forged cross-site request can do nothing that the token's
 * holder could not already do. `CrossSiteRequestGuard` lets it take any body type without
 * `X-Ccms-Request`, so a mail provider can POST to it as RFC 8058 says (#884: the one-click
 * unsubscribe). Only for such routes.
 */
export const CarriesOwnAuthority = () => SetMetadata(OWN_AUTHORITY, true);

/** Methods that change nothing; every other method is checked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CROSS_SITE_FORM = 'openfolia:cross-site-form';
const FORM = 'application/x-www-form-urlencoded';

/**
 * A route a form posted from another site comes to by design (SAML's HTTP-POST binding, the
 * identity provider's answer, #376): `application/x-www-form-urlencoded` without
 * `X-Ccms-Request`. Only for a route that acts as nobody (`@Public()`) and trusts nothing of the
 * request but what it checks itself (a signed assertion).
 */
export const AcceptsCrossSiteForm = () => SetMetadata(CROSS_SITE_FORM, true);

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
 * A route marked `@AcceptsCrossSiteForm()` takes a plain form too, one marked
 * `@CarriesOwnAuthority()` any body type.
 *
 * Otherwise 415 (`content-type-required` without a `Content-Type`,
 * `unsupported-media-type` with another one) or 403
 * (`request-header-required`). Registered globally (`APP_GUARD`), so a new
 * route is covered without opting in. A `@TokenOnly()` route is let through: it reads no cookie,
 * so a forged request carries nothing it could act with.
 */
@Injectable()
export class CrossSiteRequestGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    // No ambient credential reaches a route a token alone authenticates (`@TokenOnly()`): a
    // cross-site request cannot set `Authorization`, so it can do nothing there.
    if (
      this.reflector.getAllAndOverride<boolean>(TOKEN_ONLY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const contentType = req.headers['content-type'];
    if (isJsonApiContentType(contentType)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(OWN_AUTHORITY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }
    if (
      mediaTypeOf(contentType) === FORM &&
      this.reflector.getAllAndOverride<boolean>(CROSS_SITE_FORM, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }

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
