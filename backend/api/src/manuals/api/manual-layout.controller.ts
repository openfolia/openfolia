import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ManualLayoutWarningsAction } from '../core/actions/manual-layout-warnings.action.js';
import {
  DESIGN_QUERY_DESCRIPTION,
  DesignQuery,
  LayoutWarningPageDocument,
  toLayoutWarningResource,
} from './manual.resources.js';

/** What a manual's PDF layout could not fit, for the design screen's preview (#392). */
@ApiTags('manuals')
@Controller('manuals')
@JsonApi()
@ReadsContent()
export class ManualLayoutController {
  constructor(private readonly warnings: ManualLayoutWarningsAction) {}

  @Get(':id/variants/:variant/:lang/pdf/layout-warnings')
  @Paged()
  @ReadsWorkingCopies()
  @AcceptsQuery('design')
  @ApiQuery({
    name: 'design',
    required: false,
    description: DESIGN_QUERY_DESCRIPTION,
    schema: { type: 'string' },
  })
  @ApiOperation({
    summary: 'List what a manual’s PDF layout cannot fit',
    description:
      'What the page design’s layout of the PDF `GET …/pdf/pages/{page}.png` shows (the same reader, `?ref=`, `?workingCopy=` and `?design=`) could not fit: a title or back page region cut off (`page-design-overflow`) and a running header or footer shortened with an ellipsis (`running-head-truncated`), once per place, with the first page and how many pages. The PDF is rendered if it is not yet (cached as for its pages). Empty for a manual laid out without a page design.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiUnprocessableEntityResponse({
    description:
      'As for the PDF: `invalid-content`, `pdf-accessibility`, `render-timeout` or `expansion-too-large`.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: LayoutWarningPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
    @Query('design', { schema: DesignQuery }) design: string | undefined,
  ): Promise<z.infer<typeof LayoutWarningPageDocument>> {
    const result = await this.warnings.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
      ...(design !== undefined && { design }),
      page,
    });
    return toPagedDocument(req, page, result, toLayoutWarningResource);
  }
}
