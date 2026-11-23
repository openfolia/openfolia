import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ReportModuleUsageAction } from '../core/actions/report-module-usage.action.js';
import { ReportTranslationsAction } from '../core/actions/report-translations.action.js';
import type { UsageSort } from '../core/module-usage-report.js';
import {
  BooleanFilter,
  COVERAGE_DESCRIPTION,
  COVERAGE_FILTERS,
  LangFilter,
  ManualFilter,
  REPORT_PERMISSION_NOTE,
  SORT_DESCRIPTION,
  TypeFilter,
  USAGE_DESCRIPTION,
  USAGE_FILTERS,
  UsageSortParam,
} from './report-params.js';
import {
  ModuleUsagePageDocument,
  toModuleUsageResource,
  toTranslationCoverageResource,
  TranslationCoveragePageDocument,
} from './reports.resources.js';

/**
 * Reports for leads (#56, FR-19): translation coverage per manual and
 * language, and where each module is used. Not part of the delivery API.
 * Their CSV downloads are `ReportCsvController`'s.
 */
@ApiTags('reports')
@Controller('reports')
@JsonApi()
@ReadsContent()
export class ReportsController {
  constructor(
    private readonly translations: ReportTranslationsAction,
    private readonly usage: ReportModuleUsageAction,
  ) {}

  @Get('translations')
  // `at-provider` comes from the translation jobs, not from the commit.
  @BeyondTheCommit()
  @Paged()
  @Filters(...COVERAGE_FILTERS)
  @ApiOperation({
    summary: 'Report translation coverage',
    description: `${COVERAGE_DESCRIPTION} Paged; \`GET /reports/translations/csv\` downloads all of it. ${REPORT_PERMISSION_NOTE}`,
  })
  @ApiPermission('content.read.draft')
  @ApiOkResponse({
    standardSchema: TranslationCoveragePageDocument,
    headers: CONTENT_HEADERS,
  })
  async listTranslations(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[manual]', { schema: ManualFilter.optional() })
    manual?: string,
    @Query('filter[lang]', { schema: LangFilter.optional() }) lang?: string,
  ): Promise<z.infer<typeof TranslationCoveragePageDocument>> {
    const result = await this.translations.handle({
      actor,
      snapshot,
      filter: { manual, lang },
      page,
    });
    return toPagedDocument(req, page, result, toTranslationCoverageResource);
  }

  @Get('module-usage')
  @Paged()
  @Filters(...USAGE_FILTERS)
  @AcceptsQuery('sort')
  @ApiQuery({
    name: 'sort',
    required: false,
    description: SORT_DESCRIPTION,
    schema: { type: 'string', example: '-manuals,title' },
  })
  @ApiOperation({
    summary: 'Report module usage',
    description: `${USAGE_DESCRIPTION} Filtered and sorted before paging, so \`meta.page.total\` counts what is listed; \`GET /reports/module-usage/csv\` downloads all of it. ${REPORT_PERMISSION_NOTE}`,
  })
  @ApiPermission('content.read.draft')
  @ApiOkResponse({
    standardSchema: ModuleUsagePageDocument,
    headers: CONTENT_HEADERS,
  })
  async listModuleUsage(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[unused]', { schema: BooleanFilter.optional() })
    unused?: boolean,
    @Query('filter[type]', { schema: TypeFilter.optional() }) type?: string,
    @Query('sort', { schema: UsageSortParam.optional() }) sort?: UsageSort[],
  ): Promise<z.infer<typeof ModuleUsagePageDocument>> {
    const result = await this.usage.handle({
      actor,
      snapshot,
      filter: { unused, type },
      sort,
      page,
    });
    return toPagedDocument(req, page, result, toModuleUsageResource);
  }
}
