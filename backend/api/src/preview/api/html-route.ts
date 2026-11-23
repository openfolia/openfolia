import {
  applyDecorators,
  HttpStatus,
  Injectable,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiNotAcceptableResponse,
  ApiProduces,
  ApiQuery,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import {
  AcceptsQuery,
  QUERY_PARAMETERS,
} from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';

/**
 * What `JsonApiInterceptor` does for JSON:API routes, for a route whose
 * success is `text/html`: 406 unless `Accept` takes it, 400 for query
 * parameters the route does not list (`ref` is listed by `@ReadsContent()`).
 * Errors stay JSON:API documents (`ApiExceptionFilter`).
 */
@Injectable()
export class HtmlRouteInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.accepts('html')) {
      throw new JsonApiException(HttpStatus.NOT_ACCEPTABLE, [
        {
          code: 'not-acceptable',
          detail:
            'This route answers with text/html; the Accept header rules it out.',
        },
      ]);
    }
    const allowed = new Set(
      this.reflector.getAllAndMerge<string[]>(QUERY_PARAMETERS, [
        context.getHandler(),
        context.getClass(),
      ]),
    );
    const unsupported = Object.keys(req.query).filter((k) => !allowed.has(k));
    if (unsupported.length > 0) {
      throw new JsonApiException(
        HttpStatus.BAD_REQUEST,
        unsupported.map((parameter) => ({
          code: 'unsupported-parameter',
          detail: `This route does not support the query parameter "${parameter}".`,
          source: { parameter },
        })),
      );
    }
    return next.handle();
  }
}

/** Marks a route as answering with `text/html`; `queries` are the parameters it takes besides `ref`. */
export const HtmlRoute = (
  ...queries: { name: string; description: string; schema: object }[]
) =>
  applyDecorators(
    UseInterceptors(HtmlRouteInterceptor),
    AcceptsQuery(...queries.map((q) => q.name)),
    ApiProduces('text/html'),
    ApiNotAcceptableResponse({
      description: 'The `Accept` header does not take `text/html`.',
      standardSchema: ErrorDocument,
    }),
    ...queries.map((q) => ApiQuery({ ...q, required: false })),
  );
