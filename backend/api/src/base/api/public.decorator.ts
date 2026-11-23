import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const IS_PUBLIC = 'openfolia:public';
/** OpenAPI marker read by `createOpenApiDocument`, which removes it again. */
export const PUBLIC_EXTENSION = 'x-openfolia-public';

/** Marks a route as reachable without the API token (e.g. health checks). */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC, true),
    ApiExtension(PUBLIC_EXTENSION, true),
  );
