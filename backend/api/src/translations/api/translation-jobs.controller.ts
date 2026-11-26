import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { NamesPeople } from '../../base/api/people.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { RELEASED_BRANCH } from '../../content/core/released.js';
import { CancelTranslationJobAction } from '../core/actions/cancel-translation-job.action.js';
import {
  ExportTranslationsAction,
  MAX_EXPORT_UNITS,
} from '../core/actions/export-translations.action.js';
import {
  GetTranslationJobAction,
  ListTranslationJobsAction,
} from '../core/actions/read-translation-jobs.action.js';
import {
  CreateTranslationExportDocument,
  toTranslationJobResource,
  TranslationJobDocument,
  TranslationJobPageDocument,
} from './translation-job.resources.js';

type Document = z.infer<typeof TranslationJobDocument>;

export const JOB_ID_PARAMETER = {
  name: 'jobId',
  description:
    'The translation job’s ID (a UUID). One that names no job, malformed or not, or a job in a language you do not manage, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

export const WHO_SEES_JOBS =
  'A job is there for its exporter, and for whoever holds `translation.manage` for each of its target languages and `content.read` for its source and target languages, in roles whose scope restricts nothing but languages (so neither its subject nor its counts tell of content outside their scope); a job exported from a ref that was not released (its ref and commit are drafts) only for holders of `content.read.draft`, and for anyone but its exporter only where `content.read.draft` covers those languages in the same way. To anyone else it is not found.';

/**
 * Delta translation exports (#50): translation jobs, each the blocks of
 * some modules whose source changed since they were last translated, per
 * target language, sent to a provider as XLIFF 2.0.
 */
@ApiTags('translations')
@Controller('translations/exports')
@JsonApi()
@NamesPeople()
export class TranslationJobsController {
  constructor(
    private readonly exportTranslations: ExportTranslationsAction,
    private readonly listJobs: ListTranslationJobsAction,
    private readonly getJob: GetTranslationJobAction,
    private readonly cancelJob: CancelTranslationJobAction,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Export translations (delta)',
    description: `Works out, per target language, the blocks of the subject’s modules at \`ref\` (default \`main\`) that need translating (\`outdated\` or \`missing\` in the translation status, and not at a provider in an open job), and records them as a translation job, \`sent\`: they are \`at-provider\` from then on, and \`GET /translations/exports/{jobId}/file\` gives the XLIFF. A module reached through several module references is sent once. A module counts in a language only where you read it (your \`content.read\` scope), would see a translation in that language and hold \`translation.manage\` on it there. Answers the job with its counts in \`meta\` (modules, units, words; per language in \`meta.languages\`), 201 with \`Location\`. With \`meta.dryRun\`: the same answer (200, \`meta.dryRun: true\`), nothing recorded. Records a \`translation-job.export\` audit event. Needs \`translation.manage\` and \`content.read\`.`,
  })
  @ApiPermission('translation.manage')
  @ApiCreatedResponse({
    standardSchema: TranslationJobDocument,
    headers: {
      Location: { description: 'The new job.', schema: { type: 'string' } },
    },
  })
  @ApiOkResponse({
    description: 'A dry run: what would be sent.',
    standardSchema: TranslationJobDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no such ref that you may read.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`export-conflict`: another export sent some of these blocks meanwhile; try again (it leaves them out).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: `\`invalid-parameter\` (\`source.pointer\` at the language): a language that is no configured target language, or one you do not manage translations into; checked before any module is read. \`nothing-to-translate\`: every block is up to date or at a provider in these languages, or there is no module you may send. \`too-many-units\`: more than ${MAX_EXPORT_UNITS.toLocaleString('en')} units (\`meta.units\`, \`meta.max\`).`,
    standardSchema: ErrorDocument,
  })
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateTranslationExportDocument })
    body: CreateTranslationExportDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const { languages, subject, ref, dueDate } = body.data.attributes;
    const dryRun = body.meta?.dryRun === true;
    const job = await this.exportTranslations.handle({
      actor,
      languages,
      subject,
      ref: ref ?? RELEASED_BRANCH,
      dueDate: dueDate ?? null,
      dryRun,
    });
    if (dryRun) {
      res.status(HttpStatus.OK);
    } else {
      res.setHeader('Location', `/translations/exports/${job.id}`);
    }
    return { data: toTranslationJobResource(job, { dryRun }) };
  }

  @Get()
  @Paged()
  @ApiOperation({
    summary: 'List translation jobs',
    description: `The translation jobs, newest first. ${WHO_SEES_JOBS} Needs \`translation.manage\`.`,
  })
  @ApiPermission('translation.manage')
  @ApiOkResponse({ standardSchema: TranslationJobPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof TranslationJobPageDocument>> {
    const result = await this.listJobs.handle({ actor, page });
    return toPagedDocument(req, page, result, (job) =>
      toTranslationJobResource(job),
    );
  }

  @Get(':jobId')
  @ApiOperation({
    summary: 'Read a translation job',
    description: `One translation job with its counts. ${WHO_SEES_JOBS} Needs \`translation.manage\`.`,
  })
  @ApiParam(JOB_ID_PARAMETER)
  @ApiPermission('translation.manage')
  @ApiOkResponse({ standardSchema: TranslationJobDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no such job for you.',
    standardSchema: ErrorDocument,
  })
  async get(
    @CurrentActor() actor: Actor,
    @Param('jobId') id: string,
  ): Promise<Document> {
    return {
      data: toTranslationJobResource(await this.getJob.handle({ actor, id })),
    };
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a translation job',
    description: `Cancels a \`sent\` job: its units are no longer \`at-provider\`, so the next export sends them again. Answers the job, \`cancelled\`. Records a \`translation-job.cancel\` audit event. ${WHO_SEES_JOBS} Needs \`translation.manage\`.`,
  })
  @ApiParam(JOB_ID_PARAMETER)
  @ApiPermission('translation.manage')
  @ApiOkResponse({ standardSchema: TranslationJobDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no such job for you.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`job-not-open`: the job is returned or cancelled already (`meta.state`).',
    standardSchema: ErrorDocument,
  })
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('jobId') id: string,
  ): Promise<Document> {
    return {
      data: toTranslationJobResource(
        await this.cancelJob.handle({ actor, id }),
      ),
    };
  }
}
