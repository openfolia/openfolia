import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import { WIDTH_QUERY, WidthParam, type Width } from './width.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetAssetAction } from '../core/actions/get-asset.action.js';
import { assetFile } from './asset-file.js';
import type { Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';

@ApiTags('assets')
@Controller('assets')
@ReadsContent()
export class AssetsController {
  constructor(private readonly getAsset: GetAssetAction) {}

  @Get(':hash')
  @DeliveryApi()
  @ApiOperation({
    summary: 'Read an image',
    description:
      'With `width` (320, 640 or 1280): the image as a WebP at most that wide (never upscaled; at most four times as tall), made on first request and kept in the blob store, after the same checks as the original (404 where the original is 404); a file other than a PNG, JPEG, GIF or WebP image has none (400). Images are content-addressed: modules refer to them as `sha256:<hash>`, and the bytes live in the blob store (older content: `assets/<hash>` in the repository). Only an image a module the reader may see refers to is served; any other is 404, like a missing one. Streamed with the stored type (sniffed for the old layout), `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so author-supplied SVGs can never run scripts; a type other than an image is sent as an attachment. A file an attachment block the reader may see attaches is always a download (`Content-Disposition: attachment` with an RFC 8187 `filename*`), under the file name of the first such block that fits the stored type, else the hash. Cached like every content route: `private, max-age=31536000, immutable` when `?ref=` is a commit ID, else `private, no-cache` with an ETag (who may see an image can change, its bytes cannot).',
  })
  @ApiParam({
    name: 'hash',
    description: 'SHA-256 of the file, 64 hex characters.',
  })
  @ApiOkResponse({
    description:
      'The image or attached file, with its stored type (any type for an attachment).',
    content: {
      'image/*': { schema: { type: 'string', format: 'binary' } },
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
    headers: CONTENT_HEADERS,
  })
  @ApiPermission('content.read')
  @AcceptsQuery('width')
  @ApiQuery(WIDTH_QUERY)
  @ApiBadRequestResponse({
    description:
      'Not a SHA-256 hash; `invalid-parameter` (`source.parameter` `width`): a width other than 320, 640 or 1280, or a rendition of a file that has none (SVG, anything but PNG, JPEG, GIF and WebP).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'With `width`: `too-large`, the image has more pixels (`meta.maxPixels`) or bytes (`meta.max`) than a rendition is made of; `unprocessable-image`, it cannot be decoded within the limits. Use the original.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`; with `width`, `rendition-busy`: too many renditions are being made (`Retry-After`).',
    standardSchema: ErrorDocument,
  })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('hash', { schema: params.assetHash }) hash: string,
    @Query('width', { schema: WidthParam.optional() }) width: Width | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const asset = await this.getAsset.handle({
      actor,
      snapshot,
      hash,
      width,
    });
    // Caching as for every content route (SnapshotInterceptor): immutable
    // for a commit-ID ref, else revalidated by an ETag holding the reader's
    // scope. The bytes of a hash never change, but whether this reader may
    // see them does (a module drops the image, a role narrows), so a branch
    // read is never cached for long.
    return assetFile(asset, hash, res);
  }
}
