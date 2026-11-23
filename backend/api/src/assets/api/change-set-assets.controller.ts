import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsBodyOf,
  AcceptsQuery,
  JsonApi,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import type { Env } from '../../config/env.js';
import { GetChangeSetAssetAction } from '../core/actions/get-change-set-asset.action.js';
import { UploadAssetAction } from '../core/actions/upload-asset.action.js';
import { UPLOAD_KINDS, type UploadKind } from '../core/asset-upload.js';
import type { AttachmentTypeRules } from '../core/attachment-types.js';
import { assetFile } from './asset-file.js';
import {
  ChangeSetAssetDocument,
  toChangeSetAssetResource,
} from './change-set-asset.resources.js';
import { FILE_FIELD, multipartFile } from './multipart-file.js';
import { WIDTH_QUERY, WidthParam } from './width.js';

const CHANGE_SET_PARAMETER = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no change set with this ID (or another author’s, for an actor without `content.read.draft`).',
  standardSchema: ErrorDocument,
};

/**
 * Images uploaded into a change set (#25): `POST` stores one in the blob
 * store and records it; `GET` lets its author preview it before a module
 * refers to it.
 */
@ApiTags('assets')
@Controller('change-sets/:changeSetId/assets')
export class ChangeSetAssetsController {
  private readonly maxBytes: Readonly<Record<UploadKind, number>>;
  private readonly attachmentTypes: AttachmentTypeRules;

  constructor(
    private readonly uploadAsset: UploadAssetAction,
    private readonly getChangeSetAsset: GetChangeSetAssetAction,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = {
      image: config.get('CCMS_MAX_UPLOAD_BYTES', { infer: true }),
      attachment: config.get('CCMS_MAX_ATTACHMENT_BYTES', { infer: true }),
      font: config.get('CCMS_MAX_FONT_BYTES', { infer: true }),
    };
    this.attachmentTypes = {
      allow: config.get('CCMS_ATTACHMENT_TYPES_ALLOW', { infer: true }),
      deny: config.get('CCMS_ATTACHMENT_TYPES_DENY', { infer: true }),
      open: config.get('CCMS_ATTACHMENT_TYPES_OPEN', { infer: true }),
    };
  }

  @Post()
  @JsonApi()
  @AcceptsBodyOf('multipart/form-data')
  @AcceptsQuery('kind')
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: UPLOAD_KINDS,
    description:
      '`image` (default): a PNG or JPEG for an image block. `attachment`: a file of any type the settings take, for an attachment block. `font`: a TrueType, OpenType, WOFF or WOFF2 font for a page design.',
  })
  @ApiOperation({
    summary: 'Upload an image, an attachment or a font into a change set',
    description: `Stores the file in the blob store under its SHA-256 and answers with \`reference\` (\`sha256:<hash>\`), for an image or attachment block's \`asset\` in a module's working copy; nothing is committed to Git (the module commits the reference at a save point). Send it as \`multipart/form-data\` with one file part named \`${FILE_FIELD}\` and nothing else; its file name is kept (made a valid file name: \`fileName\`). The part's \`Content-Type\` is ignored. **An image** (\`kind=image\`, the default) is recognised from the bytes: PNG or JPEG; SVG and anything else is 422 \`unsupported-image-type\`; at most \`CCMS_MAX_UPLOAD_BYTES\` (default 10 MiB). **An attachment** (\`kind=attachment\`) may be any type: its media type is decided from the bytes and the file name's extension (bytes showing HTML, SVG, an executable or a script win over any name); dangerous types (HTML, SVG, executables, installers, scripts) and what the \`CCMS_ATTACHMENT_TYPES_*\` settings refuse are 422 \`unsupported-attachment-type\` (\`meta.contentType\`, \`meta.extension\`, \`meta.reason\`); at most \`CCMS_MAX_ATTACHMENT_BYTES\` (default 50 MiB). **A font** (\`kind=font\`, for a page design's \`fonts\`) is recognised from its structure, never its name: a TrueType or OpenType font (\`font/ttf\`, \`font/otf\`), WOFF or WOFF2 (\`font/woff\`, \`font/woff2\`) whose tables are all within the file and which has a family name; a collection or anything else is 422 \`unsupported-font-type\` (\`meta.accepted\`, \`meta.reason\`: \`not-a-font\` or \`malformed\`); at most \`CCMS_MAX_FONT_BYTES\` (default 10 MiB) and 100 fonts per change set. A larger file is 422 \`too-large\` (\`meta.max\`), and reading stops there. Only the change set's author, while it is a draft (409 \`invalid-state\` otherwise, as for locks and saves), and at most 1,000 files per change set (409 \`too-many-uploads\`); with a storage limit set (\`CCMS_STORAGE_LIMIT_BYTES\`), a file that would take the installation past it is 409 \`storage-limit-reached\` (\`meta.limit\`), nothing is stored and the refusal is audited (\`storage.upload-refused\`): 403 for anyone else who holds \`content.read.draft\`, 404 for anyone who does not. Recorded with an \`asset.upload\` audit event. The same file again is 200 with the first upload, and nothing new is stored or audited. Needs the \`content.edit\` permission.`,
  })
  @ApiParam(CHANGE_SET_PARAMETER)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [FILE_FIELD],
      properties: { [FILE_FIELD]: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    description: 'Uploaded.',
    standardSchema: ChangeSetAssetDocument,
    headers: {
      Location: {
        description: 'Where its author previews it.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiOkResponse({
    description:
      'The change set holds this image already: the first upload, unchanged.',
    standardSchema: ChangeSetAssetDocument,
  })
  @ApiBadRequestResponse({
    description:
      '`invalid-body`: not one file part named `file` and nothing else, or the form is malformed or cut off.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: the change set is not a draft; `meta.state` says what it is. `too-many-uploads`: it holds 1,000 files already, or 100 fonts for a font (`meta.max`), refused before reading (an image it holds already too: its author has the reference). `storage-limit-reached`: the upload would take the installation past its storage limit (`meta.limit` in bytes); refused before reading once the limit is reached, and nothing is stored.',
    standardSchema: ErrorDocument,
  })
  @ApiResponse({
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    description: '`unsupported-media-type`: not `multipart/form-data`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`unsupported-image-type`: an image neither PNG nor JPEG (`meta.accepted`); `unsupported-font-type`: a font that is no well-formed TrueType, OpenType, WOFF or WOFF2 font (`meta.accepted`, `meta.reason`); `unsupported-attachment-type`: an attachment of a type the settings refuse (`meta.contentType`, `meta.extension`, `meta.reason`: `dangerous`, `denied` or `not-allowed`); `too-large`: more than `CCMS_MAX_UPLOAD_BYTES` for an image, `CCMS_MAX_ATTACHMENT_BYTES` for an attachment, `CCMS_MAX_FONT_BYTES` for a font (`meta.max`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`: the blob store does not answer; `database-timeout`: the transaction waited too long; `upload-interrupted`: the image was removed while it was recorded (another refused upload of it cleaned up). `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async upload(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Query('kind', { schema: z.enum(UPLOAD_KINDS).optional() })
    kind: UploadKind | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChangeSetAssetDocument> {
    const uploading = kind ?? 'image';
    const maxBytes = this.maxBytes[uploading];
    let fileName: string | undefined;
    try {
      const { upload, created } = await this.uploadAsset.handle({
        actor,
        changeSetId,
        kind: uploading,
        maxBytes,
        attachmentTypes: this.attachmentTypes,
        fileName: () => fileName,
        file: () =>
          multipartFile(req, maxBytes, (info) => {
            fileName = info.fileName;
          }),
      });
      if (created) {
        res.status(HttpStatus.CREATED);
        res.setHeader(
          'Location',
          `/change-sets/${upload.changeSetId}/assets/${upload.sha256}`,
        );
      } else {
        res.status(HttpStatus.OK);
      }
      return { data: toChangeSetAssetResource(upload) };
    } catch (error) {
      // What was not read yet is not read at all: the connection closes
      // after the answer instead of taking in the rest of the body.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Get(':hash')
  @ApiOperation({
    summary: 'Preview an image or a file uploaded into a change set',
    description:
      "An image or an attachment uploaded into this change set, for its author to see before a module refers to it (`GET /assets/{hash}` serves it only once a module the reader may see refers to it). PNG and JPEG are shown in place; any other type is sent as `Content-Disposition: attachment` under the upload's file name (else the hash). Only to the change set's author, as their working copies are: 403 for anyone else who holds `content.read.draft`, 404 for anyone who does not. Any hash not uploaded into this change set is 404. Streamed as `GET /assets/{hash}` does (stored type, `nosniff`, a sandboxing `Content-Security-Policy`), `Cache-Control: private, no-cache`. Needs the `content.read` permission.",
  })
  @ApiParam(CHANGE_SET_PARAMETER)
  @ApiParam({
    name: 'hash',
    description: 'SHA-256 of the file, 64 lowercase hex characters.',
  })
  @ApiQuery(WIDTH_QUERY)
  @ApiOkResponse({
    description:
      'The file, with its stored type: an image in place, anything else as a download; with `width`, its WebP rendition.',
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`unsupported-parameter`: a query other than `width`; `invalid-parameter`: a width other than 320, 640 or 1280, or one asked of a file that has no renditions.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such change set (as for the upload), or no such file uploaded into it.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.read')
  async preview(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('hash') hash: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const [parameter] = Object.keys(req.query).filter((p) => p !== 'width');
    if (parameter !== undefined) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'unsupported-parameter',
          detail: `This route does not support the query parameter "${parameter}".`,
          source: { parameter },
        },
      ]);
    }
    const parsed = WidthParam.optional().safeParse(req.query['width']);
    if (!parsed.success) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'invalid-parameter',
          detail: 'One of 320, 640, 1280.',
          source: { parameter: 'width' },
        },
      ]);
    }
    const asset = await this.getChangeSetAsset.handle({
      actor,
      changeSetId,
      hash,
      width: parsed.data,
    });
    // Its own author's bytes, yet who may read the change set can change.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Authorization, X-Ccms-User');
    return assetFile(asset, hash, res);
  }
}
