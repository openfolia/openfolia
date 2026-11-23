import { Readable } from 'node:stream';
import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ConfigKey } from '@openfolia/content-model';
import type { Request, Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetSymbolAction } from '../core/actions/get-symbol.action.js';
import { assetFile } from './asset-file.js';

@ApiTags('assets')
@Controller('symbols')
@ReadsContent()
export class SymbolsController {
  constructor(private readonly getSymbol: GetSymbolAction) {}

  @Get(':id')
  @DeliveryApi()
  @ApiOperation({
    summary: 'Read a safety symbol’s artwork',
    description:
      'The artwork of a configured safety symbol (`safetySymbols` in `GET /config`): `symbols/<id>.png` or `symbols/<id>.svg` (the PNG when both exist, as the PDF picks), in the repository at `?ref=`, as the PDF prints it. Symbols are configuration, so every reader of the ref may read them. 404 when the ID is not configured or has no artwork (the PDF prints a grey placeholder then, the HTML leaves the symbol out); 422 `invalid-content` when the bytes are not what the extension says (an `.svg` that is no SVG, a `.png` that is no PNG): the type is always read from the bytes. Served as the image routes serve images: `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so an SVG can never run a script; show it as an image, never inline its markup. Cached like every content route: `private, max-age=31536000, immutable` when `?ref=` is a commit ID, else `private, no-cache` with an ETag.',
  })
  @ApiParam({
    name: 'id',
    description: 'The safety symbol’s configured ID.',
    example: 'w001',
  })
  @ApiOkResponse({
    description: 'The artwork, as SVG or PNG.',
    content: {
      'image/svg+xml': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
    headers: CONTENT_HEADERS,
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      'Not a configuration key; `unsupported-parameter` for a query parameter other than `ref`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-content`: the file’s bytes are not the image its extension names.',
    standardSchema: ErrorDocument,
  })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: ConfigKey }) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const [parameter] = Object.keys(req.query).filter((p) => p !== 'ref');
    if (parameter !== undefined) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'unsupported-parameter',
          detail: `This route does not support the query parameter "${parameter}".`,
          source: { parameter },
        },
      ]);
    }
    const artwork = await this.getSymbol.handle({ actor, snapshot, id });
    return assetFile(
      {
        stream: Readable.from([artwork.bytes]),
        type: artwork.type,
        size: artwork.bytes.byteLength,
      },
      id,
      res,
    );
  }
}
