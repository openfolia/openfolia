import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { PdfRenderer } from '../pdf-renderer.js';
import { renderKey } from './render-manual-pdf.action.js';
import { ResolveManualAction } from './resolve-manual.action.js';

/**
 * One page of a manual's PDF as a PNG, for thumbnails: the same PDF as
 * `RenderManualPdfAction` (same scope, same cache key), so a thumbnail
 * never shows what the reader's PDF would not. `NotFoundError` past the
 * last page.
 */
@Injectable()
export class RenderManualPageAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    /** Another page design than the manual's own (#392). */
    design?: string;
    page: number;
    width: number;
  },
  { png: Uint8Array }
> {
  readonly policy = 'content.read';

  constructor(
    private readonly resolveManual: ResolveManualAction,
    private readonly renderer: PdfRenderer,
  ) {
    super();
  }

  protected async run(input: {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    /** Another page design than the manual's own (#392). */
    design?: string;
    page: number;
    width: number;
  }): Promise<{ png: Uint8Array }> {
    const resolution = await this.resolveManual.handle(input);
    const source = input.snapshot.renderSource(resolution);
    const png = await this.renderer.renderPage(
      source,
      resolution,
      await renderKey(input, resolution, source),
      { number: input.page, width: input.width },
    );
    return { png };
  }
}
