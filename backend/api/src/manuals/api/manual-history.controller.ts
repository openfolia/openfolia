import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
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
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import {
  AcceptsQuery,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { VersionRef } from '../../modules/api/module-history.controller.js';
import { CompareManualVersionsAction } from '../core/actions/compare-manual-versions.action.js';
import { GetManualHistoryAction } from '../core/actions/get-manual-history.action.js';
import {
  ManualComparisonDocument,
  ManualVersionPageDocument,
  toManualComparisonDocument,
  toManualVersionPageDocument,
} from './manual-history.resources.js';

@ApiTags('manuals')
@Controller('manuals')
@JsonApi()
@ReadsContent()
export class ManualHistoryController {
  constructor(private readonly getHistory: GetManualHistoryAction) {}

  @Get(':id/history')
  @DeliveryApi()
  // Releases and the user directory: more than the commit read.
  @BeyondTheCommit()
  @Paged()
  @ApiOperation({
    summary: 'List a manual’s versions',
    description:
      'As a module’s history (`GET /modules/{lang}/{id}/history`), of the manual’s manifest (`manuals/<id>.yaml`): the commits on `?ref=`’s first-parent line (of the 1,000 newest) after which the manual, as the reader sees it there (by its audience), differs from before, newest first, each with who made it, the change set and the approvers (as the commit’s trailers claim), its revision number counted from the oldest, and the release tags holding exactly that manifest. A manual outside the reader’s scope at the ref is 404, exactly like a missing one; a manual deleted at the ref keeps its history, its newest version the removal. Reading an older version itself needs what reading its commit needs (`GET /manuals/{id}/compare`, `GET /manuals/{id}?ref=<commit>`): so a reader without `content.read.draft` is listed only the versions released content holds (`main`’s head, else a release tag holding exactly that manifest), each with the released commit to read it at (`meta.readAt`); a manual with versions but none released is 404 to them. Restoring one is an edit in a change set (see the README, “Manual history”).',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ManualVersionPageDocument,
    headers: CONTENT_HEADERS,
  })
  async history(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('id', { schema: params.manualId }) id: string,
  ): Promise<z.infer<typeof ManualVersionPageDocument>> {
    const result = await this.getHistory.handle({ actor, snapshot, id, page });
    return toManualVersionPageDocument(req, page, id, result);
  }
}

@ApiTags('manuals')
@Controller('manuals')
@JsonApi()
export class ManualCompareController {
  constructor(private readonly compare: CompareManualVersionsAction) {}

  @Get(':id/compare')
  @DeliveryApi()
  @AcceptsQuery('base', 'head')
  @ApiQuery({
    name: 'base',
    required: true,
    description: 'The older version: a commit ID or a tag.',
    schema: { type: 'string' },
  })
  @ApiQuery({
    name: 'head',
    required: true,
    description: 'The newer version: a commit ID or a tag.',
    schema: { type: 'string' },
  })
  @ApiOperation({
    summary: 'Compare two versions of a manual',
    description:
      'The manual at both versions and the members of its manifest that differ (`meta.change`, `meta.fields`), so the review screen’s manual diff renders it. Each side is read as reading its commit needs: a released commit (`main`’s head, a release tag) with `content.read`, any other, also an older commit of `main`, with `content.read.draft`, else 404 as for a ref that does not exist. Each side shows the manual only as the reader would see it on the other too (its audience, and only the modules a manifest may name to them on both); a side where it is not there is `added` or `removed`; 404 when neither has it.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: `base` or `head` is missing or given twice.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      'A side names no commit the reader may open, or the manual is on neither side.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'A file needed for the answer is broken (the configuration); `meta.path` names it.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({ standardSchema: ManualComparisonDocument })
  async compareVersions(
    @CurrentActor() actor: Actor,
    @Param('id', { schema: params.manualId }) id: string,
    @Query('base', { schema: VersionRef }) base: string,
    @Query('head', { schema: VersionRef }) head: string,
  ): Promise<z.infer<typeof ManualComparisonDocument>> {
    const comparison = await this.compare.handle({ actor, id, base, head });
    return toManualComparisonDocument(id, comparison);
  }
}
