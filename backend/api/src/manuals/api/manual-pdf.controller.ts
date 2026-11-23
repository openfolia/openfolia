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
import { PAGE_WIDTH } from '@openfolia/render-typst';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
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
import type { Request, Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { MANUAL_TOO_LARGE } from './too-large-response.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { params } from '../../base/api/schemas.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import {
  DEFAULT_PAGE_WIDTH,
  DESIGN_QUERY_DESCRIPTION,
  DesignQuery,
  MAX_PAGE,
  pageImageParams,
} from './manual.resources.js';
import { RenderManualPageAction } from '../core/actions/render-manual-page.action.js';
import { RenderManualPdfAction } from '../core/actions/render-manual-pdf.action.js';

/** What the page route takes; binary routes get no JSON:API check of their query. */
const PAGE_QUERY = new Set(['ref', 'workingCopy', 'width', 'design']);

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('manuals')
@Controller('manuals')
@ReadsContent()
export class ManualPdfController {
  constructor(
    private readonly renderPdf: RenderManualPdfAction,
    private readonly renderPage: RenderManualPageAction,
  ) {}

  @Get(':id/variants/:variant/:lang/pdf')
  @DeliveryApi()
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'Render a manual as PDF',
    description:
      "The resolved manual typeset with the repository's template (or the built-in one), tagged and conforming to PDF/UA-1 unless `pdf.standard` in `openfolia.yaml` is `none`. Cached per commit; the first request for a commit renders it.",
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'The PDF.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      ...CONTENT_HEADERS,
      'X-Ccms-Issues': {
        description: 'How many issues resolving the manual found.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'Malformed manual ID, variant slug or language.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      'The renderer is busy or the server is shutting down; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      "`invalid-content`: a file needed for the answer is broken; the error's `meta.path` names it. `pdf-accessibility`: the manual cannot meet the configured PDF standard (`pdf.standard`, PDF/UA-1 by default); the error's `meta.problems` has the renderer's reasons (`message`, `hints`). `render-timeout`: the document takes too long to render. " +
      MANUAL_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  @ApiInternalServerErrorResponse({
    description:
      "Compiling failed; the error's `meta.diagnostics` has the compiler's messages.",
    standardSchema: ErrorDocument,
  })
  async pdf(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { pdf, issueCount, filename } = await this.renderPdf.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
    });
    res.setHeader('X-Ccms-Issues', String(issueCount));
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
    });
  }

  @Get(':id/variants/:variant/:lang/pdf/pages/:page.png')
  @ReadsWorkingCopies()
  @AcceptsQuery('width', 'design')
  @ApiOperation({
    summary: 'Render a page of a manual’s PDF as PNG',
    description:
      'One page of the PDF `GET …/pdf` gives (the same reader, `?ref=` and `?workingCopy=`), rasterised, for thumbnails: page 1 is the title page. `?design=` lays it out with another page design, for the design screen’s preview. Cached per commit like the PDF. Sent with `nosniff` and a sandboxing `Content-Security-Policy`.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({
    name: 'page',
    description: `The page, from 1 (the title page) to ${MAX_PAGE}.`,
    example: '1',
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE },
  })
  @ApiQuery({
    name: 'width',
    required: false,
    description: `The image's width in pixels (${PAGE_WIDTH.min}–${PAGE_WIDTH.max}, default ${DEFAULT_PAGE_WIDTH}); the height follows the page.`,
    schema: {
      type: 'integer',
      minimum: PAGE_WIDTH.min,
      maximum: PAGE_WIDTH.max,
    },
  })
  @ApiQuery({
    name: 'design',
    required: false,
    description: DESIGN_QUERY_DESCRIPTION,
    schema: { type: 'string' },
  })
  @ApiProduces('image/png')
  @ApiOkResponse({
    description: 'The page as PNG.',
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
    headers: CONTENT_HEADERS,
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'Malformed manual ID, variant slug, language, page or width.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      'No such manual, or the PDF has fewer pages (`meta.pages` says how many).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: MANUAL_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      'The renderer is busy or the server is shutting down; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiInternalServerErrorResponse({
    description:
      "Compiling failed; the error's `meta.diagnostics` has the compiler's messages.",
    standardSchema: ErrorDocument,
  })
  async page(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('page', { schema: pageImageParams.page }) page: number,
    @Query('width', { schema: pageImageParams.width })
    width: number | undefined,
    @Query('design', { schema: DesignQuery }) design: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const unsupported = Object.keys(req.query).filter(
      (k) => !PAGE_QUERY.has(k),
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
    const { png } = await this.renderPage.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
      page,
      width: width ?? DEFAULT_PAGE_WIDTH,
      ...(design !== undefined && { design }),
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(png, {
      type: 'image/png',
      disposition: 'inline',
    });
  }
}
