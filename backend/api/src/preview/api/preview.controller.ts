import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { parseVariantSlug } from '@openfolia/content-model';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { BROKEN_OR_TOO_LARGE } from '../../manuals/api/too-large-response.js';
import { params } from '../../base/api/schemas.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { PreviewManualAction } from '../core/actions/preview-manual.action.js';
import { PreviewModuleAction } from '../core/actions/preview-module.action.js';
import {
  CurrentWorkingCopies,
  ReadsWorkingCopies,
  type WorkingCopyRead,
} from '../../change-sets/api/working-copy-reads.js';
import { HtmlRoute } from './html-route.js';
import {
  assetUrlFor,
  PreviewResponder,
  PreviewTheme,
  symbolUrlFor,
} from './preview-page.js';

const HTML_OK = {
  description:
    'A complete HTML page (`@openfolia/render-html`) linking the theme and the renderer’s stylesheet, served with `Content-Security-Policy` (no script; styles, images and fonts from this origin; `frame-ancestors` this origin and `CCMS_EDITOR_ORIGINS`) and `X-Content-Type-Options: nosniff`. Images are `GET /assets/:sha256` and safety symbols `GET /symbols/:id` (those with artwork; the configured label as the text alternative), at the same `?ref=`. Cached like every content route.',
  content: { 'text/html': { schema: { type: 'string' } } },
  headers: {
    ...CONTENT_HEADERS,
    'Content-Security-Policy': {
      description: 'No script; see the route.',
      schema: { type: 'string' },
    },
    'X-Ccms-Issues': {
      description: 'How many issues resolving found that the reader may see.',
      schema: { type: 'integer' },
    },
  },
} as const;

export const THEME_QUERY = {
  name: 'theme',
  description: PreviewTheme.description as string,
  schema: { type: 'string', enum: PreviewTheme.options, default: 'auto' },
};

/** `?view=` of a manual's page: what readers get, or the editor's preview of it. */
export const HtmlView = z
  .enum(['reader', 'editor'])
  .describe(
    '`reader` (default): the HTML readers get. `editor`: the editor’s preview of it, which also shows each page break as a marker labelled “Page break (PDF)”.',
  );
type HtmlView = z.infer<typeof HtmlView>;

const VIEW_QUERY = {
  name: 'view',
  description: HtmlView.description as string,
  schema: { type: 'string', enum: HtmlView.options, default: 'reader' },
};

/** The `?ref=` as the client gave it: the asset links carry it, so they read the same content. */
const requestedRef = (req: Request): string | undefined =>
  typeof req.query['ref'] === 'string' ? req.query['ref'] : undefined;

/** `?variant=` of a module route: a slug (`model=large,software=2.3`). */
export const VariantQuery = z
  .string()
  .max(500)
  .refine((slug) => parseVariantSlug(slug) !== undefined, {
    message:
      'a variant slug such as `model=large,software=2.3` (see `GET /manuals/{id}`)',
  });

@ApiTags('modules')
@Controller('modules')
@ReadsContent()
export class ModulePreviewController {
  constructor(
    private readonly previewModule: PreviewModuleAction,
    private readonly responder: PreviewResponder,
  ) {}

  @Get(':lang/:id/preview')
  @DeliveryApi()
  @HtmlRoute(
    {
      name: 'variant',
      description:
        'The variant to apply the module’s conditions for, as a slug (`model=large,software=2.3`; attributes and values as configured). Default: none set, so a condition on a variant attribute does not hold.',
      schema: { type: 'string' },
    },
    THEME_QUERY,
  )
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'Preview a module as HTML',
    description:
      'One module in one language as a page for the editor’s live preview, with the conditions inside it applied for `variant`. Read like every other module read: `?ref=` may name a branch (a change set’s, for its author), and a module the reader may not see is 404, exactly like a missing one. The editor’s view: a page break shows as a marker labelled “Page break (PDF)”, and a text attribute (`{product-name}`), which a module on its own has no value for, as a chip with the attribute’s label, titled “Not set for this preview”.',
  })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({ name: 'id', example: 'battery-charging' })
  @ApiPermission('content.read')
  @ApiOkResponse(HTML_OK)
  @ApiBadRequestResponse({
    description: 'Malformed ID, language, variant or theme.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: BROKEN_OR_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  async preview(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @CurrentWorkingCopies() workingCopies: WorkingCopyRead | undefined,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('id', { schema: params.moduleId }) id: string,
    @Query('variant', { schema: VariantQuery.optional() }) variant?: string,
    @Query('theme', { schema: PreviewTheme.default('auto') })
    theme: PreviewTheme = 'auto',
  ): Promise<string> {
    const preview = await this.previewModule.handle({
      actor,
      snapshot,
      id,
      lang,
      ...(variant !== undefined && {
        variant: parseVariantSlug(variant) as NonNullable<
          ReturnType<typeof parseVariantSlug>
        >,
      }),
      assetUrl: assetUrlFor(req.path, requestedRef(req), workingCopies),
      symbolUrl: symbolUrlFor(req.path, requestedRef(req)),
    });
    return this.responder.send(req, res, preview, theme);
  }
}

@ApiTags('manuals')
@Controller('manuals')
@ReadsContent()
export class ManualHtmlController {
  constructor(
    private readonly previewManual: PreviewManualAction,
    private readonly responder: PreviewResponder,
  ) {}

  @Get(':id/variants/:variant/:lang/html')
  @DeliveryApi()
  @HtmlRoute(THEME_QUERY, VIEW_QUERY)
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'Render a manual as HTML',
    description:
      'The resolved manual for one of its published variants as a page: the title, a table of contents and every module, as in the PDF. Read like the PDF and the resolved manual: scope and audience apply, and a manual, variant or language the reader may not have is 404, exactly like a missing one.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiOkResponse(HTML_OK)
  @ApiBadRequestResponse({
    description: 'Malformed manual ID, variant slug, language, theme or view.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: BROKEN_OR_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  async html(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @CurrentWorkingCopies() workingCopies: WorkingCopyRead | undefined,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
    @Query('theme', { schema: PreviewTheme.default('auto') })
    theme: PreviewTheme = 'auto',
    @Query('view', { schema: HtmlView.default('reader') })
    view: HtmlView = 'reader',
  ): Promise<string> {
    const preview = await this.previewManual.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
      ...(view === 'editor' && { editorView: true }),
      assetUrl: assetUrlFor(req.path, requestedRef(req), workingCopies),
      symbolUrl: symbolUrlFor(req.path, requestedRef(req)),
    });
    return this.responder.send(req, res, preview, theme);
  }
}
