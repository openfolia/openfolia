import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ProjectConfig } from '@openfolia/content-model';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import { OptionalActor } from '../../access/api/optional-actor.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { authorize } from '../../access/core/policy.js';
import {
  assetFile,
  attachmentDisposition,
} from '../../assets/api/asset-file.js';
import { GetAssetAction } from '../../assets/core/actions/get-asset.action.js';
import { GetSymbolAction } from '../../assets/core/actions/get-symbol.action.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import {
  JsonApiException,
  NotModified,
} from '../../base/api/json-api.exception.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { ConflictError, NotFoundError } from '../../base/core/errors.js';
import type { PageRequest } from '../../base/core/paging.js';
import { HtmlRoute } from '../../preview/api/html-route.js';
import {
  pageHtml,
  PreviewResponder,
  PreviewTheme,
  relativeRoot,
} from '../../preview/api/preview-page.js';
import { THEME_QUERY } from '../../preview/api/preview.controller.js';
import { PreviewManualAction } from '../../preview/core/actions/preview-manual.action.js';
import { PreviewFiles } from '../../preview/core/html-renderer.js';
import {
  refuseQuery,
  streamFailed,
} from '../../releases/api/release-outputs.controller.js';
import { ListStableAddressesAction } from '../core/actions/list-stable-addresses.action.js';
import { DeliveryLimit } from '../core/delivery-limit.js';
import {
  type FoundAddress,
  type OpenedAddress,
  OpenStableAddressAction,
  StableAddressAccessAction,
  StableAddressPdfAction,
} from '../core/actions/open-stable-address.action.js';
import {
  absoluteUrl,
  type AddressKind,
  addressPath,
  PAGE_FILES,
  parseAddress,
  type StableAddress,
  StableAddressSettings,
} from '../core/stable-address.js';
import { deliveryClient } from './delivery-client.js';
import { IgnoredQueryInterceptor } from './ignored-query.interceptor.js';
import { qrImage, type QrFormat } from './qr-images.js';
import { pageEtag } from './page-etag.js';
import { pickerPage, withdrawnPage } from './reader-pages.js';
import {
  addressFilters,
  StableAddressPageDocument,
  toStableAddressResource,
} from './stable-address.resources.js';

/**
 * A day for a page's image in a reader's own cache: a blob's bytes never change, but who may
 * read them can. A shared cache keeps a public one only `CCMS_DELIVERY_SHARED_MAX_AGE` (#552).
 */
const ASSET_MAX_AGE = 'max-age=86400';

const WHO_READS =
  'Who may open it is `delivery.access` in `openfolia.yaml` on `main`, at most the deployment’s `CCMS_DELIVERY_MAX_ACCESS` (default `public`, no cap): `public`, anyone, without a token, as a reader of the `delivery.publicAudience` level (default the first audience), always: a session, a token or any other credential sent with the request is ignored (never checked, counted or refused), so a signed-in person sees exactly what the public sees and the answer varies by no credential (no `Vary: Cookie` or `Authorization`); `signed-in` (default), a reader with a token or a signed-in session, in their scope (401 without one); `off`, nobody (404). Only released content is ever shown, a release’s tag, never a branch or a draft; a manual, variant or language the reader may not see is 404, exactly like a missing one, and so is a moved address, until the reader may see what it leads to.';

const ADDRESS_PARAMS = [
  {
    name: 'product',
    description: 'The product: a value of the product facet.',
    example: 'north',
  },
  {
    name: 'manual',
    description:
      'The manual’s address: `delivery.manuals.<id>.slug`, else its ID; a former one (`formerly`) is 301 to the current.',
    example: 'operating',
  },
  {
    name: 'variant',
    description: 'The variant’s slug (`model=large`).',
    example: 'model=large',
  },
  {
    name: 'lang',
    description:
      'The language; `<lang>@<revision>` pins one release (`en@2.1`), else the product’s latest release (the newest of `main` not withdrawn). Another case of a configured language is 301 to it; one the release does not have is the language picker (300) or 302 to the source language (`delivery.missingLanguage`).',
    example: 'en',
  },
] as const;

const Address =
  () =>
  (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    for (const param of ADDRESS_PARAMS) {
      ApiParam({ ...param, schema: { type: 'string' } })(
        target,
        key,
        descriptor,
      );
    }
    ApiUnauthorizedResponse({
      description:
        '`delivery.access` is `signed-in` and the request has no token.',
      standardSchema: ErrorDocument,
    })(target, key, descriptor);
    ApiNotFoundResponse({
      description: `\`not-found\`: no manual at this address for this reader. ${'`not-found`'} also when \`delivery.access\` is \`off\`.`,
      standardSchema: ErrorDocument,
    })(target, key, descriptor);
    ApiResponse({
      status: HttpStatus.MOVED_PERMANENTLY,
      description:
        'The address moved for good: a former address of the manual (`delivery.manuals.<id>.formerly`), its ID where it has a slug, or another letter case of the language. `Location` is the current address, relative to this one.',
      headers: { Location: LOCATION },
    })(target, key, descriptor);
    ApiResponse({
      status: HttpStatus.FOUND,
      description:
        'A language the release does not have, with `delivery.missingLanguage: source`: `Location` is the same address in the source language, relative to this one.',
      headers: { Location: LOCATION },
    })(target, key, descriptor);
    ApiBadRequestResponse({
      description: `\`unsupported-parameter\`: a query parameter the route does not take, or a value it does not take (the page’s \`theme\`). ${IGNORED_QUERY}`,
      standardSchema: ErrorDocument,
    })(target, key, descriptor);
  };

/** A redirect's `Location` header. */
const LOCATION = {
  description: 'Where the address is now, relative to the request’s path.',
  schema: { type: 'string' },
} as const;

/** The query parameters every address ignores (`IgnoredQueryInterceptor`). */
const IGNORED_QUERY =
  'The parameters `CCMS_DELIVERY_IGNORED_QUERY` names (default `utm_*`: the tracking parameters a shared link picks up) are ignored, so such a link opens as the address without them: an exception to the API’s rule, as these are reader-facing addresses, not the JSON:API.';

/** A pinned release that was withdrawn, under an address (its PDF, images, QR codes). */
const GONE_FILE = {
  status: HttpStatus.GONE,
  description:
    '`release-withdrawn`: the pinned release was withdrawn; the latest address (without `@<revision>`) opens the current one.',
  standardSchema: ErrorDocument,
} as const;

const QR_OK = {
  description: 'The QR code, made by the API (no network call).',
  content: {
    'image/svg+xml': { schema: { type: 'string' } },
    'image/png': { schema: { type: 'string', format: 'binary' } },
  },
} as const;

/**
 * Past the rate limit (#574), on the routes that make the server work: the page, the PDF and
 * the QR codes. A page's images, symbols, stylesheets and fonts never count.
 */
const RateLimited = () =>
  ApiTooManyRequestsResponse({
    description:
      '`rate-limited`: more pages, PDFs and QR codes under `/d/` this minute than `CCMS_DELIVERY_PER_MINUTE` allows one client on this server (default 60): a request without a token by its address (`CCMS_TRUST_PROXY` says which proxies in front to believe about it), one with a token or a session by its actor (on a `public` address, which reads no credentials, everyone by their address). A 304 revalidation of a page or a PDF counts nothing. `Retry-After` (and `meta.retryAfter`) says when to try again.',
    headers: {
      'Retry-After': {
        description: 'Seconds until the next request fits.',
        schema: { type: 'integer' },
      },
    },
    standardSchema: ErrorDocument,
  });

const QR_CONFLICT = {
  description:
    '`public-url-not-set`: `CCMS_PUBLIC_URL` is not set, so there is no address to hold.',
  standardSchema: ErrorDocument,
} as const;

type AddressParams = {
  product: string;
  manual: string;
  variant: string;
  lang: string;
};

const notFound = () => new NotFoundError('No manual at this address.');

/** An ETag of bytes or text, quoted. */
const etagOf = (body: string | Uint8Array) =>
  `"${createHash('sha256').update(body).digest('hex')}"`;

/** Who reads a stable address and with what configuration (`StableAddressAccessAction`). */
interface Reading {
  readonly reader: Actor;
  readonly config: ProjectConfig;
  /** `public` access: the public reader, whoever asks, so responses may be shared by caches. */
  readonly everyone: boolean;
}

/**
 * Serves the stable addresses (#450): a manual's page, PDF, images and QR codes, under
 * `/d/`, for readers who follow a link or a printed QR code. Not JSON:API (except the
 * errors); `@OptionalActor()`, so a public address opens without a token, and answers as the
 * public whatever credentials come with it (#608: `ActorGuard` looks at none). The tracking
 * parameters a shared link picks up are ignored (`IgnoredQueryInterceptor`).
 */
@ApiTags('stable-addresses')
@Controller('d')
@OptionalActor(StableAddressAccessAction)
@UseInterceptors(IgnoredQueryInterceptor)
export class StableAddressesController {
  constructor(
    private readonly access: StableAddressAccessAction,
    private readonly openAddress: OpenStableAddressAction,
    private readonly pdf: StableAddressPdfAction,
    private readonly preview: PreviewManualAction,
    private readonly responder: PreviewResponder,
    private readonly assets: GetAssetAction,
    private readonly symbols: GetSymbolAction,
    private readonly files: PreviewFiles,
    private readonly settings: StableAddressSettings,
    private readonly limit: DeliveryLimit,
  ) {}

  @Get(`${PAGE_FILES}/fonts/:name`)
  @DeliveryApi()
  @ApiOperation({
    summary: 'A font of the stable address pages',
    description: `The theme’s font, as \`GET /preview/fonts/{name}\` serves it, for the pages under \`/d/\`. ${WHO_READS}`,
  })
  @ApiParam({ name: 'name', example: 'Geist-Variable.woff2' })
  @ApiOkResponse({
    content: { 'font/woff2': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiNotFoundResponse({
    description: 'No such file.',
    standardSchema: ErrorDocument,
  })
  async font(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('name') name: string,
  ): Promise<StreamableFile | undefined> {
    return this.pageFile(req, res, `fonts/${name}`);
  }

  @Get(`${PAGE_FILES}/:name`)
  @DeliveryApi()
  @ApiOperation({
    summary: 'A stylesheet of the stable address pages',
    description: `\`theme.css\`, \`theme-dark.css\`, \`render-html.css\` and \`page.css\`, as \`GET /preview/{name}\` serves them, for the pages under \`/d/\`. ${WHO_READS}`,
  })
  @ApiParam({ name: 'name', example: 'render-html.css' })
  @ApiOkResponse({ content: { 'text/css': { schema: { type: 'string' } } } })
  @ApiNotFoundResponse({
    description: 'No such file.',
    standardSchema: ErrorDocument,
  })
  async stylesheet(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('name') name: string,
  ): Promise<StreamableFile | undefined> {
    return this.pageFile(req, res, name);
  }

  @Get(':product/:manual/:variant/:lang')
  @DeliveryApi()
  @HtmlRoute(THEME_QUERY)
  @ApiOperation({
    summary: 'Open a manual at its stable address',
    description: `The manual as a web page, as \`GET /manuals/{id}/variants/{variant}/{lang}/html\` renders it, at the product’s latest release (or the pinned one): the address to print and to link (#450). A new release moves it at once (\`no-cache\`, with an ETag known before the page is rendered, from the release, the reader’s scope, the theme and the build, \`CCMS_BUILD_ID\`: a revalidation is a 304 without rendering); a pinned address revalidates too (\`no-cache\`, with an ETag), so a withdrawal or a change of \`delivery.access\` reaches every cache, \`public\` for a public reader, else \`private\`. A pinned release that was withdrawn is 410 with a notice linking the latest address. ${WHO_READS}`,
  })
  @Address()
  @ApiPermission('content.read')
  @ApiOkResponse({
    description: 'The page.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiResponse({
    status: HttpStatus.AMBIGUOUS,
    description:
      'A language the release does not have, with `delivery.missingLanguage: picker` (the default): a page linking the manual in each language the reader may read.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiResponse({
    status: HttpStatus.GONE,
    description:
      'The pinned release was withdrawn: a notice page, linking the latest address when there is one.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @RateLimited()
  async page(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
    @Query('theme', { schema: PreviewTheme.default('auto') })
    theme: PreviewTheme = 'auto',
  ): Promise<string | undefined> {
    const client = deliveryClient(req);
    this.limit.check(client);
    const reading = await this.reading(req, res);
    const opened = await this.opened(reading, params);
    const root = relativeRoot(req.path);
    const files = `${root}d/${PAGE_FILES}/`;
    const link = (address: StableAddress) =>
      `${root}${addressPath(address).slice(1)}`;
    switch (opened.kind) {
      case 'moved':
      case 'language':
        return this.redirect(reading, res, opened, root, 'html');
      case 'picker': {
        res.status(HttpStatus.AMBIGUOUS);
        res.setHeader('Cache-Control', `${visibility(reading)}, no-cache`);
        return this.html(
          res,
          pageHtml(
            pickerPage({
              title: opened.title,
              lang: opened.lang,
              languages: opened.languages.map((a) => ({
                lang: a.lang,
                href: link(a),
              })),
            }),
            theme,
            root,
            files,
          ),
        );
      }
      case 'withdrawn': {
        res.status(HttpStatus.GONE);
        res.setHeader('Cache-Control', `${visibility(reading)}, no-cache`);
        return this.html(
          res,
          pageHtml(
            withdrawnPage({
              title: opened.title,
              lang: opened.lang,
              revision: opened.release.revision,
              latest: opened.latest && link(opened.latest),
            }),
            theme,
            root,
            files,
          ),
        );
      }
      case 'found': {
        // Known before rendering (#552): a revalidation renders nothing.
        const etag = pageEtag({
          buildId: this.settings.buildId,
          files: PAGE_STYLESHEETS.map(
            (name) => this.files.get(name)?.etag ?? '',
          ),
          commit: opened.content.commit,
          manualId: opened.manualId,
          address: opened.address,
          pinned: opened.pinned,
          readingKey: opened.content.readingKey,
          theme,
          root,
        });
        if (req.headers['if-none-match'] === etag) {
          this.cache(req, res, reading, opened, etag);
        }
        // Counted only once a page is to be rendered: never a revalidation's 304 (#574).
        this.limit.take(client);
        const pinned = `${root}${addressPath(opened.pinned).slice(1)}`;
        const preview = await this.preview.handle({
          actor: reading.reader,
          snapshot: opened.content,
          id: opened.manualId,
          variant: opened.address.variant,
          lang: opened.address.lang,
          assetUrl: (sha256) => `${pinned}/assets/${sha256}`,
          symbolUrl: (id) => `${pinned}/symbols/${encodeURIComponent(id)}`,
        });
        // The preview's own headers (no script, nosniff, no referrer), then ours.
        this.responder.send(req, res, preview, theme);
        // How many issues resolving found is for the editor, not for readers.
        res.removeHeader('X-Ccms-Issues');
        this.cache(req, res, reading, opened, etag);
        return pageHtml(preview, theme, root, files);
      }
    }
  }

  @Get(':product/:manual/:variant/:lang/pdf')
  @DeliveryApi()
  @ApiOperation({
    summary: 'The PDF at a stable address',
    description: `The release’s PDF of the manual in this variant and language (#249), shown in place (\`Content-Disposition: inline\`), never rendered on request: 409 \`output-not-ready\` while it is rendered. Only for a reader one of whose roles covers all of the manual (as \`GET /releases/{id}/outputs\` judges it). Cached as the page is. ${WHO_READS}`,
  })
  @Address()
  @ApiProduces('application/pdf')
  @ApiPermission('content.read')
  @ApiOkResponse({
    description: 'The PDF.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse(GONE_FILE)
  @ApiConflictResponse({
    description:
      '`output-not-ready`: the PDF is being rendered (`meta.state`); try again later. `Retry-After` says when.',
    standardSchema: ErrorDocument,
  })
  @RateLimited()
  async pdfFile(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    const client = deliveryClient(req);
    this.limit.check(client);
    const reading = await this.reading(req, res);
    const found = await this.found(
      reading,
      params,
      res,
      relativeRoot(req.path),
      'pdf',
    );
    if (!found) return undefined;
    let file;
    try {
      file = await this.pdf.handle({ actor: reading.reader, found });
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'output-not-ready') {
        res.setHeader('Retry-After', '30');
      }
      throw error;
    }
    const etag = `"${file.output.sha256}"`;
    this.cache(req, res, reading, found, etag);
    // After the 304: only a PDF actually sent counts (#574).
    this.limit.take(client);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.blob.stream, {
      type: 'application/pdf',
      length: file.blob.size,
      disposition: attachmentDisposition(file.fileName).replace(
        /^attachment/,
        'inline',
      ),
    }).setErrorHandler(
      streamFailed(res, `The PDF of ${addressPath(found.pinned)}`, [
        'Content-Length',
        'Content-Disposition',
        'ETag',
        'Cache-Control',
      ]),
    );
  }

  @Get(':product/:manual/:variant/:lang/qr.svg')
  @DeliveryApi()
  @ApiOperation({
    summary: 'The QR code of a stable address, as SVG',
    description: `A QR code of the address’s URL (\`CCMS_PUBLIC_URL\` and its path), for print: error correction Q, a quiet zone of four modules, one path, sharp at any size. Made only for an address that opens for the reader. ${WHO_READS}`,
  })
  @Address()
  @ApiPermission('content.read')
  @ApiOkResponse(QR_OK)
  @ApiResponse(GONE_FILE)
  @ApiConflictResponse(QR_CONFLICT)
  @RateLimited()
  async qrSvg(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
  ): Promise<StreamableFile | undefined> {
    return this.qr(req, res, params, 'html', 'svg');
  }

  @Get(':product/:manual/:variant/:lang/qr.png')
  @DeliveryApi()
  @ApiOperation({
    summary: 'The QR code of a stable address, as PNG',
    description: `As \`…/qr.svg\`, as a black and white PNG, eight pixels a module. ${WHO_READS}`,
  })
  @Address()
  @ApiPermission('content.read')
  @ApiOkResponse(QR_OK)
  @ApiResponse(GONE_FILE)
  @ApiConflictResponse(QR_CONFLICT)
  @RateLimited()
  async qrPng(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
  ): Promise<StreamableFile | undefined> {
    return this.qr(req, res, params, 'html', 'png');
  }

  @Get(':product/:manual/:variant/:lang/pdf/qr.svg')
  @DeliveryApi()
  @ApiOperation({
    summary: 'The QR code of a stable PDF address, as SVG',
    description: `As \`…/qr.svg\`, of the PDF’s address. ${WHO_READS}`,
  })
  @Address()
  @ApiPermission('content.read')
  @ApiOkResponse(QR_OK)
  @ApiResponse(GONE_FILE)
  @ApiConflictResponse(QR_CONFLICT)
  @RateLimited()
  async pdfQrSvg(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
  ): Promise<StreamableFile | undefined> {
    return this.qr(req, res, params, 'pdf', 'svg');
  }

  @Get(':product/:manual/:variant/:lang/pdf/qr.png')
  @DeliveryApi()
  @ApiOperation({
    summary: 'The QR code of a stable PDF address, as PNG',
    description: `As \`…/qr.png\`, of the PDF’s address. ${WHO_READS}`,
  })
  @Address()
  @ApiPermission('content.read')
  @ApiOkResponse(QR_OK)
  @ApiResponse(GONE_FILE)
  @ApiConflictResponse(QR_CONFLICT)
  @RateLimited()
  async pdfQrPng(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams,
  ): Promise<StreamableFile | undefined> {
    return this.qr(req, res, params, 'pdf', 'png');
  }

  @Get(':product/:manual/:variant/:lang/assets/:hash')
  @DeliveryApi()
  @ApiOperation({
    summary: 'An image of a stable address’s page',
    description: `An image the page shows, as \`GET /assets/{sha256}\` serves it at the release’s tag, for the reader. Its bytes never change, but who may read them can (a withdrawal, \`delivery.access\`): a public one is \`public, max-age=86400, s-maxage=<CCMS_DELIVERY_SHARED_MAX_AGE>, proxy-revalidate\` (a shared cache asks again after that, default 300 s, and is told 410 once the release is withdrawn), a signed-in reader’s \`private, max-age=86400\`; the ETag is the hash, so a revalidation is a 304 without reading the file. ${WHO_READS}`,
  })
  @Address()
  @ApiParam({ name: 'hash', schema: { type: 'string' } })
  @ApiPermission('content.read')
  @ApiOkResponse({
    description: 'The image.',
    content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse(GONE_FILE)
  async asset(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams & { hash: string },
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    const reading = await this.reading(req, res);
    // Checked first: the hash goes into a moved address's `Location`.
    if (!/^[0-9a-f]{64}$/.test(params.hash)) throw notFound();
    const found = await this.found(
      reading,
      params,
      res,
      relativeRoot(req.path),
      `assets/${params.hash}`,
    );
    if (!found) return undefined;
    // A blob's bytes never change, but who may read them can (a withdrawal, `delivery.access`):
    // never `immutable`, and a shared cache revalidates a public one within minutes (#552).
    res.setHeader(
      'Cache-Control',
      reading.everyone
        ? `public, ${ASSET_MAX_AGE}, s-maxage=${this.settings.sharedMaxAge}, proxy-revalidate`
        : `private, ${ASSET_MAX_AGE}`,
    );
    const etag = `"${params.hash}"`;
    res.setHeader('ETag', etag);
    // The bytes are the hash's: a revalidation only checks the reader may still see them.
    if (
      req.headers['if-none-match'] === etag &&
      (await found.content.refersToAsset(params.hash))
    ) {
      throw new NotModified(etag);
    }
    const asset = await this.assets.handle({
      actor: reading.reader,
      snapshot: found.content,
      hash: params.hash,
    });
    return assetFile(asset, params.hash, res);
  }

  @Get(':product/:manual/:variant/:lang/symbols/:id')
  @DeliveryApi()
  @ApiOperation({
    summary: 'A safety symbol of a stable address’s page',
    description: `A safety symbol’s artwork the page shows, as \`GET /symbols/{id}\` serves it at the release’s tag. ${WHO_READS}`,
  })
  @Address()
  @ApiParam({ name: 'id', schema: { type: 'string' } })
  @ApiPermission('content.read')
  @ApiOkResponse({
    description: 'The artwork.',
    content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse(GONE_FILE)
  async symbol(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param() params: AddressParams & { id: string },
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    const reading = await this.reading(req, res);
    const found = await this.found(
      reading,
      params,
      res,
      relativeRoot(req.path),
      `symbols/${encodeURIComponent(params.id)}`,
    );
    if (!found) return undefined;
    const artwork = await this.symbols.handle({
      actor: reading.reader,
      snapshot: found.content,
      id: params.id,
    });
    this.cache(req, res, reading, found, etagOf(artwork.bytes));
    return assetFile(
      {
        stream: Readable.from([artwork.bytes]),
        type: artwork.type,
        size: artwork.bytes.byteLength,
      },
      params.id,
      res,
    );
  }

  /**
   * Who reads, before anything else is looked at: `off` is 404; no token where one is
   * needed is 401; an actor without `content.read` is 403 (unless `permission` is false: the
   * pages' stylesheets and fonts, the same bytes for everyone). A `public` address reads as
   * the public reader whoever asks, so its answer varies by no credential (#608); any other
   * keys on them.
   */
  private async reading(
    req: Request,
    res: Response,
    permission = true,
  ): Promise<Reading> {
    const { access, reader, config } = await this.access.handle({
      actor: req.actor,
    });
    const everyone = access === 'public';
    if (!everyone) {
      res.vary('Authorization');
      res.vary('X-Ccms-User');
    }
    if (!reader) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException(
        'Sign in to open this address: its manuals are for signed-in readers.',
      );
    }
    if (permission) authorize(reader, 'content.read');
    return { reader, config, everyone };
  }

  private async opened(
    reading: Reading,
    params: AddressParams,
  ): Promise<OpenedAddress> {
    const address = parseAddress(params);
    if (!address) throw notFound();
    return this.openAddress.handle({
      actor: reading.reader,
      address,
      config: reading.config,
    });
  }

  /**
   * The address found, for a route under it (`rest`, after the address): a moved address is
   * redirected there (and undefined returned); a withdrawn release is 410, a missing
   * language 404.
   */
  private async found(
    reading: Reading,
    params: AddressParams,
    res: Response,
    root: string,
    rest: string,
  ): Promise<FoundAddress | undefined> {
    const opened = await this.opened(reading, params);
    switch (opened.kind) {
      case 'found':
        return opened;
      case 'moved':
      case 'language':
        this.redirect(reading, res, opened, root, rest);
        return undefined;
      case 'withdrawn':
        throw new JsonApiException(HttpStatus.GONE, [
          {
            code: 'release-withdrawn',
            detail: `Release ${opened.release.revision} was withdrawn; open the latest address.`,
          },
        ]);
      case 'picker':
        throw notFound();
    }
  }

  private redirect(
    reading: Reading,
    res: Response,
    opened: Extract<OpenedAddress, { kind: 'moved' | 'language' }>,
    root: string,
    rest: string,
  ): undefined {
    const path = addressPath(opened.to).slice(1);
    const suffix = rest === 'html' ? '' : `/${rest}`;
    res.status(
      opened.kind === 'moved' ? HttpStatus.MOVED_PERMANENTLY : HttpStatus.FOUND,
    );
    // Relative, so it holds behind a proxy's path (`/api/`).
    res.setHeader('Location', `${root}${path}${suffix}`);
    res.setHeader('Cache-Control', `${visibility(reading)}, no-cache`);
    return undefined;
  }

  private async qr(
    req: Request,
    res: Response,
    params: AddressParams,
    kind: AddressKind,
    format: QrFormat,
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    const client = deliveryClient(req);
    this.limit.check(client);
    const reading = await this.reading(req, res);
    const rest = kind === 'pdf' ? `pdf/qr.${format}` : `qr.${format}`;
    const found = await this.found(
      reading,
      params,
      res,
      relativeRoot(req.path),
      rest,
    );
    if (!found) return undefined;
    const url = absoluteUrl(this.settings, addressPath(found.address, kind));
    if (url === undefined) {
      throw new ConflictError(
        'public-url-not-set',
        'CCMS_PUBLIC_URL is not set: there is no address for a QR code to hold.',
      );
    }
    // Before drawing it: its ETag is the image's, so a revalidation counts too (#574).
    this.limit.take(client);
    const image = await qrImage(url, format);
    // Revalidated like the rest: the code holds `CCMS_PUBLIC_URL`, which can change.
    this.cache(req, res, reading, found, etagOf(image.bytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    return new StreamableFile(Buffer.from(image.bytes), {
      type: image.type,
      length: image.bytes.byteLength,
      disposition: `inline; filename="qr.${format}"`,
    });
  }

  /** Cache headers of a found address's answer; 304 when `If-None-Match` is current. */
  private cache(
    req: Request,
    res: Response,
    reading: Reading,
    found: FoundAddress,
    etag: string,
  ): void {
    // Nothing here is cached for good, pinned or not: a withdrawal (410), a change of who may
    // read it (`delivery.access`, `publicAudience`) or of `CCMS_PUBLIC_URL` (a QR code) reaches
    // every cache at once; the ETag keeps it cheap.
    res.setHeader('Cache-Control', `${visibility(reading)}, no-cache`);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) throw new NotModified(etag);
  }

  private html(res: Response, body: string): string {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    return body;
  }

  private async pageFile(
    req: Request,
    res: Response,
    path: string,
  ): Promise<StreamableFile | undefined> {
    refuseQuery(req);
    const reading = await this.reading(req, res, false);
    const file = this.files.get(path);
    if (!file) throw new NotFoundError('No such file.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', `${visibility(reading)}, no-cache`);
    if (req.headers['if-none-match'] === file.etag) {
      throw new NotModified(file.etag);
    }
    return new StreamableFile(file.body, {
      type: file.type,
      length: file.body.byteLength,
    });
  }
}

/** The stylesheets a page links (`pageHtml`): their ETags are part of the page's (#552). */
const PAGE_STYLESHEETS = [
  'theme.css',
  'theme-dark.css',
  'render-html.css',
  'page.css',
] as const;

/** The notice and picker pages' policy: the preview's, no framing needed. */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** `public` for the public reader (anyone gets the same), else `private`. */
const visibility = (reading: Reading) =>
  reading.everyone ? 'public' : 'private';

/**
 * `GET /stable-addresses` (#450): the addresses of the manuals a reader may read, for the
 * editor's Copy and QR code. JSON:API.
 */
@ApiTags('stable-addresses')
@Controller('stable-addresses')
@JsonApi()
export class StableAddressListController {
  constructor(
    private readonly list: ListStableAddressesAction,
    private readonly settings: StableAddressSettings,
  ) {}

  @Get()
  @Paged()
  @Filters(
    {
      name: 'release',
      description:
        'One release’s addresses (its ID). Default: each product’s latest release.',
    },
    { name: 'product', description: 'Only this product’s latest release.' },
    { name: 'manual', description: 'Only this manual’s addresses (its ID).' },
    { name: 'lang', description: 'Only addresses in this language.' },
  )
  @DeliveryApi()
  @ApiOperation({
    summary: 'List stable addresses',
    description:
      'One entry per manual, variant and language of a release’s outputs (#249) the reader may read (a role covering all of the manual, as `GET /releases/{id}/outputs` judges it): its latest and pinned addresses (page and PDF), as paths and, with `CCMS_PUBLIC_URL` set, as URLs. Without `filter[release]`, of each product’s latest release (the newest of `main` not withdrawn), in the product facet’s order. `meta.access` says who may open them. Ordered by release, then manual, variant, language.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: StableAddressPageDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no release with the ID `filter[release]` names.',
    standardSchema: ErrorDocument,
  })
  async addresses(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[release]', { schema: addressFilters.release.optional() })
    release?: string,
    @Query('filter[product]', { schema: addressFilters.product.optional() })
    product?: string,
    @Query('filter[manual]', { schema: addressFilters.manual.optional() })
    manual?: string,
    @Query('filter[lang]', { schema: addressFilters.lang.optional() })
    lang?: string,
  ): Promise<z.infer<typeof StableAddressPageDocument>> {
    const result = await this.list.handle({
      actor,
      page,
      filter: {
        ...(release !== undefined && { release }),
        ...(product !== undefined && { product }),
        ...(manual !== undefined && { manual }),
        ...(lang !== undefined && { lang }),
      },
    });
    const document = toPagedDocument(req, page, result, (listed) =>
      toStableAddressResource(this.settings, listed),
    );
    return {
      ...document,
      meta: {
        ...document.meta,
        access: result.access,
        publicUrl: this.settings.publicUrl ?? null,
      },
    };
  }
}
