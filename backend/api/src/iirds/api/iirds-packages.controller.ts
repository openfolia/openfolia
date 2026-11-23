import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { attachmentDisposition } from '../../assets/api/asset-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import { takeSendTurn } from '../../base/api/package-send.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  refuseQuery,
  streamFailed,
} from '../../releases/api/release-outputs.controller.js';
import {
  GetIirdsPackageAction,
  IirdsSends,
  ListIirdsPackagesAction,
} from '../core/actions/iirds-packages.action.js';
import { IIRDS_MEDIA_TYPE } from '../core/iirds-package.js';
import {
  IirdsPackageDocument,
  iirdsPackageFilters,
  IirdsPackagePageDocument,
  toIirdsPackageDocument,
  toIirdsPackageResource,
} from './iirds-package.resources.js';
import { MANUAL_TOO_LARGE } from '../../manuals/api/too-large-response.js';

const RELEASE_PARAMETER = {
  name: 'releaseId',
  description:
    'The release’s ID (a UUID). One that names no release, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const PACKAGE_PARAMETER = {
  name: 'packageId',
  description:
    'The package’s ID: its release output’s (a UUID). One that names no output of the release you may read, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const WHO_READS =
  'Needs `content.read` at the release’s tag, in a role that covers all of the output’s manual: its audience and language, with no module type or facet left out, and the source language too, as for the release’s outputs. A package is made as the manual’s audience reads it, the same for all of its readers. Others get 404, exactly like a missing one.';

const NOT_CONFIGURED = {
  description:
    '`iirds-not-configured`: the configuration at the release’s tag holds no iiRDS mapping (`iirds` in `openfolia.yaml`).',
  standardSchema: ErrorDocument,
} as const;

const BUSY = {
  description:
    '`rate-limited`: too many packages are being made at once; `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
} as const;

const FILE_BUSY = {
  description:
    '`rate-limited`: too many packages are being made at once, or this kind of package sent: at most 4 at once, server-wide, and at most `CCMS_PACKAGE_SENDS_PER_ACTOR` (default 1) of them yours. Answered before any header of the file. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no release with this ID, or no output of it you may read.',
  standardSchema: ErrorDocument,
} as const;

const TOO_LARGE =
  '`iirds-package-too-large`: the package would be larger than `CCMS_RELEASE_ARCHIVE_MAX_BYTES` (`meta.size`, `meta.limit` in bytes, `meta.files`).';

@ApiTags('releases')
@Controller('releases')
@JsonApi()
export class IirdsPackagesController {
  constructor(
    private readonly listPackages: ListIirdsPackagesAction,
    private readonly getPackage: GetIirdsPackageAction,
  ) {}

  @Get(':releaseId/iirds-packages')
  @Paged()
  @Filters(
    { name: 'manual', description: 'Only this manual’s packages.' },
    { name: 'lang', description: 'Only packages in this language.' },
  )
  @ApiOperation({
    summary: 'List a release’s iiRDS packages',
    description: `One iiRDS package per release output (a manual in one of its variants and a configured language), its \`id\` the output’s: the manual’s modules as HTML topics, its PDF as a rendition once that is done, and the metadata (\`META-INF/metadata.rdf\`, iiRDS 1.3) the configured mapping makes. Listing makes none: each is made when it is read. Ordered by manual, variant, language. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: IirdsPackagePageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiUnprocessableEntityResponse(NOT_CONFIGURED)
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('releaseId') releaseId: string,
    @Query('filter[manual]', {
      schema: iirdsPackageFilters.manual.optional(),
    })
    manual?: string,
    @Query('filter[lang]', { schema: iirdsPackageFilters.lang.optional() })
    lang?: string,
  ): Promise<z.infer<typeof IirdsPackagePageDocument>> {
    const result = await this.listPackages.handle({
      actor,
      releaseId,
      page,
      filter: {
        ...(manual !== undefined && { manual }),
        ...(lang !== undefined && { lang }),
      },
    });
    return toPagedDocument(req, page, result, (output) =>
      toIirdsPackageResource(result.release, output),
    );
  }

  @Get(':releaseId/iirds-packages/:packageId')
  @ApiOperation({
    summary: 'Make a release’s iiRDS package and describe it',
    description: `Makes the package (or takes it from the last few made) and says what it holds: \`meta.size\`, \`meta.topics\`, \`meta.media\` and \`meta.warnings\`, what the configured mapping could not map (left out of the metadata, never silently) and what is not in it (a file not stored, the PDF not done). ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(PACKAGE_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: IirdsPackageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiTooManyRequestsResponse(BUSY)
  @ApiUnprocessableEntityResponse({
    description: `${NOT_CONFIGURED.description} ${TOO_LARGE} ${MANUAL_TOO_LARGE}`,
    standardSchema: ErrorDocument,
  })
  async get(
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Param('packageId') packageId: string,
  ): Promise<z.infer<typeof IirdsPackageDocument>> {
    return toIirdsPackageDocument(
      await this.getPackage.handle({ actor, releaseId, packageId }),
    );
  }
}

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('releases')
@Controller('releases')
export class IirdsPackageFileController {
  constructor(
    private readonly getPackage: GetIirdsPackageAction,
    private readonly sends: IirdsSends,
  ) {}

  @Get(':releaseId/iirds-packages/:packageId/file')
  @ApiOperation({
    summary: 'Download a release’s iiRDS package',
    description: `The package as an iiRDS ZIP archive (\`${IIRDS_MEDIA_TYPE}\`): \`mimetype\` first, then \`META-INF/metadata.rdf\`, the topics (\`content/<module>.html\`), the media they show (\`media/<sha256>.<ext>\`, \`symbols/<id>.<ext>\`) and the PDF (\`pdf/<manual>_<variant>_<lang>_<revision>.pdf\`, once done), every entry stored. The same release output makes the same bytes. \`Content-Disposition: attachment\` with \`<manual>_<variant>_<lang>_<revision>.iirds\`, \`Content-Length\` its exact length, \`X-Ccms-Iirds-Warnings\` how many warnings \`GET …/iirds-packages/{packageId}\` lists. Not cached (\`private, no-store\`): it gains the PDF once that is done. A blob store failing once part of it went out cuts the connection, and so does a download not read for a while, read too slowly or going on too long (\`CCMS_PACKAGE_SEND_*\`), freeing its turn. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(PACKAGE_PARAMETER)
  @ApiProduces(IIRDS_MEDIA_TYPE)
  @ApiOkResponse({
    description: 'The package.',
    content: {
      [IIRDS_MEDIA_TYPE]: { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
      'X-Ccms-Iirds-Warnings': {
        description: 'How many warnings the package has.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'An unsupported query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiUnprocessableEntityResponse({
    description: `${NOT_CONFIGURED.description} ${TOO_LARGE} ${MANUAL_TOO_LARGE}`,
    standardSchema: ErrorDocument,
  })
  @ApiTooManyRequestsResponse(FILE_BUSY)
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`: the blob store does not answer; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async file(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Param('packageId') packageId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    // A turn first (429 past the bounds), before any header of the file is set.
    const turn = await takeSendTurn(res, this.sends, actor, () =>
      this.getPackage.handle({ actor, releaseId, packageId }),
    );
    if (turn === undefined) return undefined;
    const { made, body } = turn;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Ccms-Iirds-Warnings', String(made.plan.warnings.length));
    return new StreamableFile(body, {
      type: IIRDS_MEDIA_TYPE,
      length: made.size,
      disposition: attachmentDisposition(made.fileName),
    }).setErrorHandler(
      streamFailed(res, `The iiRDS package of output ${made.output.id}`, [
        'Content-Length',
        'Content-Disposition',
        'Cache-Control',
        'X-Ccms-Iirds-Warnings',
      ]),
    );
  }
}
