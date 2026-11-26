import { STATUS_CODES } from 'node:http';
import {
  applyDecorators,
  Catch,
  HttpStatus,
  Injectable,
  Logger,
  StreamableFile,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ApiExtension, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { mapException } from '../../base/api/api-exception.filter.js';
import { mediaTypeOf } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { NotModified } from '../../base/api/json-api.exception.js';
import { TokenOnly } from '../../base/api/token-only.decorator.js';
import { ScimRequestError, UNIQUENESS_CODES } from '../core/scim-errors.js';
import { ERROR_SCHEMA } from '../core/scim-json.js';
import { SCIM_EXTENSION, SCIM_MEDIA_TYPE } from './scim-media.js';

/** The query parameters a SCIM route reads; any other is a 400. */
export const SCIM_QUERY = new Set([
  'filter',
  'startIndex',
  'count',
  'attributes',
  'excludedAttributes',
  // Sorting is not supported (`ServiceProviderConfig`): asked for, it is left out, as the
  // standard lets a server that does not sort.
  'sortBy',
  'sortOrder',
]);

/** Request and response bodies SCIM clients send: SCIM's type, and plain JSON. */
const BODY_TYPES = new Set([SCIM_MEDIA_TYPE, 'application/json']);

/**
 * Content negotiation of the SCIM routes (#377), apart from JSON:API's: 406 unless `Accept`
 * allows `application/scim+json` or `application/json`, 415 for a body of another type, 400
 * for a query parameter SCIM does not define; answers as `application/scim+json` with
 * `Cache-Control: no-store`.
 */
@Injectable()
export class ScimInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const accept = req.headers.accept;
    if (accept && !acceptsScim(accept)) {
      throw new JsonApiException(HttpStatus.NOT_ACCEPTABLE, [
        {
          code: 'not-acceptable',
          detail: `This route answers with ${SCIM_MEDIA_TYPE}; the Accept header rules it out.`,
        },
      ]);
    }
    if (
      hasBody(req) &&
      !BODY_TYPES.has(mediaTypeOf(req.headers['content-type']))
    ) {
      throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
        {
          code: 'unsupported-media-type',
          detail: `Send request bodies as ${SCIM_MEDIA_TYPE} or application/json.`,
        },
      ]);
    }
    const unsupported = Object.keys(req.query).filter(
      (k) => !SCIM_QUERY.has(k),
    );
    if (unsupported.length > 0) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'unsupported-parameter',
          detail: `SCIM routes do not support the query parameter "${unsupported[0]}".`,
        },
      ]);
    }
    res.setHeader('Cache-Control', 'no-store');
    return next.handle().pipe(
      map((body: unknown) =>
        body === undefined && res.statusCode === HttpStatus.NO_CONTENT
          ? undefined
          : new StreamableFile(Buffer.from(JSON.stringify(body)), {
              type: SCIM_MEDIA_TYPE,
            }),
      ),
    );
  }
}

/**
 * Every exception on a SCIM route as SCIM's error (RFC 7644, section 3.12): `{ schemas, status,
 * scimType?, detail }`, with the status the API gives it anywhere (`mapException`) and, for the
 * 400s and 409s the standard names, its `scimType`.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ScimExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof NotModified) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    const { status, errors, retryAfter } = mapException(exception, this.logger);
    const [first] = errors;
    const scimType =
      exception instanceof ScimRequestError
        ? exception.scimType
        : first && UNIQUENESS_CODES.has(first.code)
          ? 'uniqueness'
          : undefined;
    res.removeHeader('ETag');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', SCIM_MEDIA_TYPE);
    if (retryAfter !== undefined)
      res.setHeader('Retry-After', String(retryAfter));
    const body = {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      ...(scimType && { scimType }),
      detail: first?.detail ?? STATUS_CODES[status] ?? 'Error',
    };
    res.status(status).send(Buffer.from(JSON.stringify(body)));
  }
}

/**
 * Marks a controller as SCIM's (#377): authenticated by a bearer token alone (`@TokenOnly()`),
 * negotiated and answered as `application/scim+json` (`ScimInterceptor`), errors in SCIM's shape
 * (`ScimExceptionFilter`), and documented so in the OpenAPI document (`x-openfolia-scim`).
 */
export const Scim = () =>
  applyDecorators(
    TokenOnly(),
    UseInterceptors(ScimInterceptor),
    UseFilters(ScimExceptionFilter),
    ApiProduces(SCIM_MEDIA_TYPE),
    ApiExtension(SCIM_EXTENSION, true),
  );

function acceptsScim(accept: string): boolean {
  return accept.split(',').some((range) => {
    const type = range.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return (
      type === '*/*' ||
      type === 'application/*' ||
      type === SCIM_MEDIA_TYPE ||
      type === 'application/json'
    );
  });
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return (
    (length !== undefined && length !== '0') ||
    req.headers['transfer-encoding'] !== undefined
  );
}
