import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import {
  manualHeadings,
  offlineIndexHtml,
  offlinePageHtml,
  OFFLINE_SEARCH_PATH,
  OFFLINE_SEARCH_SCRIPT,
  OFFLINE_SITE_CSS,
  OFFLINE_STYLESHEETS,
} from '@openfolia/render-html';
import type { ManualResolution } from '../../content/core/content.repository.js';
import { darkAsRoot } from '../../preview/repos/preview-files.js';
import {
  type OfflineIndexInput,
  type OfflinePageInput,
  OfflineSite,
  type OfflineSiteFile,
} from '../core/offline-package.js';

const resolve = (specifier: string) =>
  fileURLToPath(import.meta.resolve(specifier));

/** The theme's fonts and their licences, which travel with them. */
const FONT_FILE = /^[A-Za-z0-9-]+\.(woff2|txt)$/;

/**
 * `@openfolia/render-html`'s static-site writer behind the port, and the files every
 * package holds: the theme and its dark values, the renderer's stylesheet, the
 * pages' own, the search script and the theme's fonts (with their licences),
 * read once when the API starts (a missing file fails the start, not a build).
 */
@Injectable()
export class RenderHtmlOfflineSite extends OfflineSite {
  readonly #files: readonly OfflineSiteFile[];

  constructor() {
    super();
    const themePath = resolve('@openfolia/theme/theme.css');
    const theme = readFileSync(themePath, 'utf8');
    const encode = (text: string) => new TextEncoder().encode(text);
    const fonts = join(dirname(themePath), 'fonts');
    this.#files = [
      { path: OFFLINE_STYLESHEETS.theme, bytes: encode(theme) },
      { path: OFFLINE_STYLESHEETS.themeDark, bytes: encode(darkAsRoot(theme)) },
      {
        path: OFFLINE_STYLESHEETS.content,
        bytes: readFileSync(resolve('@openfolia/render-html/render-html.css')),
      },
      { path: OFFLINE_STYLESHEETS.site, bytes: encode(OFFLINE_SITE_CSS) },
      { path: OFFLINE_SEARCH_PATH, bytes: encode(OFFLINE_SEARCH_SCRIPT) },
      // Beside the theme, where its `url('./fonts/…')` finds them.
      ...readdirSync(fonts)
        .filter((name) => FONT_FILE.test(name))
        .sort()
        .map((name) => ({
          path: `assets/fonts/${name}`,
          bytes: readFileSync(join(fonts, name)),
        })),
    ];
  }

  page(input: OfflinePageInput): string {
    return offlinePageHtml(input);
  }

  index(input: OfflineIndexInput): string {
    return offlineIndexHtml(input);
  }

  headings(resolution: ManualResolution) {
    return manualHeadings(resolution.manual);
  }

  files(): readonly OfflineSiteFile[] {
    return this.#files;
  }
}
