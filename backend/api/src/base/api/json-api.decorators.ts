import {
  applyDecorators,
  createParamDecorator,
  HttpStatus,
  Injectable,
  SetMetadata,
  StreamableFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiExtension,
  ApiHeader,
  ApiProduces,
  ApiQuery,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { concatMap, map, type Observable } from 'rxjs';
import { GetPeopleAction } from '../../access/core/actions/get-people.action.js';
import type { Actor } from '../../access/core/actor.js';
import type { PageRequest } from '../core/paging.js';
import { JSON_API, REQUEST_HEADER } from './json-api.js';
import { JsonApiException } from './json-api.exception.js';
import { NAMES_PEOPLE, peopleIn } from './people.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const QUERY_PARAMETERS = 'openfolia:query-parameters';
export const BODY_TYPES = 'openfolia:body-types';
/** OpenAPI marker read by `createOpenApiDocument`, which removes it again. */
export const JSON_API_EXTENSION = 'x-openfolia-json-api';

/**
 * Declares query parameters a route accepts; the JSON:API interceptor
 * rejects any other. Adds to what other decorators declared.
 */
export function AcceptsQuery(...names: string[]) {
  return (
    target: object,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const where = (descriptor?.value as object | undefined) ?? target;
    const before =
      (Reflect.getMetadata(QUERY_PARAMETERS, where) as string[] | undefined) ??
      [];
    Reflect.defineMetadata(QUERY_PARAMETERS, [...before, ...names], where);
  };
}

/**
 * Lets a JSON:API route take request bodies of these media types too (e.g.
 * `multipart/form-data`, without parameters, lowercase), which it reads
 * and checks itself: no body parser reads them. A request of such a type
 * also needs `X-Ccms-Request` (`CrossSiteRequestGuard`).
 */
export const AcceptsBodyOf = (...types: string[]) =>
  applyDecorators(
    SetMetadata(BODY_TYPES, types),
    ApiHeader({
      name: REQUEST_HEADER,
      required: false,
      description: `Required (any non-empty value) with a body of type ${types.join(' or ')}: a cross-site form cannot send it. Not needed with ${JSON_API}.`,
      schema: { type: 'string' },
    }),
  );

/**
 * Content negotiation and query checks for JSON:API routes:
 * 406 unless `Accept` allows `application/vnd.api+json`, 415 for a body of
 * another type, 400 for query parameters the route does not support. On a
 * route marked `@NamesPeople()`, adds `meta.people` to the document.
 */
@Injectable()
export class JsonApiInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly getPeople: GetPeopleAction,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();

    const accept = req.headers.accept;
    if (accept && !acceptsJsonApi(accept)) {
      throw new JsonApiException(HttpStatus.NOT_ACCEPTABLE, [
        {
          code: 'not-acceptable',
          detail: `This route answers with ${JSON_API}; the Accept header rules it out.`,
        },
      ]);
    }
    const bodyTypes = this.reflector.getAllAndMerge<string[]>(BODY_TYPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    const contentType = req.headers['content-type'];
    if (
      hasBody(req) &&
      !isJsonApiContentType(contentType) &&
      !bodyTypes.includes(mediaTypeOf(contentType))
    ) {
      throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
        {
          code: 'unsupported-media-type',
          detail: `Send request bodies as ${[JSON_API, ...bodyTypes].join(' or ')}, without extensions.`,
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
    const namesPeople = this.reflector.getAllAndOverride<boolean | undefined>(
      NAMES_PEOPLE,
      [context.getHandler(), context.getClass()],
    );
    const answer = namesPeople
      ? next.handle().pipe(concatMap((body) => this.withPeople(req, body)))
      : next.handle();
    // Serialized here: Express would append `; charset=utf-8`, which
    // JSON:API does not allow on its media type. No body stays none on a
    // 204 only: elsewhere a missing body is a bug, and fails loudly.
    return answer.pipe(
      map((body: unknown) =>
        body === undefined &&
        http.getResponse<Response>().statusCode === HttpStatus.NO_CONTENT
          ? undefined
          : jsonApiBody(body),
      ),
    );
  }

  /** The document with `meta.people` (`@NamesPeople()`); no document stays none. */
  private async withPeople(req: Request, body: unknown): Promise<unknown> {
    if (typeof body !== 'object' || body === null) return body;
    const people = await this.getPeople.handle({
      // Set by `ActorGuard`. Without one (a public route) the action refuses.
      actor: req.actor as Actor,
      userIds: peopleIn(body),
    });
    return {
      ...body,
      meta: { ...('meta' in body ? (body.meta as object) : {}), people },
    };
  }
}

/** Marks a controller as answering with JSON:API documents. */
export const JsonApi = () =>
  applyDecorators(
    UseInterceptors(JsonApiInterceptor),
    ApiProduces(JSON_API),
    ApiExtension(JSON_API_EXTENSION, true),
  );

/** Supports `filter[<name>]` for each name; read it with `@Query('filter[<name>]', { schema })`. */
export const Filters = (...filters: { name: string; description: string }[]) =>
  applyDecorators(
    AcceptsQuery(...filters.map((f) => `filter[${f.name}]`)),
    ...filters.map((f) =>
      ApiQuery({
        name: `filter[${f.name}]`,
        required: false,
        description: f.description,
        schema: { type: 'string' },
      }),
    ),
  );

/** Supports `page[number]` and `page[size]`; read them with `@PageParams()`. */
export const Paged = () =>
  applyDecorators(
    AcceptsQuery('page[number]', 'page[size]'),
    ApiQuery({
      name: 'page[number]',
      required: false,
      description: 'Page to return, from 1. Default: 1.',
      schema: { type: 'integer', minimum: 1 },
    }),
    ApiQuery({
      name: 'page[size]',
      required: false,
      description: `Resources per page. Default: ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}.`,
      schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
    }),
  );

/** The requested page; see `@Paged()`. */
export const PageParams = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PageRequest => {
    const query = context.switchToHttp().getRequest<Request>().query;
    return {
      number: wholeNumber(query, 'page[number]', 1, Number.MAX_SAFE_INTEGER, 1),
      size: wholeNumber(
        query,
        'page[size]',
        1,
        MAX_PAGE_SIZE,
        DEFAULT_PAGE_SIZE,
      ),
    };
  },
);

function wholeNumber(
  query: Request['query'],
  parameter: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = query[parameter];
  if (value === undefined) return fallback;
  const number =
    typeof value === 'string' && /^\d{1,16}$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (number >= min && number <= max) return number;
  throw new JsonApiException(HttpStatus.BAD_REQUEST, [
    {
      code: 'invalid-parameter',
      detail: `Must be a whole number from ${min} to ${max}.`,
      source: { parameter },
    },
  ]);
}

/** A JSON:API response body with exactly the JSON:API media type. */
export function jsonApiBody(body: unknown): StreamableFile {
  return new StreamableFile(Buffer.from(JSON.stringify(body)), {
    type: JSON_API,
  });
}

function acceptsJsonApi(accept: string): boolean {
  return accept.split(',').some((range) => {
    const [type = '', ...params] = range.split(';').map((p) => p.trim());
    if (type === '*/*' || type === 'application/*') return true;
    // JSON:API: a media type with parameters (other than q) asks for an
    // extension or profile this server does not offer.
    return (
      type.toLowerCase() === JSON_API &&
      params.every((p) => p.toLowerCase().startsWith('q='))
    );
  });
}

/** The bare media type, lowercase: `Multipart/Form-Data; boundary=x` is `multipart/form-data`. */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** `application/vnd.api+json`, with at most `profile` parameters (no extensions). */
export function isJsonApiContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const [type = '', ...params] = contentType.split(';').map((p) => p.trim());
  return (
    type.toLowerCase() === JSON_API &&
    params.every((p) => p.toLowerCase().startsWith('profile='))
  );
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return (
    (length !== undefined && length !== '0') ||
    req.headers['transfer-encoding'] !== undefined
  );
}
