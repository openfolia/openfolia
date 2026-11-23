import {
  Controller,
  Get,
  HttpStatus,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { attachmentDisposition } from '../../assets/api/asset-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { params } from '../../base/api/schemas.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  ExportTermsAction,
  TERM_EXPORT_FORMATS,
  type TermExportFormat,
} from '../core/actions/export-terms.action.js';

/** What the export takes; a binary route gets no JSON:API check of its query. */
const EXPORT_QUERY = new Set(['ref', 'format', 'lang']);

export const FormatParam = z.enum(TERM_EXPORT_FORMATS, {
  error: `Give the format: ${TERM_EXPORT_FORMATS.map((f) => `\`${f}\``).join(' or ')}.`,
});

/**
 * `GET /terms/export`: a file, so not JSON:API; its errors still are.
 * Registered before `TermsController`, so `export` never reads as a term
 * ID (the content model reserves it, too).
 */
@ApiTags('terms')
@Controller('terms')
@ReadsContent()
export class TermExportController {
  constructor(private readonly exportTerms: ExportTermsAction) {}

  @Get('export')
  @DeliveryApi()
  @AcceptsQuery('format', 'lang')
  @ApiOperation({
    summary: 'Export the terms',
    description:
      "Every term at `?ref=`, by ID, as a download (`Content-Disposition: attachment`): TBX-Basic (ISO 30042:2019, DCA style; one `conceptEntry` per term, a `termSec` per variant with its administrative status: preferred, admitted, deprecated for a forbidden one, superseded for a deprecated term’s) or CSV (a header row, then one row per term and language; variants one per line in their cell; a value a spreadsheet would run as a formula starts with `'`). Definitions are plain text. Files that are no term are left out. Sent with `nosniff`; `X-Ccms-Terms` says how many terms it holds.",
  })
  @ApiQuery({
    name: 'format',
    required: true,
    description: '`tbx` or `csv`.',
    schema: { type: 'string', enum: [...TERM_EXPORT_FORMATS] },
  })
  @ApiQuery({
    name: 'lang',
    required: false,
    description:
      'Only this language (a language tag); a term without it is left out. Default: every language.',
    schema: { type: 'string' },
  })
  @ApiProduces('application/x-tbx+xml', 'text/csv')
  @ApiOkResponse({
    description: 'The file.',
    content: {
      'application/x-tbx+xml': { schema: { type: 'string' } },
      'text/csv': { schema: { type: 'string' } },
    },
    headers: {
      ...CONTENT_HEADERS,
      'X-Ccms-Terms': {
        description: 'How many terms the file holds.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: no or an unknown `format`, or a malformed `lang`; `unsupported-parameter` for any other query parameter.',
    standardSchema: ErrorDocument,
  })
  async export(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Query('format', { schema: FormatParam }) format: TermExportFormat,
    @Query('lang', { schema: params.lang.optional() }) lang: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const unsupported = Object.keys(req.query).filter(
      (k) => !EXPORT_QUERY.has(k),
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
    const file = await this.exportTerms.handle({
      actor,
      snapshot,
      format,
      lang,
    });
    const body = Buffer.from(file.body, 'utf8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Ccms-Terms', String(file.count));
    return new StreamableFile(body, {
      type: file.type,
      length: body.length,
      disposition: attachmentDisposition(file.fileName),
    });
  }
}
