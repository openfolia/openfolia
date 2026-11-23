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
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { assetFile } from '../../assets/api/asset-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  outputFile,
  refuseQuery,
} from '../../releases/api/release-outputs.controller.js';
import { DownloadFileAction } from '../core/actions/download-file.action.js';
import { DownloadVersionsAction } from '../core/actions/download-versions.action.js';
import { ListDownloadsAction } from '../core/actions/list-downloads.action.js';
import { type DownloadKind, MAX_VERSION_RELEASES } from '../core/download.js';
import {
  DownloadIdParam,
  downloadFilters,
  DownloadPageDocument,
  DownloadVersionPageDocument,
  toDownloadResource,
  toDownloadVersionResource,
} from './download.resources.js';

const ID_PARAMETER = {
  name: 'id',
  description:
    'The download’s ID, as `GET /downloads` gives it (`attachment:<product>:<module>:<block>:<lang>`, `manual:<product>:<manual>:<lang>:<variant>`). One that names no download you may read, malformed or not, is 404.',
  schema: { type: 'string' },
} as const;

const RELEASE_PARAMETER = {
  name: 'releaseId',
  description:
    'A release of the download’s product (a UUID), e.g. a version’s ID. One that names no such release, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const WHO_READS =
  'Needs `content.read`. Read as you read released content at each release’s tag: an attachment only in a module you may see there (an attachment in a module above your audience is never listed, counted or served), a manual’s PDF only of a manual one of your roles reads whole there (its audience and language, with no module type or facet left out, as for the release’s outputs).';

@ApiTags('downloads')
@Controller('downloads')
@JsonApi()
export class DownloadsController {
  constructor(
    private readonly listDownloads: ListDownloadsAction,
    private readonly listVersions: DownloadVersionsAction,
  ) {}

  @Get()
  @Paged()
  @Filters(
    {
      name: 'product',
      description: 'Only this product’s files (a value of the product facet).',
    },
    { name: 'lang', description: 'Only files in this language.' },
    {
      name: 'kind',
      description: '`attachment` or `manual`: only files of this kind.',
    },
    {
      name: 'q',
      description:
        'Only files whose name, description, file name, module title or module or manual ID holds every word (case and accents aside).',
    },
    {
      name: 'mediaType',
      description:
        'Only files of this media type (`application/pdf`), or of a top-level type (`image/*`).',
    },
  )
  @ApiOperation({
    summary: 'List the downloads',
    description: `The download centre (#139): every downloadable file of each product at its latest release (the newest that stands, cut from \`main\`). One per attachment block of a module for the product (its product facet names the product, or no product), in each language it has a file in, and one per PDF of a manual, variant and language that is rendered (\`done\`). A read model over attachments and release outputs: nothing is uploaded here. Filtered before paging, so neither the list nor the total tells of a file outside your scope. Ordered by product, then attachments (by module, language and block order) before manuals (by manual, variant and language). ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: DownloadPageDocument })
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: a filter that is not one of its form; `unsupported-parameter`: a query parameter this route does not take.',
    standardSchema: ErrorDocument,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[product]', { schema: downloadFilters.product.optional() })
    product?: string,
    @Query('filter[lang]', { schema: downloadFilters.lang.optional() })
    lang?: string,
    @Query('filter[kind]', { schema: downloadFilters.kind.optional() })
    kind?: DownloadKind,
    @Query('filter[q]', { schema: downloadFilters.q.optional() })
    q?: string,
    @Query('filter[mediaType]', {
      schema: downloadFilters.mediaType.optional(),
    })
    mediaType?: string,
  ): Promise<z.infer<typeof DownloadPageDocument>> {
    const result = await this.listDownloads.handle({
      actor,
      page,
      filter: {
        ...(product !== undefined && { product }),
        ...(lang !== undefined && { lang }),
        ...(kind !== undefined && { kind }),
        ...(q !== undefined && { q }),
        ...(mediaType !== undefined && { mediaType }),
      },
    });
    return toPagedDocument(req, page, result, toDownloadResource);
  }

  @Get(':id/versions')
  @Paged()
  @ApiOperation({
    summary: 'List a download’s versions',
    description: `The download’s file across its product’s releases cut from \`main\` (withdrawn ones too), newest first: a version where the file’s hash differs from the version before, from the release it first appeared in, with that release’s date, the checksum, the size, whether it is \`current\`, \`superseded\` or \`withdrawn\`, and its change note (the release’s notes, in the download’s language when it has them, and the attachment’s description). The ${MAX_VERSION_RELEASES} newest releases are looked through (\`meta.truncated\` when there are more). A version you may not read is neither listed nor counted; a download the product’s latest release does not hold for you is 404, as it has no row in the list. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: DownloadVersionPageDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no download with this ID you may read.',
    standardSchema: ErrorDocument,
  })
  async versions(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('id', { schema: DownloadIdParam }) id: string,
  ): Promise<z.infer<typeof DownloadVersionPageDocument>> {
    const result = await this.listVersions.handle({ actor, id, page });
    const document = toPagedDocument(req, page, result, (version) =>
      toDownloadVersionResource(id, version),
    );
    return {
      ...document,
      meta: { ...document.meta, truncated: result.truncated },
    };
  }
}

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('downloads')
@Controller('downloads')
export class DownloadFileController {
  constructor(private readonly downloadFile: DownloadFileAction) {}

  @Get(':id/versions/:releaseId/file')
  @ApiOperation({
    summary: 'Download a file',
    description: `The download’s file as the release holds it. An attachment: from the blob store, always \`Content-Disposition: attachment\` under the block’s file name when it fits the stored type (else the hash), \`X-Content-Type-Options: nosniff\` and a sandboxing \`Content-Security-Policy\`, as \`GET /assets/{hash}\` sends an attached file. A manual’s PDF: exactly as \`GET /releases/{releaseId}/outputs/{outputId}/file\` sends it (409 \`output-not-ready\` until it is rendered). Cached for good (\`private, max-age=31536000, immutable\`, the hash as \`ETag\`): a release’s file never changes. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(ID_PARAMETER)
  @ApiParam(RELEASE_PARAMETER)
  @ApiOkResponse({
    description: 'The file, with its stored type.',
    content: {
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
      ETag: {
        description: 'The file’s SHA-256, quoted.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'An unsupported query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such download, no such release of its product, or nothing of it there you may read; its file is not stored.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`output-not-ready`: the manual’s PDF is not rendered yet (`meta.state`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`: the blob store does not answer; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async file(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('id', { schema: DownloadIdParam }) id: string,
    @Param('releaseId') releaseId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    refuseQuery(req);
    const found = await this.downloadFile.handle({ actor, id, releaseId });
    if (found.kind === 'manual') return outputFile(found.file, res);
    // Private: who may read it is decided per request; the bytes of a hash never change.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('ETag', `"${found.hash}"`);
    return assetFile(found.asset, found.hash, res);
  }
}
