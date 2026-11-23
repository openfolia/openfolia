import { Controller, Get, HttpStatus, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { attachmentDisposition } from '../../assets/api/asset-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { AcceptsQuery, Filters } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
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
  COVERAGE_CSV_COLUMNS,
  coverageCsv,
  USAGE_CSV_COLUMNS,
  usageCsv,
} from '../core/report-csv.js';
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

const CSV_TYPE = 'text/csv; charset=utf-8; header=present';

const CSV_NOTE =
  "A download (`Content-Disposition: attachment`, `nosniff`): CSV (RFC 4180, a header row, lines ending in CRLF; a value a spreadsheet would run as a formula starts with `'`). The whole report, unpaged; `X-Ccms-Rows` says how many rows follow the header.";

const CSV_HEADERS = {
  ...CONTENT_HEADERS,
  'X-Ccms-Rows': {
    description: 'How many rows the file holds after its header.',
    schema: { type: 'integer' },
  },
} as const;

const TRANSLATIONS_QUERY = new Set([
  'ref',
  ...COVERAGE_FILTERS.map((f) => `filter[${f.name}]`),
]);
const USAGE_QUERY = new Set([
  'ref',
  'sort',
  ...USAGE_FILTERS.map((f) => `filter[${f.name}]`),
]);

/**
 * The reports as CSV downloads (`/csv` sub-routes rather than
 * `Accept: text/csv`, so a plain link downloads them): files, so not
 * JSON:API; their errors still are. The body is returned as a string, so
 * `@BeyondTheCommit()` hashes the file itself for its ETag.
 */
@ApiTags('reports')
@Controller('reports')
@ReadsContent()
export class ReportCsvController {
  constructor(
    private readonly translations: ReportTranslationsAction,
    private readonly usage: ReportModuleUsageAction,
  ) {}

  @Get('translations/csv')
  @BeyondTheCommit()
  @Filters(...COVERAGE_FILTERS)
  @ApiOperation({
    summary: 'Download translation coverage as CSV',
    description: `${COVERAGE_DESCRIPTION} ${CSV_NOTE} Columns: ${COVERAGE_CSV_COLUMNS.map((c) => `\`${c}\``).join(', ')} (percentages in whole percent, rounded down). ${REPORT_PERMISSION_NOTE}`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'The CSV file.',
    content: { 'text/csv': { schema: { type: 'string' } } },
    headers: CSV_HEADERS,
  })
  @ApiPermission('content.read.draft')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: a malformed filter; `unsupported-parameter` for any other query parameter.',
    standardSchema: ErrorDocument,
  })
  async translationsCsv(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Res({ passthrough: true }) res: Response,
    @Query('filter[manual]', { schema: ManualFilter.optional() })
    manual?: string,
    @Query('filter[lang]', { schema: LangFilter.optional() }) lang?: string,
  ): Promise<string> {
    refuseUnsupported(req, TRANSLATIONS_QUERY);
    const { items } = await this.translations.handle({
      actor,
      snapshot,
      filter: { manual, lang },
    });
    return send(
      res,
      `translation-coverage-${snapshot.commit.slice(0, 12)}.csv`,
      items.length,
      coverageCsv(items),
    );
  }

  @Get('module-usage/csv')
  @Filters(...USAGE_FILTERS)
  @AcceptsQuery('sort')
  @ApiOperation({
    summary: 'Download module usage as CSV',
    description: `${USAGE_DESCRIPTION} ${CSV_NOTE} Columns: ${USAGE_CSV_COLUMNS.map((c) => `\`${c}\``).join(', ')}; the manuals and modules using a module are their IDs, one per line in their cell, all of them. Sorted as \`sort\` says: ${SORT_DESCRIPTION} ${REPORT_PERMISSION_NOTE}`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'The CSV file.',
    content: { 'text/csv': { schema: { type: 'string' } } },
    headers: CSV_HEADERS,
  })
  @ApiPermission('content.read.draft')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: a malformed filter or sort; `unsupported-parameter` for any other query parameter.',
    standardSchema: ErrorDocument,
  })
  async moduleUsageCsv(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Res({ passthrough: true }) res: Response,
    @Query('filter[unused]', { schema: BooleanFilter.optional() })
    unused?: boolean,
    @Query('filter[type]', { schema: TypeFilter.optional() }) type?: string,
    @Query('sort', { schema: UsageSortParam.optional() }) sort?: UsageSort[],
  ): Promise<string> {
    refuseUnsupported(req, USAGE_QUERY);
    const { items } = await this.usage.handle({
      actor,
      snapshot,
      filter: { unused, type },
      sort,
    });
    return send(
      res,
      `module-usage-${snapshot.commit.slice(0, 12)}.csv`,
      items.length,
      usageCsv(items),
    );
  }
}

/** A binary route gets no JSON:API check of its query: 400 for a parameter it does not take. */
function refuseUnsupported(req: Request, allowed: ReadonlySet<string>): void {
  const unsupported = Object.keys(req.query).filter((k) => !allowed.has(k));
  if (unsupported.length > 0) {
    throw new JsonApiException(
      HttpStatus.BAD_REQUEST,
      unsupported.map((parameter) => ({
        code: 'unsupported-parameter',
        detail: `This route does not support the query parameter "${parameter}".`,
        source: { parameter },
      })),
    );
  }
}

function send(
  res: Response,
  fileName: string,
  rows: number,
  csv: string,
): string {
  res.setHeader('Content-Type', CSV_TYPE);
  res.setHeader('Content-Disposition', attachmentDisposition(fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Ccms-Rows', String(rows));
  return csv;
}
