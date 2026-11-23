import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ListManualChecksAction } from '../core/actions/list-manual-checks.action.js';
import type { CheckSeverity } from '../core/check.js';
import {
  CheckPageDocument,
  checkFilters,
  toCheckPageDocument,
} from './check.resources.js';

export const SEVERITY_FILTER = {
  name: 'severity',
  description: 'Only checks of this severity: `blocking` or `warning`.',
} as const;

@ApiTags('checks')
@Controller('manuals')
@JsonApi()
@ReadsContent()
export class ManualChecksController {
  constructor(private readonly listChecks: ListManualChecksAction) {}

  @Get(':id/checks')
  @BeyondTheCommit()
  @Paged()
  @Filters(SEVERITY_FILTER)
  @ApiOperation({
    summary: 'Check a manual',
    description:
      'Blocking issues and warnings found in a manual at `?ref=`, each at its module (in one language) and block, or at the manual: the manifest’s validation issues, every published variant resolved in every language the reader may read it in (missing modules, translations and text or variant attributes, cross-references, module reference cycles), and the checks of every module it includes (validation, module references, images the blob store does not hold), and, unless `pdf.standard` is `none`, each variant’s PDF in each language rendered to check PDF/UA-1 (`pdf-accessibility`, `pdf-not-checked`), and, with a page design, what its layout cannot fit (`page-design-overflow`, `running-head-truncated`), and, with a callout legend beside an image, a legend cut off at the image’s height (`callout-label-overflow`, whatever `pdf.standard`), and, with a page design, a safety message taller than a page, broken across pages (`safety-message-split`). Only what the reader may see: nothing about a module they may not see is listed or counted. Ordered by subject (the manual, then modules by language and ID), then by where the block is. Derived on every request; depends on the blob store too, so never `immutable`.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiPermission('content.read')
  @ApiServiceUnavailableResponse({
    description:
      'The PDF renderer is busy or the server is shutting down (the checks render each PDF to check PDF/UA-1); `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: CheckPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('id', { schema: params.manualId }) id: string,
    @Query('filter[severity]', { schema: checkFilters.severity.optional() })
    severity?: CheckSeverity,
  ): Promise<z.infer<typeof CheckPageDocument>> {
    const result = await this.listChecks.handle({
      actor,
      snapshot,
      id,
      page,
      filter: severity === undefined ? {} : { severity },
    });
    return toCheckPageDocument(req, page, result);
  }
}
