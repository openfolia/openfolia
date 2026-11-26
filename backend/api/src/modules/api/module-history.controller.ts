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
import { z } from 'zod';
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
import { NamesPeople } from '../../base/api/people.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { CompareModuleVersionsAction } from '../core/actions/compare-module-versions.action.js';
import { GetModuleHistoryAction } from '../core/actions/get-module-history.action.js';
import {
  ModuleComparisonDocument,
  ModuleVersionPageDocument,
  toModuleComparisonDocument,
  toModuleVersionPageDocument,
} from './module-history.resources.js';

/** A side of a comparison: a commit ID or a tag (any ref, as `?ref=` takes). */
export const VersionRef = z.string().min(1).max(256);

/**
 * The language, loosely: no snapshot is opened before the action here, so
 * an actor who may not read is refused (403) before a malformed tag could
 * answer 400; one that is no language tag names no module (404).
 */
export const LooseLang = z.string().min(1).max(64);

@ApiTags('modules')
@Controller('modules')
@JsonApi()
@NamesPeople()
@ReadsContent()
export class ModuleHistoryController {
  constructor(private readonly getHistory: GetModuleHistoryAction) {}

  @Get(':lang/:id/history')
  @DeliveryApi()
  // Releases and the user directory: more than the commit read.
  @BeyondTheCommit()
  @Paged()
  @ApiOperation({
    summary: 'List a module’s versions',
    description:
      'The commits on `?ref=`’s first-parent line (of the 1,000 newest) after which the module, as the reader sees it there, differs from before, newest first: a merged change set, or a save point on a change set’s branch. Each with who made it, the change set and the approvers (as the commit’s trailers claim), its revision number counted from the oldest, and the release tags holding exactly that file. A version the reader may not see is no file to them, so it is not listed (one moving the module out of their scope is a removal). A module outside the reader’s scope at the ref is 404, exactly like a missing one; a module deleted at the ref keeps its history, its newest version the removal. Reading an older version itself needs what reading its commit needs (`GET /modules/{lang}/{id}/compare`, `?ref=<commit>`). Restoring one is an edit in a change set (see the README, “Module history”).',
  })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({ name: 'id', example: 'battery-charging' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ModuleVersionPageDocument,
    headers: CONTENT_HEADERS,
  })
  async history(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('id', { schema: params.moduleId }) id: string,
  ): Promise<z.infer<typeof ModuleVersionPageDocument>> {
    const result = await this.getHistory.handle({
      actor,
      snapshot,
      id,
      lang,
      page,
    });
    return toModuleVersionPageDocument(req, page, lang, id, result);
  }
}

@ApiTags('modules')
@Controller('modules')
@JsonApi()
export class ModuleCompareController {
  constructor(private readonly compare: CompareModuleVersionsAction) {}

  @Get(':lang/:id/compare')
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
    summary: 'Compare two versions of a module',
    description:
      'The module at both versions and how it changed, block by block, in the shape of a change set’s changes (`meta.change`, `meta.fields`, `meta.blocks`), so the review screen’s diff renders it. Each side is read as reading its commit needs: a released commit (`main`’s head, a release tag) with `content.read`, any other, also an older commit of `main`, with `content.read.draft`, else 404 as for a ref that does not exist. Each side shows the module only as the reader would see it on the other too; a side where it is not there is `added` or `removed`; 404 when neither has it.',
  })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({ name: 'id', example: 'battery-charging' })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: `base` or `head` is missing or given twice.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      'A side names no commit the reader may open, or the module is on neither side.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'A file needed for the answer is broken (the configuration); `meta.path` names it.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({ standardSchema: ModuleComparisonDocument })
  async compareVersions(
    @CurrentActor() actor: Actor,
    @Param('lang', { schema: LooseLang }) lang: string,
    @Param('id', { schema: params.moduleId }) id: string,
    @Query('base', { schema: VersionRef }) base: string,
    @Query('head', { schema: VersionRef }) head: string,
  ): Promise<z.infer<typeof ModuleComparisonDocument>> {
    const comparison = await this.compare.handle({
      actor,
      id,
      lang,
      base,
      head,
    });
    return toModuleComparisonDocument(lang, id, comparison);
  }
}
