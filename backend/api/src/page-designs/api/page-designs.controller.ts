import { Controller, Get, Param, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PageDesignId } from '@openfolia/content-model';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetPageDesignAction } from '../core/actions/get-page-design.action.js';
import { ListPageDesignsAction } from '../core/actions/list-page-designs.action.js';
import {
  PageDesignDocument,
  PageDesignPageDocument,
  toPageDesignListResource,
  toPageDesignResource,
} from './page-design.resources.js';

/**
 * The page designs (#390): how a manual's pages look, as project files
 * (`design/<id>.yaml`), read at `?ref=` like every content route. They are
 * written through a change set as subjects of type `design`.
 */
@ApiTags('page-designs')
@Controller('page-designs')
@JsonApi()
@ReadsContent()
export class PageDesignsController {
  constructor(
    private readonly listDesigns: ListPageDesignsAction,
    private readonly getDesign: GetPageDesignAction,
  ) {}

  @Get()
  @Paged()
  @ApiOperation({
    summary: 'List page designs',
    description:
      'The page designs at `?ref=` (`design/<id>.yaml`), by ID, each with the problems found checking it against the configuration. A file in `design/` that is no design is listed too (`UnreadablePageDesignResource`, with `meta.error`). A manual naming no design (and a configuration naming none as `pdf.design`) gets the built-in design, which is no file and not listed. Designs carry no audience: every reader of the ref reads them.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: PageDesignPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof PageDesignPageDocument>> {
    const result = await this.listDesigns.handle({ actor, snapshot, page });
    return toPagedDocument(req, page, result, toPageDesignListResource);
  }

  @Get(':designId')
  @ApiOperation({
    summary: 'Read a page design',
    description:
      'One page design at `?ref=`, with the problems found checking it against the configuration and its assets (logo, fonts, cover images) against the blob store, else the repository’s older layout (`assets/<sha256>` at that commit). A file that is no design is 422 `invalid-content`.',
  })
  @ApiParam({ name: 'designId', example: 'product-line' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: PageDesignDocument,
    headers: CONTENT_HEADERS,
  })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('designId', { schema: PageDesignId }) id: string,
  ): Promise<z.infer<typeof PageDesignDocument>> {
    const { design, issues } = await this.getDesign.handle({
      actor,
      snapshot,
      id,
    });
    return { data: toPageDesignResource(design, issues) };
  }
}
