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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
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
  AcceptsQuery,
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { streamFailed } from '../../releases/api/release-outputs.controller.js';
import {
  DitaSends,
  GetDitaPackageAction,
  ListDitaPackagesAction,
} from '../core/actions/dita-packages.action.js';
import {
  DITA_PACKAGE_MEDIA_TYPE,
  type DitaLanguages,
  type DitaReferences,
} from '../core/dita-package.js';
import {
  DITA_OPTION_QUERIES,
  ditaOptionParams,
  DitaPackageDocument,
  ditaPackageFilters,
  DitaPackagePageDocument,
  toDitaPackageDocument,
  toDitaPackageResource,
} from './dita-package.resources.js';

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

const TOO_LARGE = {
  description:
    '`dita-package-too-large`: the package would read more modules, or write more, than one package may, or be larger than `CCMS_RELEASE_ARCHIVE_MAX_BYTES` (`meta` says which bound). `dita-notices-unsupported`: the manual is a derived manual gathering safety notices (`rule.notices`, #670), which a DITA package of whole modules cannot hold.',
  standardSchema: ErrorDocument,
} as const;

const BAD_OPTION = {
  description:
    '`invalid-parameter`: `languages` or `references` is not one of its values; `unsupported-parameter` for any other query parameter.',
  standardSchema: ErrorDocument,
} as const;

const FILE_QUERY = new Set(['languages', 'references']);

@ApiTags('releases')
@Controller('releases')
@JsonApi()
export class DitaPackagesController {
  constructor(
    private readonly listPackages: ListDitaPackagesAction,
    private readonly getPackage: GetDitaPackageAction,
  ) {}

  @Get(':releaseId/dita-packages')
  @Paged()
  @Filters(
    { name: 'manual', description: 'Only this manual’s packages.' },
    { name: 'lang', description: 'Only packages in this language.' },
  )
  @ApiOperation({
    summary: 'List a release’s DITA packages',
    description: `One DITA 1.3 package per release output (a manual in one of its variants and a configured language), its \`id\` the output’s: the manual as a map (\`<lang>/<manual>.ditamap\`), a topic per module of the topic type its module type maps to (\`<lang>/<module>.dita\`), the media they show and a DITAVAL file for the variant (\`filters/\`), by the configuration’s DITA mapping (\`dita\` in \`openfolia.yaml\`) read backwards. Listing makes none: each is made when it is read. Ordered by manual, variant, language. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: DitaPackagePageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('releaseId') releaseId: string,
    @Query('filter[manual]', {
      schema: ditaPackageFilters.manual.optional(),
    })
    manual?: string,
    @Query('filter[lang]', { schema: ditaPackageFilters.lang.optional() })
    lang?: string,
  ): Promise<z.infer<typeof DitaPackagePageDocument>> {
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
      toDitaPackageResource(result.release, output),
    );
  }

  @Get(':releaseId/dita-packages/:packageId')
  @AcceptsQuery('languages', 'references')
  @ApiOperation({
    summary: 'Make a release’s DITA package and describe it',
    description: `Makes the package (or takes it from the last few made) and says what it holds: \`meta.size\`, \`meta.languages\`, \`meta.topics\`, \`meta.media\` and \`meta.warnings\`, what DITA could not say as the content does and was written in another form or left out (never silently). ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(PACKAGE_PARAMETER)
  @ApiQuery(DITA_OPTION_QUERIES[0])
  @ApiQuery(DITA_OPTION_QUERIES[1])
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: DitaPackageDocument })
  @ApiBadRequestResponse(BAD_OPTION)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiTooManyRequestsResponse(BUSY)
  @ApiUnprocessableEntityResponse(TOO_LARGE)
  async get(
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Param('packageId') packageId: string,
    @Query('languages', { schema: ditaOptionParams.languages.optional() })
    languages?: DitaLanguages,
    @Query('references', { schema: ditaOptionParams.references.optional() })
    references?: DitaReferences,
  ): Promise<z.infer<typeof DitaPackageDocument>> {
    return toDitaPackageDocument(
      await this.getPackage.handle({
        actor,
        releaseId,
        packageId,
        options: {
          languages: languages ?? 'output',
          references: references ?? 'conref',
        },
      }),
    );
  }
}

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('releases')
@Controller('releases')
export class DitaPackageFileController {
  constructor(
    private readonly getPackage: GetDitaPackageAction,
    private readonly sends: DitaSends,
  ) {}

  @Get(':releaseId/dita-packages/:packageId/file')
  @ApiOperation({
    summary: 'Download a release’s DITA package',
    description: `The package as a ZIP archive (\`${DITA_PACKAGE_MEDIA_TYPE}\`), every entry stored, sorted by name: per language a folder with the map (\`<lang>/<manual>.ditamap\`, naming the DITAVAL file) and the topics (\`<lang>/<module>.dita\`), then \`filters/<variant>.ditaval\`, \`images/<sha256>.<ext>\`, \`files/<sha256>.<ext>\` and \`symbols/<name>\`. Valid DITA 1.3 (the OASIS grammars), importable again by the \`dita\` importer. The same release output and options make the same bytes. \`Content-Disposition: attachment\` with \`<manual>_<variant>_<lang>_<revision>-dita.zip\`, \`Content-Length\` its exact length, \`X-Ccms-Dita-Warnings\` how many warnings \`GET …/dita-packages/{packageId}\` lists. A blob store failing once part of it went out cuts the connection, and so does a download not read for a while, read too slowly or going on too long (\`CCMS_PACKAGE_SEND_*\`), freeing its turn. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(PACKAGE_PARAMETER)
  @ApiQuery(DITA_OPTION_QUERIES[0])
  @ApiQuery(DITA_OPTION_QUERIES[1])
  @ApiProduces(DITA_PACKAGE_MEDIA_TYPE)
  @ApiOkResponse({
    description: 'The package.',
    content: {
      [DITA_PACKAGE_MEDIA_TYPE]: {
        schema: { type: 'string', format: 'binary' },
      },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
      'X-Ccms-Dita-Warnings': {
        description: 'How many warnings the package has.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse(BAD_OPTION)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiUnprocessableEntityResponse(TOO_LARGE)
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
    @Query('languages', { schema: ditaOptionParams.languages.optional() })
    languages?: DitaLanguages,
    @Query('references', { schema: ditaOptionParams.references.optional() })
    references?: DitaReferences,
  ): Promise<StreamableFile | undefined> {
    const unsupported = Object.keys(req.query).filter(
      (k) => !FILE_QUERY.has(k),
    );
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
    // A turn first (429 past the bounds), before any header of the file is set.
    const turn = await takeSendTurn(res, this.sends, actor, () =>
      this.getPackage.handle({
        actor,
        releaseId,
        packageId,
        options: {
          languages: languages ?? 'output',
          references: references ?? 'conref',
        },
      }),
    );
    if (turn === undefined) return undefined;
    const { made, body } = turn;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Ccms-Dita-Warnings', String(made.plan.warnings.length));
    return new StreamableFile(body, {
      type: DITA_PACKAGE_MEDIA_TYPE,
      length: made.size,
      disposition: attachmentDisposition(made.fileName),
    }).setErrorHandler(
      streamFailed(res, `The DITA package of output ${made.output.id}`, [
        'Content-Length',
        'Content-Disposition',
        'Cache-Control',
        'X-Ccms-Dita-Warnings',
      ]),
    );
  }
}
