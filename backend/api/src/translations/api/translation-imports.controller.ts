import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsBodyOf,
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { MarkTranslationCurrentAction } from '../core/actions/mark-translation-current.action.js';
import {
  ApplyTranslationImportAction,
  GetTranslationImportAction,
  ValidateTranslationImportAction,
} from '../core/actions/translation-imports.action.js';
import { TranslationImportSettings } from '../core/translation-import-check.js';
import {
  IMPORT_UNIT_STATES,
  type ImportUnitState,
} from '../core/translation-import.js';
import {
  FIELDS,
  readTranslationImportForm,
} from './translation-import-form.js';
import {
  ApplyTranslationImportDocument,
  MarkCurrentDocument,
  MarkedCurrentDocument,
  toMarkedCurrentDocument,
  toTranslationImportDocument,
  TranslationImportDocument,
} from './translation-import.resources.js';

const ID_PARAMETER = {
  name: 'importId',
  description:
    'The translation import’s ID (a UUID). One that names no stored import, malformed or not, someone else’s or one removed after it expired, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no stored translation import with this ID that you uploaded (one is kept an hour after its upload, in the memory of the server that checked it).',
  standardSchema: ErrorDocument,
};

const XLIFF_REFUSALS =
  '`too-large` (the upload, or the XLIFF in a ZIP together, past `CCMS_MAX_UPLOAD_BYTES`; `meta.max`), `invalid-archive` (a ZIP read unsafely: `meta.reason`), `no-xliff` (a ZIP without an `.xlf` or `.xliff` file), `xliff-unsupported-encoding` (not UTF-8), `xliff-dtd-forbidden` (a `<!DOCTYPE>`, so a DTD or an entity declaration, internal or external; or a reference to an entity but XML’s five predefined ones: nothing is ever fetched or expanded), `xliff-not-well-formed`, `xliff-too-large`, `xliff-too-deep` (elements nest more than 64 deep), `xliff-too-many-nodes`, `xliff-too-many-attributes`, `not-xliff` (no XLIFF 2.0 document), `invalid-xliff` (no `srcLang` or `trgLang`, a `<file>` or `<unit>` without an `id`, one twice); `meta.path` names the file in a ZIP. `duplicate-language`: two documents into one language. `mixed-jobs`: documents of different jobs. `language-mismatch`: a document’s languages are not its job’s (`meta.lang`). `invalid-base`: no branch `baseRef` you may know of. A COTI package (#140): `invalid-coti` (`meta.reason`, `meta.path`: a `COTI.xml` refused as an XLIFF would be, or no COTI document, two in one folder, no job named, a listed translation file missing, listed twice or no XLIFF), `coti-job-mismatch` (an XLIFF’s `ccms:job` is not its package’s job), `language-mismatch` (an XLIFF’s languages are not its project’s).';

/**
 * Translation imports (#51): an XLIFF document (or a ZIP of them) of a
 * translation job comes back, is checked unit by unit, and goes into a
 * change set through the change-set actions.
 */
@ApiTags('translations')
@Controller('translations')
@JsonApi()
export class TranslationImportsController {
  constructor(
    private readonly validate: ValidateTranslationImportAction,
    private readonly getImport: GetTranslationImportAction,
    private readonly applyImport: ApplyTranslationImportAction,
    private readonly markCurrent: MarkTranslationCurrentAction,
    private readonly settings: TranslationImportSettings,
  ) {}

  @Post('imports')
  @AcceptsBodyOf('multipart/form-data')
  @Paged()
  @ApiOperation({
    summary: 'Validate a translation import',
    description: `Reads an uploaded XLIFF 2.0 document of a translation job (\`GET /translations/exports/{jobId}/file\`, translated), or a ZIP of them (one per target language), or a COTI level 1 package a translation management system returned (\`GET /translations/exports/{jobId}/package\`: each project’s \`COTI.xml\` names the job, its \`package-id\`, and the XLIFF files to read; nothing else in it is read), and decides each unit against what the job sent (read at its commit, as you read it there) and the base branch \`baseRef\` (default the server's default branch), as you see it: \`ok\`, \`source-changed\`, \`broken-markup\` (its \`<pc>\` and \`<ph>\` do not match its source: missing, extra, reordered across nesting, unknown IDs; refused alone, never the whole file), \`unknown-block\`, \`unknown-module\`, \`outside-scope\` (\`meta.report\`, one page per \`page[number]\` and \`page[size]\`, with the counts in \`meta.counts\`). The XML is read strictly: no DTD and no entities but the predefined ones, bounded in length, depth and nodes. **Nothing is written**: the documents and the report are kept for an hour (\`attributes.expiresAt\`), in the server's memory, so the import can be applied (\`POST /translations/imports/{importId}/apply\`). Send \`multipart/form-data\` (with \`X-Ccms-Request\`) with the file in the part \`${FIELDS.file}\` (at most \`CCMS_MAX_UPLOAD_BYTES\`) and the optional fields \`${FIELDS.dryRun}\` (\`true\`, the only value) and \`${FIELDS.baseRef}\`. Needs \`translation.manage\` for each document's target language.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [FIELDS.file],
      properties: {
        [FIELDS.file]: {
          type: 'string',
          format: 'binary',
          description:
            'An XLIFF 2.0 document, a ZIP of them, or a COTI package.',
        },
        [FIELDS.dryRun]: { type: 'string', enum: ['true'] },
        [FIELDS.baseRef]: { type: 'string' },
      },
    },
  })
  @ApiPermission('translation.manage')
  @ApiCreatedResponse({
    description: 'Checked and kept, to be applied within the hour.',
    standardSchema: TranslationImportDocument,
    headers: {
      Location: { description: 'The import.', schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`invalid-body`: no file part named `file`, a field the form does not have or twice, `dryRun` other than `true`, a malformed or cut-off form.',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no `translation.manage`, or not for a document’s target language.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`unknown-job`: the documents name no translation job you may see (their `ccms:job`), as reading that job would be.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`job-not-open`: the job was cancelled (`meta.state`).',
    standardSchema: ErrorDocument,
  })
  @ApiResponse({
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    description: '`unsupported-media-type`: not `multipart/form-data`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: XLIFF_REFUSALS,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`import-busy`: the server checks other translation imports now; `too-many-imports`: it keeps as many as it holds. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async create(
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @PageParams() page: PageRequest,
  ): Promise<TranslationImportDocument> {
    try {
      const record = await this.validate.handle({
        actor,
        form: () => readTranslationImportForm(req, this.settings.maxBytes),
      });
      res.status(HttpStatus.CREATED);
      res.setHeader('Location', `/translations/imports/${record.id}`);
      return toTranslationImportDocument(req, page, record);
    } catch (error) {
      // What was not read is not read at all.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Get('imports/:importId')
  @Paged()
  @Filters({
    name: 'state',
    description: `Only the units in this state (${IMPORT_UNIT_STATES.map((s) => `\`${s}\``).join(', ')}), and the modules with one; before paging. \`meta.counts\` stays the whole report’s.`,
  })
  @ApiOperation({
    summary: 'Read a translation import',
    description:
      'A translation import you uploaded, with one page of its report (`meta.report`, per module and target language; `filter[state]` for the units in one state) and its counts; once applied, its change set (`relationships.changeSet`) and commit (`meta.commit`), and the report as it was applied. Needs `translation.manage`.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('translation.manage')
  @ApiOkResponse({ standardSchema: TranslationImportDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async get(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('importId') id: string,
    @PageParams() page: PageRequest,
    @Query('filter[state]', { schema: z.enum(IMPORT_UNIT_STATES).optional() })
    state?: ImportUnitState,
  ): Promise<TranslationImportDocument> {
    return toTranslationImportDocument(
      req,
      page,
      await this.getImport.handle({ actor, id }),
      state,
    );
  }

  @Post('imports/:importId/apply')
  @HttpCode(HttpStatus.OK)
  @Paged()
  @ApiOperation({
    summary: 'Apply a translation import',
    description:
      'Checks the stored documents again against the base as it is now, then, as you, through the change-set actions: starts a change set (named after the job, from the import’s base), locks each target module, writes each as a working copy with its units merged in by block ID (a block the target lacks comes from the source’s structure; image and attachment references, variant conditions and IDs of the target stay), and makes one save point with the working copies and each module’s translation record (the source hash each unit was exported from). Imported: `ok` units, and `source-changed` ones unless `meta.decisions` says `skip` (`keep` is the default; they stay `outdated`). In the save point’s transaction the job’s units imported become `returned` (the job too once none is left at the provider), with one `translation.import` audit event and a `translation.imported` outbox row (webhooks, notifications). The change set then goes through review like any other. Takes no body, or `{ meta: { decisions } }` (send `Content-Type: application/vnd.api+json`). A failure abandons the change set (nothing is committed) and leaves the import `validated`. Only the import’s uploader, once, within the hour. Needs `translation.manage`, and `content.edit` with the scope of every module written (as saving it would).',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    description: 'Applied: the import with its change set and commit.',
    standardSchema: TranslationImportDocument,
  })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no `content.edit`, or a module outside your scope (one answer whatever the reason).',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: being applied, or applied already (`meta.state`). `job-not-open`: the job was cancelled since. `locked`: another change set holds a target module’s lock. `source-moved`: a source module is gone from the base. Any answer of the change-set actions (`branch-moved`, `working-copy-changed`, `lock-contended`, …).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`nothing-to-import`: no unit can be imported now. `unreadable-translation`: a target file cannot be read (`meta.lang`, `meta.moduleId`). `invalid-working-copy`: what the merge makes is not valid content. Any refusal of the validation, should the base or your roles have changed since.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`import-busy`: the server checks or applies other translation imports now. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async apply(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('importId') id: string,
    @PageParams() page: PageRequest,
    @Body({ schema: ApplyTranslationImportDocument })
    body: ApplyTranslationImportDocument,
  ): Promise<TranslationImportDocument> {
    const record = await this.applyImport.handle({
      actor,
      id,
      decisions: body?.meta?.decisions ?? [],
    });
    return toTranslationImportDocument(req, page, record);
  }

  @Post('mark-current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a translation as current',
    description:
      'For a source fix that needs no new translation: in a draft change set of yours, the translation record of the module in `lang` takes the source’s current hash for every block the translation has (the branch head as `sourceCommit`), without changing the translated text, so they are `up-to-date` once merged. Through the change-set actions: takes the module’s lock (in `lang`) for the change set, then a save point writing only the record, with a `translation.mark-current` audit event. Needs `translation.manage` on the module in `lang`, and `content.edit` with its scope. With `designId` or `manualId` instead (#656), a page design’s region text or a manual’s own text (its cover images’ alternative text) is marked current the same way: their record is part of their file, so the save point holds a working copy of it with only the record changed. A design needs `translation.manage` restricted by nothing but languages and unrestricted `content.edit`; a manual `translation.manage` over its audience in `lang` and the right to change its manifest. With `config: true` instead (#731), the project labels in `openfolia.yaml` the same way (the configuration’s lock and a working copy of it): it needs `translation.manage` restricted by nothing but languages and the right to change the configuration (unrestricted `content.edit` and `admin.roles`).',
  })
  @ApiPermission('translation.manage')
  @ApiOkResponse({ standardSchema: MarkedCurrentDocument })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no `translation.manage` on the module in `lang`, no `content.edit` on it, or not your change set.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no such change set or source module for you.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`invalid-state`: the change set is no draft. `locked`: another change set holds the module’s lock. `uncommitted-working-copies`: the change set has a working copy of the module; commit or discard it first. `stale-working-copy`: a save point changed the record (a design’s, manual’s or the configuration’s file) since the branch head was read (#957); mark it again.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-parameter`: `lang` is no target language. `translation-missing`: no translation of the module in `lang` (no text of the design, the manual or any project label of its own in `lang`).',
    standardSchema: ErrorDocument,
  })
  async markAsCurrent(
    @CurrentActor() actor: Actor,
    @Body({ schema: MarkCurrentDocument }) body: MarkCurrentDocument,
  ): Promise<MarkedCurrentDocument> {
    const { changeSetId, moduleId, designId, manualId, config, lang } =
      body.data.attributes;
    return toMarkedCurrentDocument(
      await this.markCurrent.handle({
        actor,
        changeSetId,
        moduleId,
        designId,
        manualId,
        config,
        lang,
      }),
    );
  }
}
