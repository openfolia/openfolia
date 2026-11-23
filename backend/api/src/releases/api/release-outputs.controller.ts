import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { attachmentDisposition } from '../../assets/api/asset-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import {
  ErrorDocument,
  JSON_API,
  toPagedDocument,
} from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ReleaseArchiveAction } from '../core/actions/release-archive.action.js';
import {
  ListReleaseOutputsAction,
  type ReleaseOutputFile,
  ReleaseOutputFileAction,
  ReplanReleaseOutputsAction,
  RetryReleaseOutputAction,
} from '../core/actions/release-outputs.action.js';
import type { OutputKind, OutputState } from '../core/release-output.js';
import {
  outputFilters,
  ReleaseOutputPageDocument,
  ReleaseOutputDocument,
  toReleaseOutputResource,
  toRetriedOutputResource,
} from './release-output.resources.js';

const RELEASE_PARAMETER = {
  name: 'releaseId',
  description:
    'The release’s ID (a UUID). One that names no release, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const OUTPUT_PARAMETER = {
  name: 'outputId',
  description:
    'The output’s ID (a UUID). One that names no output of the release you may read, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const WHO_READS =
  'Needs `content.read` at the release’s tag, in a role that covers all of the output’s manual: its audience and language, with no module type or facet left out, and the source language too (a module not translated falls back to it). An output is rendered as the manual’s audience reads it, the same file for all of its readers, so it may hold any module the manual names; a reader whose scope leaves some out reads the manual’s PDF route instead. Others get 404, exactly like a missing one.';

/** What `POST …/outputs/plan` answers: whether a planning job was queued. */
const ReplanDocument = z
  .strictObject({ meta: z.strictObject({ queued: z.boolean() }) })
  .meta({ id: 'ReleaseOutputsReplanDocument' });

const NOT_FOUND = {
  description:
    '`not-found`: no release with this ID, or no output of it you may read.',
  standardSchema: ErrorDocument,
} as const;

@ApiTags('releases')
@Controller('releases')
@JsonApi()
export class ReleaseOutputsController {
  constructor(
    private readonly listOutputs: ListReleaseOutputsAction,
    private readonly retryOutput: RetryReleaseOutputAction,
    private readonly replanOutputs: ReplanReleaseOutputsAction,
  ) {}

  @Post(':releaseId/outputs/plan')
  @ApiOperation({
    summary: 'Plan a release’s outputs again',
    description:
      'Queues the planning of the release’s outputs again, with a `release.outputs-plan` audit event: for a release whose planning failed for good (the outputs list is short or empty). Planning adds only the outputs the release does not have and renders only those, so it never renders one twice. `meta.queued` false: its planning is queued or running already. A release of more outputs (every manual at its tag × its variants × the configured languages) than a release may have (`CCMS_RELEASE_MAX_OUTPUTS`) is 422 `too-many-outputs`, and nothing is queued. Takes no body (send `Content-Type: application/vnd.api+json`). Needs the `release.publish` permission in a role whose scope covers the release’s product in every language, module type and audience, and `content.read`.',
  })
  @ApiParam(RELEASE_PARAMETER)
  @ApiPermission('release.publish')
  @ApiAcceptedResponse({
    description: 'Planning queued (or already queued).',
    standardSchema: ReplanDocument,
  })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no role with `release.publish` covers the release’s product everywhere.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiUnprocessableEntityResponse({
    description:
      '`too-many-outputs`: the release would have more outputs than a release may have; `meta.wanted` (how many) and `meta.max` (the limit, `CCMS_RELEASE_MAX_OUTPUTS`).',
    standardSchema: ErrorDocument,
  })
  async replan(
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof ReplanDocument>> {
    const { queued } = await this.replanOutputs.handle({ actor, releaseId });
    res.status(HttpStatus.ACCEPTED);
    return { meta: { queued } };
  }

  @Get(':releaseId/outputs')
  @Paged()
  @Filters(
    { name: 'manual', description: 'Only this manual’s outputs.' },
    { name: 'lang', description: 'Only outputs in this language.' },
    {
      name: 'kind',
      description:
        'Only outputs of this kind (`pdf`, `offline-package`).',
    },
    {
      name: 'state',
      description:
        'Only outputs in this state (`queued`, `rendering`, `done`, `failed`).',
    },
  )
  @ApiOperation({
    summary: 'List a release’s outputs',
    description: `The release’s files (#249): one PDF per manual, variant and configured language, rendered in the background once the release is cut (\`state\`), and one offline package (#59, \`kind\` \`offline-package\`) per configured language and audience level up to the highest any manual has, built once the PDFs are done: a ZIP of the manuals that level reads, as HTML pages and PDFs, that opens from the file system without a network (\`attributes.audience\`; \`manual\` and \`variant\` null). A reader sees a package only when one role of theirs reads its whole level in its language. A manual the release did not change (in that language) reuses the previous release’s file (\`meta.reusedFrom\`), so every release has a full set. A withdrawn release’s outputs stay readable, marked \`meta.withdrawn\`. Ordered by manual, variant, language. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ReleaseOutputPageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('releaseId') releaseId: string,
    @Query('filter[manual]', { schema: outputFilters.manual.optional() })
    manual?: string,
    @Query('filter[lang]', { schema: outputFilters.lang.optional() })
    lang?: string,
    @Query('filter[state]', { schema: outputFilters.state.optional() })
    state?: OutputState,
    @Query('filter[kind]', { schema: outputFilters.kind.optional() })
    kind?: OutputKind,
  ): Promise<z.infer<typeof ReleaseOutputPageDocument>> {
    const result = await this.listOutputs.handle({
      actor,
      releaseId,
      page,
      filter: {
        ...(manual !== undefined && { manual }),
        ...(lang !== undefined && { lang }),
        ...(kind !== undefined && { kind }),
        ...(state !== undefined && { state }),
      },
    });
    return toPagedDocument(req, page, result, (output) =>
      toReleaseOutputResource(
        result.release,
        output,
        output.kind === 'pdf' ? result.designs.get(output.manualId) : undefined,
      ),
    );
  }

  @Post(':releaseId/outputs/:outputId/retry')
  @ApiOperation({
    summary: 'Render a failed output again',
    description:
      'Queues a `failed` output again (`queued`, its error cleared, `meta.retries` one more), with a `release.output-retry` audit event; it renders in the background, at the release’s tag as before. A publisher who may not read the output (no role of theirs covers all of its manual, as for `GET …/outputs`) gets only its `state` and counts back. Only a failed output: one queued, rendering or done is 409 `output-not-failed`. Takes no body (send `Content-Type: application/vnd.api+json`). Needs the `release.publish` permission in a role whose scope covers the release’s product in every language, module type and audience, and `content.read`.',
  })
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(OUTPUT_PARAMETER)
  @ApiPermission('release.publish')
  @ApiAcceptedResponse({
    description: 'Queued again.',
    standardSchema: ReleaseOutputDocument,
  })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no role with `release.publish` covers the release’s product everywhere.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`output-not-failed`: the output is not `failed` (`meta.state`). `retry-limit`: it was queued again 10 times already (`meta.retries`). `output-busy`: its last attempt is still ending; try again in a moment.',
    standardSchema: ErrorDocument,
  })
  async retry(
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Param('outputId') outputId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof ReleaseOutputDocument>> {
    const retried = await this.retryOutput.handle({
      actor,
      releaseId,
      outputId,
    });
    res.status(HttpStatus.ACCEPTED);
    return { data: toRetriedOutputResource(retried) };
  }
}

const logger = new Logger('ReleaseOutputs');

/** A query parameter on a binary route, which takes none: 400 for each. */
export function refuseQuery(req: Request): void {
  const unsupported = Object.keys(req.query);
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
}

/**
 * A blob store failing mid-stream: the connection cut when part of the
 * file went out (no client keeps a short body), else a 503
 * `blob-store-unavailable` in place of the file's headers.
 */
export function streamFailed(
  res: Response,
  what: string,
  headers: readonly string[],
): (error: Error) => void {
  return (error) => {
    logger.error(`${what} failed while streaming: ${error.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    for (const name of headers) res.removeHeader(name);
    res
      .status(503)
      .set({
        'Content-Type': JSON_API,
        'Cache-Control': 'no-store',
        'Retry-After': '5',
      })
      .end(
        JSON.stringify({
          errors: [
            {
              status: '503',
              title: 'Service Unavailable',
              code: 'blob-store-unavailable',
              detail: 'The blob store failed; try again.',
            },
          ],
        }),
      );
  };
}

/** Binary, so not JSON:API; its errors still are. */
@ApiTags('releases')
@Controller('releases')
export class ReleaseOutputFileController {
  constructor(
    private readonly outputFile: ReleaseOutputFileAction,
    private readonly archive: ReleaseArchiveAction,
  ) {}

  @Get(':releaseId/outputs/archive')
  @ApiOperation({
    summary: 'Download all of a release’s files as one ZIP',
    description: `Every output of the release you may read (as \`GET …/outputs\` lists them) that is \`done\`, in one ZIP, its files stored as they were rendered (no compression: PDFs are compressed already), named \`<manual>/<lang>/<variant>.pdf\` (ASCII letters, digits, \`.\` and \`-\` per part, anything else \`-\`; a name taken already, ignoring case, gets \`-2\`, \`-3\`, … before the extension). \`Content-Disposition: attachment\` with \`<product>_<revision>.zip\`, \`Content-Length\` the archive's exact length. Streamed from the blob store one file at a time. Outputs still queued or rendering, or failed, are left out: \`X-Ccms-Archive-Files\` says how many files it holds, \`X-Ccms-Archive-Left-Out\` how many of those you may read are not in it. Not cached (\`private, no-store\`): it holds more files once more are done. A blob store failing once part of it went out cuts the connection. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'The archive.',
    content: {
      'application/zip': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: '`attachment` with the file name.',
        schema: { type: 'string' },
      },
      'X-Ccms-Archive-Files': {
        description: 'How many files the archive holds.',
        schema: { type: 'integer' },
      },
      'X-Ccms-Archive-Left-Out': {
        description:
          'How many of the release’s outputs you may read are not in it: queued, rendering or failed.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description: 'An unsupported query parameter.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no release with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`release-archive-empty`: none of the outputs you may read is done yet, or there are none (`meta.total`, `meta.notReady`).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`release-archive-too-large`: the archive would be larger than `CCMS_RELEASE_ARCHIVE_MAX_BYTES` (`meta.size`, `meta.limit`, in bytes); download the files one by one.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`: the blob store does not answer; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async zip(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('releaseId') releaseId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    refuseQuery(req);
    const archive = await this.archive.handle({ actor, releaseId });
    // Never cached: who may read it is decided per request, and it grows
    // while the release's files are rendered.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Ccms-Archive-Files', String(archive.files));
    res.setHeader('X-Ccms-Archive-Left-Out', String(archive.leftOut));
    return new StreamableFile(Readable.from(archive.stream), {
      type: 'application/zip',
      length: archive.size,
      disposition: attachmentDisposition(archive.fileName),
    }).setErrorHandler(
      streamFailed(res, `The archive of release ${archive.release.id}`, [
        'Content-Length',
        'Content-Disposition',
        'Cache-Control',
        'X-Ccms-Archive-Files',
        'X-Ccms-Archive-Left-Out',
      ]),
    );
  }

  @Get(':releaseId/outputs/:outputId/file')
  @ApiOperation({
    summary: 'Download a release output',
    description: `The output’s file from the blob store, as it was rendered (never rendered on request): \`Content-Disposition: attachment\` with a readable name (\`<manual>_<variant>_<lang>_<revision>.pdf\`; an offline package \`offline_<audience>_<lang>_<revision>.zip\`, \`application/zip\`), and cached for good (\`private, max-age=31536000, immutable\`: an output’s file never changes). 409 \`output-not-ready\` until the output is \`done\`. ${WHO_READS}`,
  })
  @DeliveryApi()
  @ApiParam(RELEASE_PARAMETER)
  @ApiParam(OUTPUT_PARAMETER)
  @ApiProduces('application/pdf', 'application/zip')
  @ApiOkResponse({
    description: 'The file: a PDF, or an offline package’s ZIP.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'application/zip': { schema: { type: 'string', format: 'binary' } },
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
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`output-not-ready`: the output is not `done` (`meta.state`).',
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
    @Param('releaseId') releaseId: string,
    @Param('outputId') outputId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    refuseQuery(req);
    return outputFile(
      await this.outputFile.handle({ actor, releaseId, outputId }),
      res,
    );
  }
}

/**
 * A release output's file as the response (#249), for `GET …/outputs/:outputId/file` and a
 * download's PDF (#139): `attachment` under its name, cached for good (private: who may read
 * it is decided per request; the bytes never change), its hash as the ETag, `nosniff`.
 */
export function outputFile(
  { output, blob, fileName }: ReleaseOutputFile,
  res: Response,
): StreamableFile {
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('ETag', `"${output.sha256}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return new StreamableFile(blob.stream, {
    type: output.kind === 'pdf' ? 'application/pdf' : 'application/zip',
    length: blob.size,
    disposition: attachmentDisposition(fileName),
  }).setErrorHandler(
    streamFailed(res, `Output ${output.id}`, [
      'Content-Length',
      'Content-Disposition',
      'ETag',
      'Cache-Control',
    ]),
  );
}
