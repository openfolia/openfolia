import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { PreviewFiles, type PreviewFile } from '../core/html-renderer.js';

/** The file a package's export names, without importing it. */
const resolve = (specifier: string) =>
  fileURLToPath(import.meta.resolve(specifier));

/**
 * Applied to the page itself: the page is an iframe's whole document, so
 * its background is the theme's and the browser draws its scrollbars for
 * the scheme in use.
 */
const PAGE_CSS = `html { background: var(--background); color: var(--foreground); }
html.dark { color-scheme: dark; }
body { margin: 0; padding: 1rem; }
`;

/** The theme's `.dark` values, as `:root` ones: linked only where the browser prefers dark. */
export function darkAsRoot(theme: string): string {
  const block = /^\.dark\s*\{([^}]*)\}/m.exec(theme);
  if (!block) throw new Error('@openfolia/theme: theme.css has no .dark block');
  return `:root { color-scheme: dark; ${block[1]?.trim()} }\n`;
}

const FONT = /^[A-Za-z0-9-]+\.woff2$/;

/**
 * Reads the theme, the renderer's stylesheet and the theme's fonts from
 * their packages once, when the API starts (a missing file fails the start,
 * not a request). Only these files are ever served: a path from a request
 * is looked up in the map, never read from disk.
 */
@Injectable()
export class PackagePreviewFiles extends PreviewFiles {
  readonly #files = new Map<string, PreviewFile>();

  constructor() {
    super();
    const themePath = resolve('@openfolia/theme/theme.css');
    const theme = readFileSync(themePath, 'utf8');
    this.#add('theme.css', theme, 'text/css; charset=utf-8');
    this.#add('theme-dark.css', darkAsRoot(theme), 'text/css; charset=utf-8');
    this.#add(
      'render-html.css',
      readFileSync(resolve('@openfolia/render-html/render-html.css')),
      'text/css; charset=utf-8',
    );
    this.#add('page.css', PAGE_CSS, 'text/css; charset=utf-8');
    const fonts = join(dirname(themePath), 'fonts');
    for (const name of readdirSync(fonts).filter((n) => FONT.test(n))) {
      this.#add(`fonts/${name}`, readFileSync(join(fonts, name)), 'font/woff2');
    }
  }

  get(path: string): PreviewFile | undefined {
    return this.#files.get(path);
  }

  #add(path: string, body: string | Uint8Array, type: string): void {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    this.#files.set(path, {
      body: bytes,
      type,
      etag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`,
    });
  }
}
