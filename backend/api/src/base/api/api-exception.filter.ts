import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { TableTooLargeError } from '@openfolia/content-model';
import type { Response } from 'express';
import {
  ConflictError,
  DomainError,
  FailedError,
  ForbiddenError,
  GoneError,
  InvalidContentError,
  InvalidParameterError,
  NotConfiguredError,
  NotFoundError,
  TABLE_CAPS,
  TooManyRequestsError,
  UnavailableError,
  UnprocessableError,
  UnprocessableProblems,
} from '../core/errors.js';
import { JSON_API, type ErrorObject } from './json-api.js';
import { JsonApiException, NotModified } from './json-api.exception.js';

/** An exception as the API answers it: the status, the error objects and `Retry-After`. */
export interface Mapped {
  status: number;
  errors: Omit<ErrorObject, 'status' | 'title'>[];
  retryAfter?: number;
}

/**
 * Turns every exception into a JSON:API error document. Domain errors get
 * the status that fits them; anything unexpected is logged and answered
 * with a generic 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof NotModified) {
      res.status(HttpStatus.NOT_MODIFIED).setHeader('ETag', exception.etag);
      res.end();
      return;
    }
    const { status, errors, retryAfter } = mapException(exception, this.logger);
    // Content headers may have been set before the handler ran; an error
    // must not inherit them, or a 503 for a commit would be cached for a year.
    res.removeHeader('ETag');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', JSON_API);
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter));
    }
    const title = STATUS_CODES[status] ?? 'Error';
    const body = {
      errors: errors.map((error) => ({
        status: String(status),
        title,
        ...error,
      })),
    };
    // A Buffer, so Express keeps the media type as it is (no charset).
    res.status(status).send(Buffer.from(JSON.stringify(body)));
  }
}

/**
 * The status and error objects an exception is answered with: domain errors get the status that
 * fits them, anything unexpected is logged and answered with a generic 500. Shared by the SCIM
 * routes (#377), which write the same in SCIM's error shape.
 */
export function mapException(exception: unknown, logger: Logger): Mapped {
  if (exception instanceof JsonApiException) {
    return { status: exception.getStatus(), errors: exception.errors };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      errors: [{ code: codeFor(status), detail: exception.message }],
    };
  }
  if (exception instanceof DomainError) return fromDomain(exception);
  // A table past the caps (#686) met by what lays out its grid (a renderer, an export): never
  // content that was validated, so never expected; still the content's fault, not a 500.
  if (exception instanceof TableTooLargeError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      errors: [
        {
          code: 'table-too-large',
          detail: exception.message,
          meta: TABLE_CAPS,
        },
      ],
    };
  }
  logger.error(exception);
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    errors: [{ code: 'internal-error', detail: 'Internal error.' }],
  };
}

function fromDomain(error: DomainError): Mapped {
  if (error instanceof UnprocessableProblems && error.problems.length > 0) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      errors: error.problems.map((problem) => ({
        code: problem.code ?? error.code,
        detail: problem.detail,
        ...(problem.pointer !== undefined && {
          source: { pointer: problem.pointer },
        }),
        ...(problem.meta && { meta: problem.meta }),
      })),
    };
  }
  const object = {
    code: error.code,
    detail: error.message,
    ...(error.meta ? { meta: error.meta } : {}),
  };
  if (error instanceof InvalidParameterError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      errors: [{ ...object, source: { parameter: error.parameter } }],
    };
  }
  if (error instanceof NotFoundError || error instanceof NotConfiguredError) {
    return { status: HttpStatus.NOT_FOUND, errors: [object] };
  }
  if (error instanceof GoneError) {
    return {
      status: HttpStatus.GONE,
      errors: [
        error.parameter === undefined
          ? object
          : { ...object, source: { parameter: error.parameter } },
      ],
    };
  }
  if (error instanceof ForbiddenError) {
    return { status: HttpStatus.FORBIDDEN, errors: [object] };
  }
  if (error instanceof ConflictError) {
    return { status: HttpStatus.CONFLICT, errors: [object] };
  }
  if (
    error instanceof InvalidContentError ||
    error instanceof UnprocessableError ||
    error instanceof UnprocessableProblems
  ) {
    return { status: HttpStatus.UNPROCESSABLE_ENTITY, errors: [object] };
  }
  if (error instanceof UnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errors: [object],
      retryAfter: error.retryAfterSeconds,
    };
  }
  if (error instanceof TooManyRequestsError) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      errors: [object],
      retryAfter: error.retryAfterSeconds,
    };
  }
  if (error instanceof FailedError) {
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, errors: [object] };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, errors: [object] };
}

/** `Not Found` → `not-found`. */
const codeFor = (status: number) =>
  (STATUS_CODES[status] ?? 'error').toLowerCase().replace(/[^a-z0-9]+/g, '-');
