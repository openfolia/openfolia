import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  AcceptsQuery,
  DEFAULT_PAGE_SIZE,
  JsonApi,
  MAX_PAGE_SIZE,
  PageParams,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ReadChangesAction } from '../core/actions/read-changes.action.js';
import { ChangePageDocument, toChangeResource } from './change.resources.js';

/** A sealed cursor as the feed hands them out: base64url parts joined by dots, at most 4 KiB. */
export const Cursor = z
  .string()
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'a cursor the feed gave');

/**
 * The change feed (#43): what was released, withdrawn or deprecated since
 * a cursor, as you may read it, for consumers that were down or start
 * fresh. Part of the delivery API.
 */
@ApiTags('changes')
@Controller('changes')
@JsonApi()
export class ChangesController {
  constructor(private readonly readChanges: ReadChangesAction) {}

  @Get()
  @DeliveryApi()
  @AcceptsQuery('page[cursor]', 'page[size]')
  @ApiQuery({
    name: 'page[cursor]',
    required: false,
    description:
      'Where to go on: `meta.page.cursor` of the page before. Left out: start with a snapshot of every chunk you may read at the release standing now, then the changes after it. A cursor that can no longer be read (the server’s secret key changed, it was issued to someone else) is a 400 `cursor-expired`: start again without one. A cursor standing on content gone from the repository is a 410 `cursor-gone`: resync.',
    schema: { type: 'string' },
  })
  @ApiQuery({
    name: 'page[size]',
    required: false,
    description: `The most events to answer. Default: ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}.`,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
  })
  @ApiOperation({
    summary: 'Read the change feed',
    description:
      'Releases, withdrawals and deprecations (of modules and of manuals) in the order they happened, as events: the webhook events (the same shapes and idempotency keys), and per release the chunks (`GET /chunks`) to store (`chunk.upserted`) and to drop (`chunk.removed`), so a retrieval index stays in sync. Cursor-paged: no event is skipped or told twice across pages, whatever is released meanwhile. Scoped to what you may read now: when your scope narrows, the chunks you may no longer read come as `chunk.removed`, to you only; nothing names what you never could read. Needs the `content.read` permission and the instance secret key (else 404 `not-configured`).',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ChangePageDocument })
  @ApiBadRequestResponse({
    description:
      '`cursor-expired`: the cursor can no longer be read (the instance key was rotated, it was issued to someone else, it was changed, or it was made by an older way of cutting chunks): start again without one. `invalid-parameter`: a malformed cursor or size. `unsupported-parameter`: any other query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-configured`: the server has no instance secret key, which seals the cursors.',
    standardSchema: ErrorDocument,
  })
  @ApiGoneResponse({
    description:
      '`cursor-gone`: the cursor stands on chunks that can no longer be read (the commit of a release you hold is gone from the repository after a history rewrite, or its content no longer reads), so what to remove cannot be named; or it is from before the server’s database was restored from another server (#619). Resync: drop what you stored and start again without `page[cursor]` (a snapshot follows), or rebuild from a release tag (`GET /chunks?ref=<tag>`, keeping what has the same `contentHash`) and then start again without `page[cursor]`.',
    standardSchema: ErrorDocument,
  })
  @ApiTooManyRequestsResponse({
    description:
      '`rate-limited`: a page is being read for you already (`Retry-After`): one at a time.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`outbox-blocked`: the server’s database was restored from another server and its operator has not finished the restore yet, so reading on could skip events (`Retry-After`): try again later with the same cursor.',
    standardSchema: ErrorDocument,
  })
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    // Only `page[size]` of it: `page[number]` is refused (`AcceptsQuery`).
    @PageParams() { size: perPage }: PageRequest,
    @Query('page[cursor]', { schema: Cursor.optional() }) cursor?: string,
  ): Promise<z.infer<typeof ChangePageDocument>> {
    const page = await this.readChanges.handle({
      actor,
      cursor,
      size: perPage,
    });
    const link = (at: string | undefined) => {
      const url = new URL(req.originalUrl, 'http://localhost');
      url.search = '';
      if (at !== undefined) url.searchParams.set('page[cursor]', at);
      url.searchParams.set('page[size]', String(perPage));
      return `${url.pathname}${url.search}`;
    };
    return {
      data: page.events.map(toChangeResource),
      meta: {
        page: { size: perPage, cursor: page.cursor },
        upToDate: page.upToDate,
      },
      links: { self: link(cursor), next: link(page.cursor) },
    };
  }
}
