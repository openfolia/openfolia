import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiNotFoundResponse,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorDocument } from '../../base/api/json-api.js';
import { NotFoundError } from '../../base/core/errors.js';
import { PreviewFiles } from '../core/html-renderer.js';

/**
 * The stylesheets and fonts the preview pages link, from the theme and the
 * renderer's package: the same bytes for every reader, so they need an actor
 * (like every route but `/health`) but no permission, and are never content.
 */
@ApiTags('preview')
@Controller('preview')
export class PreviewFilesController {
  constructor(private readonly files: PreviewFiles) {}

  @Get('fonts/:name')
  @DeliveryApi()
  @ApiOperation({
    summary: 'A font of the preview pages',
    description: 'A theme font; see `GET /preview/{name}`.',
  })
  @ApiParam({ name: 'name', example: 'Geist-Variable.woff2' })
  @ApiOkResponse({
    content: { 'font/woff2': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiNotModifiedResponse({
    description: 'The `If-None-Match` ETag is current.',
  })
  @ApiNotFoundResponse({
    description: 'No such file.',
    standardSchema: ErrorDocument,
  })
  font(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('name') name: string,
  ): StreamableFile | undefined {
    return this.send(req, res, `fonts/${name}`);
  }

  @Get(':name')
  @DeliveryApi()
  @ApiOperation({
    summary: 'A stylesheet of the preview pages',
    description:
      '`theme.css` (the theme’s CSS variables), `theme-dark.css` (its dark values on `:root`, linked for `theme=auto` under `prefers-color-scheme: dark`), `render-html.css` (the renderer’s) and `page.css` (the page’s own background). Revalidated with an ETag of the bytes.',
  })
  @ApiParam({ name: 'name', example: 'render-html.css' })
  @ApiOkResponse({
    content: { 'text/css': { schema: { type: 'string' } } },
  })
  @ApiNotModifiedResponse({
    description: 'The `If-None-Match` ETag is current.',
  })
  @ApiNotFoundResponse({
    description: 'No such file.',
    standardSchema: ErrorDocument,
  })
  stylesheet(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('name') name: string,
  ): StreamableFile | undefined {
    return this.send(req, res, name);
  }

  private send(
    req: Request,
    res: Response,
    path: string,
  ): StreamableFile | undefined {
    // Only what the map holds is served; a name is never a path on disk.
    const file = this.files.get(path);
    if (!file) throw new NotFoundError('No such file.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.vary('Authorization');
    res.vary('X-Ccms-User');
    if (req.headers['if-none-match'] === file.etag) {
      res.status(304);
      return undefined;
    }
    return new StreamableFile(file.body, {
      type: file.type,
      length: file.body.byteLength,
    });
  }
}
