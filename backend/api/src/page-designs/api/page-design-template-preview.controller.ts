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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { DesignTemplateId, PageDesignId } from '@openfolia/content-model';
import { PAGE_WIDTH } from '@openfolia/render-typst';
import type { Request, Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import {
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  DEFAULT_PAGE_WIDTH,
  MAX_PAGE,
  pageImageParams,
} from '../../manuals/api/manual.resources.js';
import { PreviewDesignTemplateAction } from '../core/actions/design-template-files.actions.js';

/** What the preview route takes; a binary route gets no JSON:API check of its query. */
const PREVIEW_QUERY = new Set(['ref', 'workingCopy', 'width', 'design']);

/**
 * A page design template's live preview (#396): binary, so not JSON:API; its errors still are.
 */
@ApiTags('page-designs')
@Controller('page-design-templates')
@ReadsContent()
export class PageDesignTemplatePreviewController {
  constructor(private readonly preview: PreviewDesignTemplateAction) {}

  @Get(':templateId/preview/pages/:page.png')
  @ReadsWorkingCopies()
  @AcceptsQuery('width', 'design')
  @ApiOperation({
    summary: 'Preview a page design template as a page image',
    description:
      'One page of a small manual that uses every function of the template contract (running text with each inline mark, every safety severity and admonition, steps, a list, a table, a section, an FAQ entry), laid out with the template `templateId` at `?ref=` (#396), as PNG: the template screen’s live preview. With `workingCopy=true` (the change set’s author) the working copies of the template’s files stand in for theirs. `?design=` lays it out with that page design’s settings (its colours, fonts, logo, regions); the built-in design’s by default. The template compiles in the renderer’s sandbox (its own folder’s files and the design’s files only, nothing of the host or the network, within the time and memory limits). Sent with `nosniff` and a sandboxing `Content-Security-Policy`.',
  })
  @ApiParam({
    name: 'templateId',
    example: 'house',
    description: 'The template’s folder name (`templates/<templateId>/`).',
  })
  @ApiParam({
    name: 'page',
    description: `The page, from 1 (the title page) to ${MAX_PAGE}.`,
    example: '1',
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE },
  })
  @ApiQuery({
    name: 'width',
    required: false,
    description: `The image’s width in pixels (${PAGE_WIDTH.min}–${PAGE_WIDTH.max}, default ${DEFAULT_PAGE_WIDTH}); the height follows the page.`,
    schema: {
      type: 'integer',
      minimum: PAGE_WIDTH.min,
      maximum: PAGE_WIDTH.max,
    },
  })
  @ApiQuery({
    name: 'design',
    required: false,
    description:
      'The page design (`design/<id>.yaml` at `ref`, its working copy with `workingCopy=true`) whose settings lay the probe out; the template replaces its own. Default: the built-in design.',
    schema: { type: 'string' },
  })
  @ApiProduces('image/png')
  @ApiOkResponse({
    description: 'The page as PNG.',
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'Malformed template ID, page, width or design.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: the template has no `manual.typ`, the design is not there, or the page is past the last (`meta.pages` says how many there are).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`template-error`: the template does not compile, does not finish in time, exhausts the memory limit, or its folder is past the caps (200 files, 16 MiB); `meta.problems` has each problem’s `file` (its repository path), `line` and `column` (1-based; 0: no place), `message` and `trace`.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      'The renderer is busy or the server is shutting down; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async page(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @Param('page', { schema: pageImageParams.page }) page: number,
    @Query('width', { schema: pageImageParams.width })
    width: number | undefined,
    @Query('design', { schema: PageDesignId.optional() })
    design: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const unsupported = Object.keys(req.query).filter(
      (k) => !PREVIEW_QUERY.has(k),
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
    const png = await this.preview.handle({
      actor,
      snapshot,
      templateId,
      ...(design !== undefined && { designId: design }),
      page,
      width: width ?? DEFAULT_PAGE_WIDTH,
    });
    // Read through working copies, never cached: `ReadsWorkingCopies` sets `private, no-cache`.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(png, {
      type: 'image/png',
      disposition: 'inline',
    });
  }
}
