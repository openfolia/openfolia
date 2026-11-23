import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { assetFile } from '../../assets/api/asset-file.js';
import { FILE_FIELD, multipartFile } from '../../assets/api/multipart-file.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsBodyOf,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { NotModified } from '../../base/api/json-api.exception.js';
import { Public } from '../../base/api/public.decorator.js';
import { params } from '../../base/api/schemas.js';
import type { BrandingView } from '../core/actions/get-branding.action.js';
import { DeleteBrandingImageAction } from '../core/actions/delete-branding-image.action.js';
import { GetBrandingAction } from '../core/actions/get-branding.action.js';
import { GetBrandingImageAction } from '../core/actions/get-branding-image.action.js';
import { ListBrandingImagesAction } from '../core/actions/list-branding-images.action.js';
import { UpdateBrandingAction } from '../core/actions/update-branding.action.js';
import { UploadBrandingImageAction } from '../core/actions/upload-branding-image.action.js';
import {
  MAX_BRANDING_IMAGE_BYTES,
  MAX_BRANDING_IMAGE_SIDE,
  MAX_BRANDING_IMAGES,
} from '../core/branding.js';
import {
  BrandingDocument,
  BrandingImageDocument,
  BrandingImagePageDocument,
  toBrandingImageResource,
  toListedBrandingImageResource,
  toBrandingResource,
  toChanges,
  UpdateBrandingDocument,
} from './branding.resources.js';

const ETAG_HEADER = {
  ETag: {
    description:
      'Changes whenever the branding (or what it derives) does; send it back as `If-None-Match`.',
    schema: { type: 'string' },
  },
};

const ADMIN = 'Needs the `admin.branding` permission.';

/** The document and its ETag: a hash of what it says, so any change of it (or of the derivation) shows. */
function documentOf(view: BrandingView): {
  document: BrandingDocument;
  etag: string;
} {
  const document = { data: toBrandingResource(view) };
  const digest = createHash('sha256')
    .update(JSON.stringify(document))
    .digest('base64url')
    .slice(0, 27);
  return { document, etag: `"branding-${digest}"` };
}

/**
 * The platform's branding (#169): `GET /branding` and the images it uses for
 * anyone (the shell needs them before sign-in; nothing in them is
 * sensitive), `PATCH /branding` and the image upload for holders of
 * `admin.branding`.
 */
@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(
    private readonly getBranding: GetBrandingAction,
    private readonly updateBranding: UpdateBrandingAction,
    private readonly uploadImage: UploadBrandingImageAction,
    private readonly getImage: GetBrandingImageAction,
    private readonly listImages: ListBrandingImagesAction,
    private readonly deleteImage: DeleteBrandingImageAction,
  ) {}

  @Public()
  @Get()
  @JsonApi()
  @ApiOperation({
    summary: 'Read the branding',
    description:
      'The product name, the logos, mark and icons (as `sha256:<hash>`, served at `GET /branding/images/{hash}`) and the colours, null where the neutral default applies; `meta.tokens` holds the theme tokens the colours give for light and dark, `meta.contrast` the contrast of every pair they make. Needs no token: the editor reads it before anyone signs in, and it holds nothing sensitive. `Cache-Control: public, no-cache` with an ETag: send it back as `If-None-Match` for a 304.',
  })
  @ApiOkResponse({ standardSchema: BrandingDocument, headers: ETAG_HEADER })
  @ApiNotModifiedResponse({
    description: 'The `If-None-Match` ETag is still current.',
  })
  async read(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BrandingDocument> {
    const { document, etag } = documentOf(await this.getBranding.handle());
    res.setHeader('Cache-Control', 'public, no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) throw new NotModified(etag);
    return document;
  }

  @Patch()
  @JsonApi()
  @ApiOperation({
    summary: 'Change the branding',
    description: `The fields given; left out stays, null is the default again (every field null: reset to the defaults). An image field names an image uploaded with \`POST /branding/images\` (else 422 \`unknown-image\`); the favicon and the app icon must be square (422 \`image-not-square\`, \`meta.width\`, \`meta.height\`). The primary colour is used as given on light pages, and a lighter one of the same hue is derived for dark pages; the accent tints the light sidebar. Every pair they make is checked, text at 4.5:1 and shapes at 3:1, against the theme's own surfaces: one that falls short is 422 \`insufficient-contrast\`, an error per pair with \`meta.theme\`, \`meta.pair\`, \`meta.ratio\` and \`meta.required\`, and nothing changes. Status and safety colours are never brandable. Applies at once; audited as \`branding.update\` (each field changed, from and to). ${ADMIN}`,
  })
  @ApiOkResponse({ standardSchema: BrandingDocument, headers: ETAG_HEADER })
  @ApiUnprocessableEntityResponse({
    description:
      '`unknown-image`, `image-not-square`, `insufficient-contrast` (one error each, `source.pointer` naming the field), or the body is not a branding document.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: '`database-timeout`: the change waited too long for another.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.branding')
  async update(
    @CurrentActor() actor: Actor,
    @Body({ schema: UpdateBrandingDocument }) body: UpdateBrandingDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BrandingDocument> {
    const view = await this.updateBranding.handle({
      actor,
      changes: toChanges(body.data.attributes),
    });
    const { document, etag } = documentOf(view);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('ETag', etag);
    return document;
  }

  @Post('images')
  @JsonApi()
  @AcceptsBodyOf('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a branding image',
    description: `A logo, the mark or an icon, for \`PATCH /branding\` to name by its \`reference\` (\`sha256:<hash>\`); it shows nowhere until then. Send it as \`multipart/form-data\` with one file part named \`${FILE_FIELD}\` and nothing else, with \`X-Ccms-Request\`. The type comes from the bytes: PNG or WebP. SVG is refused, not sanitised (an SVG can carry scripts and references; export the logo as PNG), as is anything else: 422 \`unsupported-image-type\` (\`meta.accepted\`). At most ${MAX_BRANDING_IMAGE_BYTES} bytes (422 \`too-large\`, \`meta.max\`, reading stops there) and ${MAX_BRANDING_IMAGE_SIDE} pixels a side (422 \`image-too-large\`), and one still picture: an animated PNG or WebP is 422 \`animated-image\`, and a file that is not a well-formed PNG or WebP up to its end 422 \`unsupported-image-type\`. At most ${MAX_BRANDING_IMAGES} images in use or uploaded within a day (409 \`too-many-uploads\`): an unused one is removed a day after its upload, or at once with \`DELETE /branding/images/{hash}\`. Counted towards the storage limit as content files are (\`CCMS_STORAGE_LIMIT_BYTES\`): past it 409 \`storage-limit-reached\` (\`meta.limit\`), nothing kept, audited as \`storage.upload-refused\`. Recorded with a \`branding.image-upload\` audit event; the same image again is 200 with the first upload, and nothing new is stored or audited. ${ADMIN}`,
  })
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
    standardSchema: BrandingImageDocument,
  })
  @ApiOkResponse({
    description: 'This image was uploaded before: the first upload, unchanged.',
    standardSchema: BrandingImageDocument,
  })
  @ApiBadRequestResponse({
    description:
      '`invalid-body`: not one file part named `file` and nothing else, or the form is malformed or cut off.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: `\`too-many-uploads\`: ${MAX_BRANDING_IMAGES} images are in use or were uploaded within a day (\`meta.max\`); \`storage-limit-reached\`: the installation's storage limit (\`meta.limit\`).`,
    standardSchema: ErrorDocument,
  })
  @ApiResponse({
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    description: '`unsupported-media-type`: not `multipart/form-data`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`unsupported-image-type` (`meta.accepted`), `animated-image`, `too-large` (`meta.max`), `image-too-large` (`meta.maxSide`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`blob-store-unavailable`, `database-timeout`, or `upload-interrupted`: the same file was removed while it was recorded (upload again); `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.branding')
  async upload(
    @CurrentActor() actor: Actor,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BrandingImageDocument> {
    try {
      const { image, created } = await this.uploadImage.handle({
        actor,
        file: () => multipartFile(req, MAX_BRANDING_IMAGE_BYTES),
      });
      res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
      return { data: toBrandingImageResource(image) };
    } catch (error) {
      // What was not read yet is not read at all.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Get('images')
  @JsonApi()
  @Paged()
  @ApiOperation({
    summary: 'List the branding images',
    description: `The images uploaded for the branding, last uploaded first, each with the fields naming it now (\`meta.usedIn\`; none: unused, removed a day after its upload, or at once with \`DELETE /branding/images/{hash}\`). ${ADMIN}`,
  })
  @ApiOkResponse({ standardSchema: BrandingImagePageDocument })
  @ApiPermission('admin.branding')
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<BrandingImagePageDocument> {
    const result = await this.listImages.handle({ actor, page });
    return toPagedDocument(req, page, result, toListedBrandingImageResource);
  }

  @Delete('images/:hash')
  @JsonApi()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an unused branding image',
    description: `Deletes an image uploaded for the branding that no field names, however recent: its record and its file, unless a change set holds an upload of the same bytes, content refers to them (a module or page design at any branch or tag, an open change set, a working copy), or they are an import's bundle or a release's file; then the file stays. Audited as \`branding.image-delete\` (\`fileKept\`). One a field names is 409 \`branding-image-in-use\` (\`meta.usedIn\`). An unused image is also removed on its own a day after its upload. ${ADMIN}`,
  })
  @ApiParam({
    name: 'hash',
    description: 'SHA-256 of the image, 64 lowercase hex characters.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no image with this hash was uploaded for the branding (or the hash is not 64 lowercase hex characters).',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`branding-image-in-use`: a field names it (`meta.usedIn`, the fields).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`branding-image-busy` (another deletion of the same file is under way), `blob-store-unavailable`, `database-timeout`, `too-many-change-sets`; nothing was deleted. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.branding')
  async remove(
    @CurrentActor() actor: Actor,
    // Checked by the action, after the permission: a malformed hash is 404.
    @Param('hash') hash: string,
  ): Promise<void> {
    await this.deleteImage.handle({ actor, sha256: hash });
  }

  @Public()
  @Get('images/:hash')
  @ApiOperation({
    summary: 'Read a branding image',
    description:
      'An image a field of the branding names now, for anyone (the logo shows on the sign-in page); any other hash is 404, also one uploaded but not in use, and never a content image. PNG or WebP as recorded at upload, with `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy` and `Cache-Control: public, no-cache` with the hash as ETag (304 on `If-None-Match` while the branding still uses it): the bytes of a hash never change, but whether it is served does, so a removed logo is not kept by caches.',
  })
  @ApiParam({
    name: 'hash',
    description: 'SHA-256 of the image, 64 hex characters.',
  })
  @ApiOkResponse({
    description: 'The image.',
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiBadRequestResponse({
    description: 'Not a SHA-256 hash.',
    standardSchema: ErrorDocument,
  })
  @ApiNotModifiedResponse({
    description:
      'The `If-None-Match` ETag (the hash) and the image still in use.',
  })
  @ApiNotFoundResponse({
    description: '`not-found`: the branding uses no image with this hash.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: '`blob-store-unavailable`.',
    standardSchema: ErrorDocument,
  })
  async image(
    @Param('hash', { schema: params.assetHash }) hash: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const etag = `"${hash}"`;
    const blob = await this.getImage.handle({
      sha256: hash,
      cached: req.headers['if-none-match'] === etag,
    });
    res.setHeader('Cache-Control', 'public, no-cache');
    res.setHeader('ETag', etag);
    if (!blob) throw new NotModified(etag);
    return assetFile(
      { stream: blob.stream, type: blob.contentType, size: blob.size },
      hash,
      res,
    );
  }
}
