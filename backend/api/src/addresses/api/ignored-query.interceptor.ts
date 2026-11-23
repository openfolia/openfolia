import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { QUERY_PARAMETERS } from '../../base/api/json-api.decorators.js';
import {
  StableAddressSettings,
  withoutIgnored,
} from '../core/stable-address.js';

/**
 * Drops the query parameters a stable address ignores (`CCMS_DELIVERY_IGNORED_QUERY`, #553:
 * the tracking parameters a shared link picks up) from the request before the route sees it,
 * so `/d/…?utm_source=x` answers as `/d/…` does. Only these: every other parameter the route
 * does not take is still a 400 (`unsupported-parameter`), and a parameter the route takes
 * (`theme`) is never dropped. These are reader-facing addresses, not the JSON:API; the rest of
 * the API ignores nothing. On the controller, so it runs before the routes' own interceptors.
 */
@Injectable()
export class IgnoredQueryInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: StableAddressSettings,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const at = req.url.indexOf('?');
    if (at >= 0) {
      const keep = new Set(
        this.reflector.getAllAndMerge<string[]>(QUERY_PARAMETERS, [
          context.getHandler(),
          context.getClass(),
        ]),
      );
      const query = req.url.slice(at + 1);
      const kept = withoutIgnored(query, this.settings.ignoredQuery, keep);
      if (kept !== query) {
        // Express parses `req.query` from the URL on each read.
        req.url =
          kept === ''
            ? req.url.slice(0, at)
            : `${req.url.slice(0, at)}?${kept}`;
      }
    }
    return next.handle();
  }
}
