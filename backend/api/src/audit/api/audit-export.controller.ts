import { Readable } from 'node:stream';
import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
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
import { AcceptsQuery, Filters } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ExportAuditEventsAction } from '../core/actions/export-audit-events.action.js';
import { READ_AUDIT_LOG } from '../core/actions/list-audit-events.action.js';
import type { AuditEvent, AuditKind } from '../core/audit-event.js';
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_EXPORT_FORMATS,
  type AuditExportFormat,
  auditCsvHeader,
  auditCsvLine,
  auditJsonLine,
} from '../core/audit-export.js';
import { AuditReaderGuard } from './audit-reader.guard.js';
import {
  AUDIT_FILTER_DOCS,
  auditFilters,
  toAuditFilter,
} from './audit-event.resources.js';

type Parsed<K extends keyof typeof auditFilters> = z.output<
  (typeof auditFilters)[K]
>;

/** What the export takes; a file route gets no JSON:API check of its query. */
const EXPORT_QUERY = new Set([
  'format',
  ...AUDIT_FILTER_DOCS.map((f) => `filter[${f.name}]`),
]);

export const AuditFormatParam = z.enum(AUDIT_EXPORT_FORMATS, {
  error: `Give the format: ${AUDIT_EXPORT_FORMATS.map((f) => `\`${f}\``).join(' or ')}.`,
});

/** Each format's media type and file extension. */
export const AUDIT_EXPORT_TYPES: Readonly<
  Record<AuditExportFormat, { type: string; extension: string }>
> = {
  csv: { type: 'text/csv; charset=utf-8; header=present', extension: 'csv' },
  jsonl: { type: 'application/jsonl; charset=utf-8', extension: 'jsonl' },
};

/** About this many characters are sent per chunk, not one write per event. */
const CHUNK_CHARS = 64 * 1024;

/**
 * `GET /audit-events/export` (#379): the audit log as a file, so not
 * JSON:API; its errors still are, up to the first byte. Streamed: events
 * are read in batches as the client takes them, never the whole log in
 * memory.
 */
@ApiTags('audit')
@Controller('audit-events')
export class AuditExportController {
  private readonly logger = new Logger(AuditExportController.name);

  constructor(private readonly exportAuditEvents: ExportAuditEventsAction) {}

  @Get('export')
  @UseGuards(AuditReaderGuard)
  @AcceptsQuery('format')
  @Filters(...AUDIT_FILTER_DOCS)
  @ApiOperation({
    summary: 'Export audit events',
    description: `Every event the filters select (the same filters as \`GET /audit-events\`, so the file holds exactly what the list pages through), newest first, as a download (\`Content-Disposition: attachment\`, \`nosniff\`, \`Cache-Control: no-store\`), streamed. \`csv\`: RFC 4180, a header row, lines ending in CRLF, columns ${AUDIT_CSV_COLUMNS.map((c) => `\`${c}\``).join(', ')} (\`at\` in ISO 8601 UTC, \`data\` as JSON text; a value a spreadsheet would run as a formula starts with \`'\`). \`jsonl\`: JSON Lines, one event per line with \`id\` and the members of \`AuditEventAttributes\`. The export itself is recorded first, as \`audit-log.export\` (\`data\`: the format and the filters given); when that fails, nothing is sent (500). A failure once the file has begun cuts the connection off, so a broken download never looks complete. \`HEAD\` is 405 (\`Allow: GET\`): every answer records an export. Needs the \`${READ_AUDIT_LOG}\` permission.`,
  })
  @ApiQuery({
    name: 'format',
    required: true,
    description: '`csv` or `jsonl`.',
    schema: { type: 'string', enum: [...AUDIT_EXPORT_FORMATS] },
  })
  @ApiProduces('text/csv', 'application/jsonl')
  @ApiOkResponse({
    description: 'The file.',
    content: {
      'text/csv': { schema: { type: 'string' } },
      'application/jsonl': { schema: { type: 'string' } },
    },
  })
  @ApiPermission(READ_AUDIT_LOG)
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: no or an unknown `format`, or a malformed filter; `unsupported-parameter` for any other query parameter.',
    standardSchema: ErrorDocument,
  })
  async export(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Query('format', { schema: AuditFormatParam }) format: AuditExportFormat,
    @Query('filter[subject]', { schema: auditFilters.subject.optional() })
    subject?: Parsed<'subject'>,
    @Query('filter[actor]', { schema: auditFilters.actor.optional() })
    by?: Parsed<'actor'>,
    @Query('filter[action]', { schema: auditFilters.action.optional() })
    action?: string,
    @Query('filter[kind]', { schema: auditFilters.kind.optional() })
    kind?: AuditKind,
    @Query('filter[from]', { schema: auditFilters.from.optional() })
    from?: Date,
    @Query('filter[to]', { schema: auditFilters.to.optional() })
    to?: Date,
  ): Promise<StreamableFile> {
    // Express answers HEAD with this handler: that would record an export
    // nobody received.
    if (req.method === 'HEAD') {
      res.setHeader('Allow', 'GET');
      throw new JsonApiException(HttpStatus.METHOD_NOT_ALLOWED, [
        {
          code: 'method-not-allowed',
          detail: 'An export is only made for GET: it is recorded each time.',
        },
      ]);
    }
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
    const events = await this.exportAuditEvents.handle({
      actor,
      format,
      filter: toAuditFilter({ subject, actor: by, action, kind, from, to }),
    });
    // The first batch is read before the answer begins: a database that
    // fails then is still a JSON:API error, not a cut-off file.
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();
    const { type, extension } = AUDIT_EXPORT_TYPES[format];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(
      Readable.from(chunks(format, first, iterator), { objectMode: false }),
      {
        type,
        disposition: attachmentDisposition(
          `audit-log-${fileTime(new Date())}.${extension}`,
        ),
      },
    ).setErrorHandler((error, response) => {
      // Cut off, never ended cleanly: a broken export must not look
      // complete. Before the first byte (the first line failed to
      // serialize), a bare 500.
      this.logger.error(
        'An audit log export failed midway; the connection was cut.',
        error instanceof Error ? error.stack : String(error),
      );
      if (response.destroyed) return;
      if (response.headersSent && response.destroy) {
        response.destroy();
      } else {
        response.statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
        response.end();
      }
    });
  }
}

/**
 * The file's text: the header (CSV) and the first event at once, so the
 * answer has begun before a later batch is read (a failure after that cuts
 * the connection), then chunks of about `CHUNK_CHARS`.
 */
async function* chunks(
  format: AuditExportFormat,
  first: IteratorResult<AuditEvent>,
  rest: AsyncIterator<AuditEvent>,
): AsyncGenerator<string> {
  const line = format === 'csv' ? auditCsvLine : auditJsonLine;
  const header = format === 'csv' ? auditCsvHeader() : '';
  try {
    if (first.done) {
      if (header) yield header;
      return;
    }
    yield header + line(first.value);
    let buffer = '';
    for (let next = await rest.next(); !next.done; next = await rest.next()) {
      buffer += line(next.value);
      if (buffer.length >= CHUNK_CHARS) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) yield buffer;
  } finally {
    // A client gone midway stops the reading too.
    await rest.return?.();
  }
}

/** `2026-11-20T10:15:00.123Z` as `20261120T101500Z`, for a file name. */
function fileTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}
