import { Injectable } from '@nestjs/common';
import { labelOf, type ProjectConfig } from '@openfolia/content-model';
import {
  renderManualHtml,
  renderModuleHtml,
  type HtmlRenderOptions as RenderOptions,
} from '@openfolia/render-html';
import type { ManualResolution } from '../../content/core/content.repository.js';
import {
  HtmlRenderer,
  type HtmlFragment,
  type HtmlRenderOptions,
} from '../core/html-renderer.js';

/** The HTML renderer package behind the port. */
@Injectable()
export class RenderHtmlRenderer extends HtmlRenderer {
  manual(
    { manual, config }: ManualResolution,
    options: HtmlRenderOptions,
  ): HtmlFragment {
    return renderManualHtml(
      manual,
      renderOptions(config, manual.lang, options),
    );
  }

  module(
    { manual, config }: ManualResolution,
    moduleId: string,
    options: HtmlRenderOptions,
  ): HtmlFragment | undefined {
    return renderModuleHtml(
      manual,
      moduleId,
      renderOptions(config, manual.lang, options),
    );
  }
}

/** The labels in the manual's language `lang` (#731), else the source language's. */
function renderOptions(
  config: ProjectConfig,
  lang: string,
  { editorView, ...options }: HtmlRenderOptions,
): RenderOptions {
  return {
    ...options,
    outputLabels: config.outputLabels,
    // The configured label: the symbol's text alternative.
    symbolLabel: (id) => labelOf(config, 'safetySymbols', id, lang),
    ...(editorView && {
      preview: {
        attributeLabel: (name) => labelOf(config, 'textAttributes', name, lang),
      },
    }),
  };
}
