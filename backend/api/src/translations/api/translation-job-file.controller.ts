import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { XLIFF_MEDIA_TYPE } from '@openfolia/xliff';
import type { Request, Response } from 'express';
import { strToU8, zipSync } from 'fflate';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { params } from '../../base/api/schemas.js';
import { TranslationJobFileAction } from '../core/actions/translation-job-file.action.js';
import { TranslationJobPackageAction } from '../core/actions/translation-job-package.action.js';
import {
  JOB_ID_PARAMETER,
  WHO_SEES_JOBS,
} from './translation-jobs.controller.js';

/** What the file route takes; binary routes get no JSON:API check of their query. */
const FILE_QUERY = new Set(['lang']);

/** The name a job's file downloads as: `translation-<job>[-<lang>].<ext>`. */
const fileName = (jobId: string, ext: string, lang?: string) =>
  `translation-${jobId}${lang === undefined ? '' : `-${lang}`}.${ext}`;

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('translations')
@Controller('translations/exports')
export class TranslationJobFileController {
  constructor(
    private readonly jobFile: TranslationJobFileAction,
    private readonly jobPackage: TranslationJobPackageAction,
  ) {}

  @Get(':jobId/file')
  @ApiOperation({
    summary: 'Download a translation job’s XLIFF',
    description: `The job as XLIFF 2.0 (core): with \`lang\`, that language’s document (\`${XLIFF_MEDIA_TYPE}\`); without, a ZIP with one per language (\`translation-<jobId>-<lang>.xlf\`). Always \`Content-Disposition: attachment\`. One \`<file>\` per module, one \`<unit>\` per block sent (its \`ccms:sourceHash\` says what it was made from), inline marks as \`<pc>\` and \`<ph>\` (\`packages/xliff\`). Made again on every request from the job’s commit and units, as you may read the content there now: modules outside your scope are left out. The commit opens as released content when it was released when exported; else it needs \`content.read.draft\`. ${WHO_SEES_JOBS} Needs \`translation.manage\` and \`content.read\`.`,
  })
  @ApiParam(JOB_ID_PARAMETER)
  @ApiQuery({
    name: 'lang',
    required: false,
    description: 'One language of the job; without it, a ZIP of every one.',
    schema: { type: 'string' },
  })
  @ApiProduces(XLIFF_MEDIA_TYPE, 'application/zip')
  @ApiOkResponse({
    description: 'The XLIFF document, or a ZIP of them.',
    content: {
      [XLIFF_MEDIA_TYPE]: { schema: { type: 'string', format: 'binary' } },
      'application/zip': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiPermission('translation.manage')
  @ApiBadRequestResponse({
    description: 'A malformed language, or an unsupported query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such job for you, a language not in it, or nothing of it left that you may read.',
    standardSchema: ErrorDocument,
  })
  async file(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('jobId') id: string,
    @Query('lang', { schema: params.lang.optional() }) lang: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    refuseUnsupported(req, FILE_QUERY);
    const { job, files } = await this.jobFile.handle({ actor, id, lang });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const [only] = files;
    if (lang !== undefined && only) {
      return new StreamableFile(Buffer.from(only.xliff, 'utf8'), {
        type: `${XLIFF_MEDIA_TYPE}; charset=utf-8`,
        disposition: `attachment; filename="${fileName(job.id, 'xlf', lang)}"`,
      });
    }
    const zip = zipSync(
      Object.fromEntries(
        files.map((f) => [fileName(job.id, 'xlf', f.lang), strToU8(f.xliff)]),
      ),
      { level: 6 },
    );
    return new StreamableFile(zip, {
      type: 'application/zip',
      disposition: `attachment; filename="${fileName(job.id, 'zip')}"`,
    });
  }

  @Get(':jobId/package')
  @ApiOperation({
    summary: 'Download a translation job as a COTI package',
    description: `The job as a COTI level 1 package for a translation management system (\`application/zip\`, \`<timestamp>_translation-<jobId>.coti\`, \`Content-Disposition: attachment\`): one translation project per target language, in a folder \`<jobId>-<lang>_<source>_<target>\`, each with its \`COTI.xml\` (\`package-id\` the job, \`project-id\` \`<jobId>-<lang>\`, the export's time as \`checkout-date\`, the job's due day as \`due-date\`, languages as \`<language>-<region>\` codes, \`status="none"\`) and the job's XLIFF in \`translation files/\`, exactly as \`GET /translations/exports/{jobId}/file\` gives it. A returned package is imported with \`POST /translations/imports\`. ${WHO_SEES_JOBS} Needs \`translation.manage\` and \`content.read\`.`,
  })
  @ApiParam(JOB_ID_PARAMETER)
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'The package.',
    content: {
      'application/zip': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiPermission('translation.manage')
  @ApiBadRequestResponse({
    description: 'An unsupported query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such job for you, or nothing of it left that you may read.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`job-not-open`: the job was cancelled.',
    standardSchema: ErrorDocument,
  })
  async package(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('jobId') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    refuseUnsupported(req, NO_QUERY);
    const { package: made } = await this.jobPackage.handle({ actor, id });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(made.bytes, {
      type: made.mediaType,
      disposition: `attachment; filename="${made.fileName}"`,
    });
  }
}

const NO_QUERY = new Set<string>();

/** 400 `unsupported-parameter` for a query parameter the route does not take. */
function refuseUnsupported(req: Request, supported: ReadonlySet<string>): void {
  const unsupported = Object.keys(req.query).filter((k) => !supported.has(k));
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
