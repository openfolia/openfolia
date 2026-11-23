import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  isDesignWarning,
  PdfRenderer,
  type DesignLayoutWarning,
} from '../pdf-renderer.js';
import { renderKey } from './render-manual-pdf.action.js';
import { ResolveManualAction } from './resolve-manual.action.js';

/**
 * What the layout of a manual's PDF could not fit (#391's `page-design-overflow` and
 * `running-head-truncated`), for the design screen's preview (#392): the same PDF as
 * `RenderManualPdfAction` and its page images (same scope, same key), so the warnings are
 * those of the pages shown, rendered if they are not yet. In the order the renderer gives them;
 * not a callout legend cut off (`callout-label-overflow`, #548) or a safety message split across
 * pages (`safety-message-split`, #668), which only the checks report.
 */
@Injectable()
export class ManualLayoutWarningsAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    /** Another page design than the manual's own. */
    design?: string;
    page: PageRequest;
  },
  Paginated<DesignLayoutWarning>
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
    design?: string;
    page: PageRequest;
  }): Promise<Paginated<DesignLayoutWarning>> {
    const resolution = await this.resolveManual.handle(input);
    const source = input.snapshot.renderSource(resolution);
    const warnings = await this.renderer.layoutWarnings(
      source,
      resolution,
      await renderKey(input, resolution, source),
    );
    // The page design's only: a callout legend cut off (#548) is the manual's checks' to report.
    return paginate(warnings.filter(isDesignWarning), input.page);
  }
}
