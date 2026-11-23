import { Injectable } from '@nestjs/common';
import {
  directionOf,
  variantLabel,
  variantSlug,
  type TextDirection,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { HtmlRenderer, type HtmlRenderOptions } from '../html-renderer.js';
import { symbolUrlsFor } from './preview-module.action.js';

export interface Preview {
  html: string;
  /** For the page's `<title>`. */
  title: string;
  lang: string;
  /** The direction of `lang`'s text, as the configuration gives it, for the page's `dir`. */
  dir: TextDirection;
  /** The issues resolving found that the actor may learn of. */
  issueCount: number;
}

/**
 * A manual as HTML for one of its published variants and a configured
 * language: resolved exactly as for the PDF (`ResolveManualAction`: scope,
 * audience, "no such variant", "no such language" all alike), then rendered.
 */
@Injectable()
export class PreviewManualAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    assetUrl: HtmlRenderOptions['assetUrl'];
    /** Where a safety symbol's artwork is read; used for the symbols that have one. */
    symbolUrl: (id: string) => string;
    /** The editor's view (page breaks shown); default: what readers get. */
    editorView?: boolean;
  },
  Preview
> {
  readonly policy = 'content.read';

  constructor(
    private readonly resolveManual: ResolveManualAction,
    private readonly renderer: HtmlRenderer,
  ) {
    super();
  }

  protected async run(input: {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    assetUrl: HtmlRenderOptions['assetUrl'];
    symbolUrl: (id: string) => string;
    editorView?: boolean;
  }): Promise<Preview> {
    const resolution = await this.resolveManual.handle(input);
    const symbolUrl = await symbolUrlsFor(input.snapshot, input.symbolUrl);
    const variant = resolution.manifest.variants.find(
      (v) => variantSlug(v) === input.variant,
    );
    const { html } = this.renderer.manual(resolution, {
      assetUrl: input.assetUrl,
      symbolUrl,
      ...(input.editorView && { editorView: true }),
      ...(variant && {
        subtitle: variantLabel(
          variant,
          resolution.config,
          resolution.manual.lang,
        ),
      }),
    });
    return {
      html,
      title: resolution.manual.title,
      lang: resolution.manual.lang,
      dir: directionOf(resolution.manual, resolution.manual.lang),
      issueCount: resolution.issues.length,
    };
  }
}
