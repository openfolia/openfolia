import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
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
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsBodyOf,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ApplyImportAction } from '../core/actions/apply-import.action.js';
import { CreateImportAction } from '../core/actions/create-import.action.js';
import { GetImportAction } from '../core/actions/get-import.action.js';
import { ListImportersAction } from '../core/actions/list-importers.action.js';
import { ImportSettings } from '../core/import.js';
import { IMPORT_FORM_FIELDS, readImportForm } from './import-form.js';
import {
  ApplyImportDocument,
  ImportDocument,
  ImporterPageDocument,
  toImporterResource,
  toImportResource,
} from './import.resources.js';

const ID_PARAMETER = {
  name: 'importId',
  description:
    'The import’s ID (a UUID). One that names no stored import, malformed or not, someone else’s or one removed after it expired, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no stored import with this ID that you uploaded (a dry run is never stored; a stored one is removed an hour after its upload or its end).',
  standardSchema: ErrorDocument,
};

const PERMISSIONS =
  'Needs the `admin.roles` permission, and `content.edit` and `content.read` (each item is checked against your scope as saving it would be).';

@ApiTags('imports')
@Controller('importers')
@JsonApi()
export class ImportersController {
  constructor(
    private readonly listImporters: ListImportersAction,
    private readonly settings: ImportSettings,
  ) {}

  @Get()
  @Paged()
  @ApiOperation({
    summary: 'List the importers',
    description:
      'The installed importers, by ID: `bundle`, the documented import format itself (`@openfolia/content-model`, "Import format"), and any other installed behind the `Importer` port. `meta.optionsSchema` is what each takes as `options` in the upload form, as JSON Schema; `meta.maxBytes` the largest upload (`CCMS_IMPORT_MAX_BYTES`). Needs the `admin.roles` permission.',
  })
  @ApiPermission('admin.roles')
  @ApiOkResponse({ standardSchema: ImporterPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof ImporterPageDocument>> {
    const result = await this.listImporters.handle({ actor, page });
    return toPagedDocument(req, page, result, (importer) =>
      toImporterResource(importer, this.settings.maxBytes),
    );
  }
}

@ApiTags('imports')
@Controller('imports')
@JsonApi()
export class ImportsController {
  constructor(
    private readonly createImport: CreateImportAction,
    private readonly getImport: GetImportAction,
    private readonly applyImport: ApplyImportAction,
    private readonly settings: ImportSettings,
  ) {}

  @Post()
  @AcceptsBodyOf('multipart/form-data')
  @ApiOperation({
    summary: 'Check an import (a dry run, or stored to apply)',
    description: `Runs the importer on the uploaded file, then the import format's validator against the configuration at \`baseRef\` (default the server's default branch), the module and manual IDs there and the files already stored that you may read (used at \`baseRef\` as you see it, or uploaded into a change set of yours; any other reference not carried in the bundle is \`missing-asset\`, whether or not it is stored), and decides each item: \`create\`, \`update\` (an existing module or manual, only with \`updateExisting\`), \`skip\` (exists already; a file no written module uses) or \`refuse\` (an error, outside your scope, a file the asset rules refuse), with reasons; the report is in \`meta.report\`, with the counts, the converter's own report and the \`passthrough\` counts. **\`dryRun=true\`**: 200, nothing is stored (no blob, no row, no change set, no Git object). Otherwise 201: the upload and the report are kept for an hour (\`attributes.expiresAt\`) so the import can be applied (\`POST /imports/:importId/apply\`). Send \`multipart/form-data\` (with \`X-Ccms-Request\`) with the file in the part \`${IMPORT_FORM_FIELDS.file}\` (at most \`CCMS_IMPORT_MAX_BYTES\`) and the optional fields \`importer\` (default \`bundle\`), \`options\` (a JSON object, the importer's \`meta.optionsSchema\`), \`updateExisting\` and \`dryRun\` (\`true\` or \`false\`, default \`false\`) and \`baseRef\`. A ZIP is read safely: a path leaving its folder, an absolute one, links, the same path twice, more than \`CCMS_IMPORT_MAX_FILES\` entries, more than \`CCMS_IMPORT_MAX_UNPACKED_BYTES\` unpacked, deeper than \`CCMS_IMPORT_MAX_PATH_DEPTH\` folders, encryption, ZIP64 or a file holding more than it declares is 422 \`invalid-archive\` (\`meta.reason\`). ${PERMISSIONS}`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [IMPORT_FORM_FIELDS.file],
      properties: {
        [IMPORT_FORM_FIELDS.file]: { type: 'string', format: 'binary' },
        [IMPORT_FORM_FIELDS.importer]: { type: 'string', default: 'bundle' },
        [IMPORT_FORM_FIELDS.options]: {
          type: 'string',
          description: 'A JSON object: the importer’s options.',
        },
        [IMPORT_FORM_FIELDS.updateExisting]: {
          type: 'string',
          enum: ['true', 'false'],
        },
        [IMPORT_FORM_FIELDS.dryRun]: {
          type: 'string',
          enum: ['true', 'false'],
        },
        [IMPORT_FORM_FIELDS.baseRef]: { type: 'string' },
      },
    },
  })
  @ApiOkResponse({
    description: 'A dry run: the report; nothing stored.',
    standardSchema: ImportDocument,
  })
  @ApiCreatedResponse({
    description: 'Stored with its report, to be applied within the hour.',
    standardSchema: ImportDocument,
    headers: {
      Location: { description: 'The import.', schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`invalid-body`: no file part named `file`, a field the form does not have or twice, a field that is not what it says (`source.parameter`), or the form is malformed or cut off.',
    standardSchema: ErrorDocument,
  })
  @ApiResponse({
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    description: '`unsupported-media-type`: not `multipart/form-data`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-archive`: the file is no ZIP the importer reads safely (`meta.reason`: `not-a-zip`, `corrupt`, `unsafe-path`, `path-too-deep`, `duplicate-path`, `link`, `too-many-files`, `too-large`, `encrypted`, `zip64`, `multi-disk`, `unsupported-compression`); `too-large`: the upload is larger than `CCMS_IMPORT_MAX_BYTES` (`meta.max`); `unknown-importer` (`meta.importers`); `invalid-options` (one error per problem, `source.pointer`); `invalid-base`: no branch `baseRef` to import into.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`import-busy`: the server checks other imports now; `blob-store-unavailable`; `upload-interrupted`: the same file was removed while it was stored (upload again). `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async create(
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportDocument> {
    try {
      const view = await this.createImport.handle({
        actor,
        form: () => readImportForm(req, this.settings.maxBytes),
      });
      if (view.dryRun) {
        res.status(HttpStatus.OK);
      } else {
        res.status(HttpStatus.CREATED);
        res.setHeader('Location', `/imports/${view.id}`);
      }
      return { data: toImportResource(view) };
    } catch (error) {
      // What was not read is not read at all.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Get(':importId')
  @ApiOperation({
    summary: 'Read an import',
    description:
      'A stored import you uploaded: its report (`meta.report`), its state and, while and after it is applied, its progress (`meta.progress`: the files uploaded, the modules and manuals committed, the save points) and the change set it writes into (`relationships.changeSet`); `meta.failure` says why it failed. Kept for an hour after its upload, or after its job ended. Needs the `admin.roles` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('admin.roles')
  @ApiOkResponse({ standardSchema: ImportDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async get(
    @CurrentActor() actor: Actor,
    @Param('importId') id: string,
  ): Promise<ImportDocument> {
    const record = await this.getImport.handle({ actor, id });
    return { data: toImportResource({ ...record, dryRun: false }) };
  }

  @Post(':importId/apply')
  @ApiOperation({
    summary: 'Apply an import',
    description: `Starts writing a validated import into a new change set (named after it), as you, in a background job: the job checks it again against \`baseRef\` as it is then (a report that would now differ fails it: \`import-outdated\`), creates the change set, uploads the files (the image and attachment upload path, with its type and size rules), writes the modules and then the manuals as working copies with their locks, and makes save points within \`CCMS_IMPORT_COMMIT_FILES\` files and \`CCMS_IMPORT_COMMIT_BYTES\` each (at most a save point's 1,000 files and 32 MiB), so a large import becomes several commits on one change set. Every step goes through the change-set actions an editor's would, with their checks. Follow it with \`GET /imports/:importId\` (\`meta.progress\`); its end is one \`import.apply\` audit event with the counts. Takes no body (send \`Content-Type: application/vnd.api+json\`), or \`{ "meta": { "skipRefused": true } }\`: an import whose report refuses items is then applied without them, only when \`meta.report.applicableWithoutRefused\` holds (the bundle without them decides every other item as the report does). Exactly the refused items are left out, and nothing else changes; the change set's description and every commit message list them with why, and the job checks again that the rest still stands. Without it, an import with a refused item is refused. Only the import's uploader, within the hour. ${PERMISSIONS}`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('admin.roles')
  @ApiAcceptedResponse({
    description: 'Applying: its job is queued.',
    standardSchema: ImportDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: it is not `validated` (being applied, or done already; `meta.state`). `import-expired`: uploaded more than an hour ago.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`import-not-applicable`: its report refuses something or writes nothing; `meta.skipRefused` says whether applying it with `skipRefused` would leave the refused items out and apply the rest.',
    standardSchema: ErrorDocument,
  })
  async apply(
    @CurrentActor() actor: Actor,
    @Param('importId') id: string,
    @Body({ schema: ApplyImportDocument }) body: ApplyImportDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportDocument> {
    const record = await this.applyImport.handle({
      actor,
      id,
      skipRefused: body?.meta?.skipRefused === true,
    });
    res.status(HttpStatus.ACCEPTED);
    return { data: toImportResource({ ...record, dryRun: false }) };
  }
}
