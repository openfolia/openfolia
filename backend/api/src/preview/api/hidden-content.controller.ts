import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { parseVariantSlug } from '@openfolia/content-model';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { MANUAL_TOO_LARGE } from '../../manuals/api/too-large-response.js';
import {
  AcceptsQuery,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  ListHiddenManualContentAction,
  ListHiddenModuleContentAction,
} from '../core/actions/list-hidden-content.action.js';
import {
  HiddenContentPageDocument,
  toHiddenContentPageDocument,
} from './hidden-content.resources.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import { VariantQuery } from './preview.controller.js';

@ApiTags('modules')
@Controller('modules')
@JsonApi()
@ReadsContent()
export class ModuleHiddenContentController {
  constructor(private readonly list: ListHiddenModuleContentAction) {}

  @Get(':lang/:id/hidden-content')
  @Paged()
  @ReadsWorkingCopies()
  @AcceptsQuery('variant')
  @ApiQuery({
    name: 'variant',
    required: false,
    description:
      'The variant, as for the module’s preview (`model=large,software=2.3`). Default: none set, so every variant block whose condition tests an attribute is hidden.',
    schema: { type: 'string' },
  })
  @ApiOperation({
    summary: 'List what a module hides for a variant',
    description:
      'The companion of `GET /modules/{lang}/{id}/preview`: the module’s variant blocks whose conditions leave them out for `variant`, outermost only, in document order, each with its condition and a plain-text label. Read like the preview: `?ref=` may name a branch (a change set’s, for its author), and a module the reader may not see is 404, exactly like a missing one; a variant the configuration does not hold is 422 `unknown-variant`.',
  })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({ name: 'id', example: 'battery-charging' })
  @ApiPermission('content.read')
  @ApiUnprocessableEntityResponse({
    description:
      '`unknown-variant`: the variant names an attribute or value the configuration does not hold. (`invalid-content` for a broken file, as on every content route.) ' +
      MANUAL_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: HiddenContentPageDocument,
    headers: CONTENT_HEADERS,
  })
  async hidden(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('id', { schema: params.moduleId }) id: string,
    @Query('variant', { schema: VariantQuery.optional() }) variant?: string,
  ): Promise<z.infer<typeof HiddenContentPageDocument>> {
    const parsed =
      variant === undefined ? undefined : parseVariantSlug(variant);
    const result = await this.list.handle({
      actor,
      snapshot,
      id,
      lang,
      ...(parsed && { variant: parsed }),
      page,
    });
    return toHiddenContentPageDocument(req, page, result);
  }
}

@ApiTags('manuals')
@Controller('manuals')
@JsonApi()
@ReadsContent()
export class ManualHiddenContentController {
  constructor(private readonly list: ListHiddenManualContentAction) {}

  @Get(':id/variants/:variant/:lang/hidden-content')
  @Paged()
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'List what a manual hides for one of its variants',
    description:
      'The companion of the manual’s HTML and PDF: what its conditions leave out for the variant, outermost only, in document order: variant blocks of the modules it includes, module entries and groups. Resolved exactly as the HTML and the PDF are, so it lists only what the reader could read: a module outside their scope or above the manual’s audience is never named. A manual, variant or language the reader may not have is 404, exactly like a missing one.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiUnprocessableEntityResponse({
    description:
      '`unknown-variant`: the variant names an attribute or value the configuration does not hold. (`invalid-content` for a broken file, as on every content route.) ' +
      MANUAL_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: HiddenContentPageDocument,
    headers: CONTENT_HEADERS,
  })
  async hidden(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
  ): Promise<z.infer<typeof HiddenContentPageDocument>> {
    const result = await this.list.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
      page,
    });
    return toHiddenContentPageDocument(req, page, result);
  }
}
