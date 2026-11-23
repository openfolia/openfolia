import { HttpException } from '@nestjs/common';
import type { ErrorObject } from './json-api.js';

/** An HTTP error with JSON:API error objects; `status` and `title` are filled in. */
export class JsonApiException extends HttpException {
  constructor(
    status: number,
    readonly errors: Omit<ErrorObject, 'status' | 'title'>[],
  ) {
    super(errors.map((e) => e.detail).join('; '), status);
  }
}

/** Thrown when the client's cached copy (`If-None-Match`) is still current. */
export class NotModified extends Error {
  constructor(readonly etag: string) {
    super('not modified');
    this.name = 'NotModified';
  }
}
