import {
  MAX_MODULE_TABLE_CELLS,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
} from '@openfolia/content-model';

/**
 * Errors the core raises. They name what went wrong in domain terms; the
 * API layer (`ApiExceptionFilter`) decides the HTTP status and shape.
 * `code` is stable and machine-readable; clients may switch on it.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  /** Extra details for clients, sent as the error's `meta`. */
  readonly meta?: Record<string, unknown>;

  constructor(message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (meta) this.meta = meta;
  }
}

/**
 * The requested item does not exist (at this ref). A subclass may name
 * the reason with its own code (`ChangeSetBranchMissingError`); it is
 * still a 404, and still caught as not found.
 */
export class NotFoundError extends DomainError {
  readonly code: string = 'not-found';
}

/**
 * A feature this server is not set up for (e.g. the style review without a
 * model endpoint): answered with 404 `not-configured`, as if the route were
 * not there.
 */
export class NotConfiguredError extends DomainError {
  readonly code = 'not-configured';
}

/**
 * The actor asked too often within a window (a rate limit): answered with
 * 429 and `Retry-After`.
 */
export class TooManyRequestsError extends DomainError {
  readonly code = 'rate-limited';

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, { retryAfter: retryAfterSeconds });
  }
}

/**
 * What a request names was there once and is gone for good (a change
 * feed cursor standing on a commit no longer in the repository): 410,
 * with `source.parameter` when a parameter named it. A subclass names the
 * reason with its own code (`cursor-gone`).
 */
export class GoneError extends DomainError {
  readonly code: string = 'gone';

  constructor(
    message: string,
    readonly parameter?: string,
  ) {
    super(message);
  }
}

/**
 * The actor may not do this: none of its roles holds the permission (for
 * this target). Answered with 403; the message names what was missing.
 */
export class ForbiddenError extends DomainError {
  // A subclass may name the reason with its own code (`derived-source-outside-scope`); still a 403.
  readonly code: string = 'forbidden';
}

/**
 * A query parameter that is well-formed but does not apply to what it
 * names (e.g. a rendition width asked of an SVG). Answered with 400
 * `invalid-parameter` and `source.parameter`.
 */
export class InvalidParameterError extends DomainError {
  // A subclass may name the reason with its own code (`cursor-expired`); still a 400.
  readonly code: string = 'invalid-parameter';

  constructor(
    readonly parameter: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A repository file needed for the answer cannot be parsed or is invalid. A subclass may name
 * the reason with its own code (`TableTooLargeContentError`); it is still a 422, and still
 * caught as content that cannot be read.
 */
export class InvalidContentError extends DomainError {
  readonly code: string = 'invalid-content';

  constructor(
    readonly path: string,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message, { path, ...meta });
  }
}

/**
 * A repository file holds a table past `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS` (#686): refused
 * before its grid was laid out. `meta.columns`, `meta.cells` and `meta.totalCells` are the caps.
 */
export class TableTooLargeContentError extends InvalidContentError {
  override readonly code = 'table-too-large';

  constructor(path: string, message: string) {
    super(path, message, TABLE_CAPS);
  }
}

/** The caps of a table (#686), as a `table-too-large` error's `meta`. */
export const TABLE_CAPS = {
  columns: MAX_TABLE_COLUMNS,
  cells: MAX_TABLE_CELLS,
  totalCells: MAX_MODULE_TABLE_CELLS,
} as const;

/** The request is well-formed but cannot be done, and retrying will not help. */
export class UnprocessableError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message, meta);
  }
}

/** One of the problems of an `UnprocessableProblems`. */
export interface Problem {
  /** Its own stable code, when it differs from the error's. */
  readonly code?: string;
  readonly detail: string;
  /** A JSON pointer to what is at fault (`source.pointer`). */
  readonly pointer?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * Like `UnprocessableError`, with several problems found at once (e.g.
 * every validation error of the content to commit): one error object
 * each, all with `code`.
 */
export class UnprocessableProblems extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    readonly problems: readonly Problem[],
  ) {
    super(message);
  }
}

/**
 * The request conflicts with the current state of what it targets (e.g. a
 * change set that is no longer open): retrying as it is will not help, but
 * after reading the state again it may. Answered with 409.
 */
export class ConflictError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message, meta);
  }
}

/**
 * The database broke off the transaction because it contended with
 * another one (a deadlock, a serialization failure): nothing of it was
 * written to the database. Answered as 409 `lock-contended`; trying again may succeed
 * (`runContended` tries once more by itself).
 */
export class ContendedError extends ConflictError {
  constructor(options?: { cause?: unknown }) {
    super(
      'lock-contended',
      'Another change to the same locks got in the way; try again.',
    );
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Temporarily impossible (load, shutdown); worth retrying later. */
export class UnavailableError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, { retryAfter: retryAfterSeconds });
  }
}

/**
 * A bounded transaction (`UnitOfWork.run` with `bounded`) waited too long
 * for a lock or ran a statement too long, and was rolled back: nothing of
 * it was written to the database. Answered as 503 `database-timeout` with
 * `Retry-After`; another transaction held the rows meanwhile, so trying
 * again later may succeed.
 */
export class TimedOutError extends UnavailableError {
  constructor(options?: { cause?: unknown }) {
    super(
      'database-timeout',
      'The database took too long (a lock held elsewhere, or a slow statement); try again.',
      1,
    );
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A component failed in a way the client cannot fix (e.g. the PDF compiler). */
export class FailedError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message, meta);
  }
}
