import { plainTextOf, walk } from '@openfolia/content-model';
import type { ManualResolution } from '../../src/content/core/content.repository.js';
import {
  type OfflineIndexInput,
  type OfflinePageInput,
  OfflineSite,
  type OfflineSiteFile,
} from '../../src/releases/core/offline-package.js';
import {
  type HtmlFragment,
  HtmlRenderer,
  type HtmlRenderOptions,
} from '../../src/preview/core/html-renderer.js';

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A manual as text, for the offline package's unit tests (#59): each module's
 * title and every paragraph's text, each image (`<img src>`) and attachment
 * (`<a href>`) through the caller's `assetUrl`, as the renderer reports them.
 */
export class TextHtmlRenderer extends HtmlRenderer {
  /** Safety symbols every manual shows (`<img src>` through `symbolUrl`), as the renderer reports them. */
  symbols: string[] = [];

  manual(
    resolution: ManualResolution,
    options: HtmlRenderOptions,
  ): HtmlFragment {
    const parts: string[] = [];
    const assets: string[] = [];
    const attachments: string[] = [];
    const visit = (entries: ManualResolution['manual']['entries']): void => {
      for (const entry of entries) {
        if (entry.kind === 'group') {
          visit(entry.entries);
          continue;
        }
        parts.push(`<h2 id="of-${esc(entry.module)}">${esc(entry.title)}</h2>`);
        for (const found of walk(entry.blocks)) {
          if (found.kind !== 'block') continue;
          const block = found.node;
          if (block.type === 'paragraph') {
            parts.push(`<p>${esc(plainTextOf(block.content).text)}</p>`);
          } else if (block.type === 'image' || block.type === 'attachment') {
            const hash = block.asset.slice('sha256:'.length);
            const url = esc(options.assetUrl(hash));
            if (block.type === 'image') {
              assets.push(block.asset);
              parts.push(`<img src="${url}">`);
            } else {
              attachments.push(block.asset);
              parts.push(`<a href="${url}">${esc(block.name)}</a>`);
            }
          }
        }
      }
    };
    visit(resolution.manual.entries);
    for (const id of this.symbols) {
      const url = options.symbolUrl?.(id);
      if (url !== undefined) parts.push(`<img src="${esc(url)}">`);
    }
    return {
      html: `<article>${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ''}${parts.join('')}</article>`,
      assets,
      attachments,
      symbols: [...this.symbols],
    };
  }

  module(): HtmlFragment | undefined {
    return undefined;
  }
}

/** The offline pages as plain documents: what the unit tests read back. */
export class FakeOfflineSite extends OfflineSite {
  page(input: OfflinePageInput): string {
    return `<!doctype html><title>${esc(input.title)}</title>${input.pdf ? `<a href="${esc(input.root + input.pdf)}">PDF</a>` : ''}${input.fragment}<footer>${esc(input.footer)}</footer>`;
  }

  index(input: OfflineIndexInput): string {
    return `<!doctype html><title>${esc(input.title)}</title><p>${esc(input.subtitle)}</p>${input.manuals
      .map(
        (m) =>
          `<h2>${esc(m.title)}</h2>${m.variants
            .map(
              (v) =>
                `<a href="${esc(v.page)}">${esc(v.label)}</a>${v.pdf ? `<a href="${esc(v.pdf)}">PDF</a>` : ''}`,
            )
            .join('')}`,
      )
      .join(
        '',
      )}<script type="application/json">${JSON.stringify(input.search).replace(/</g, '\\u003c')}</script>`;
  }

  headings(resolution: ManualResolution) {
    return resolution.manual.entries.flatMap((e) =>
      e.kind === 'module' ? [{ id: `of-${e.module}`, text: e.title }] : [],
    );
  }

  files(): readonly OfflineSiteFile[] {
    return [
      { path: 'assets/site.css', bytes: new TextEncoder().encode('/* */') },
    ];
  }
}
