// What the start page loads: its own files (page/), the theme's stylesheet, fonts and brand, read
// once at start; and the demo's films from a folder, streamed. Only names in these lists are
// served, never a path from a request.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_NAMES, type Film } from './page.js';
import type { PageLang } from './texts.js';

export interface Asset {
  readonly body: Buffer;
  readonly type: string;
}

const PAGE_DIR = fileURLToPath(new URL('../page/', import.meta.url));

function themeFile(path: string): string {
  return fileURLToPath(import.meta.resolve(`@openfolia/theme/${path}`));
}

/** The page's files by their published path under /_demo/. */
export function loadAssets(): ReadonlyMap<string, Asset> {
  const assets = new Map<string, Asset>();
  const add = (published: string, file: string, type: string) =>
    assets.set(published, { body: readFileSync(file), type });
  add('page.css', join(PAGE_DIR, 'page.css'), 'text/css; charset=utf-8');
  add('page.js', join(PAGE_DIR, 'page.js'), 'text/javascript; charset=utf-8');
  add('theme.js', join(PAGE_DIR, 'theme.js'), 'text/javascript; charset=utf-8');
  add(
    'pow-worker.js',
    join(PAGE_DIR, 'pow-worker.js'),
    'text/javascript; charset=utf-8',
  );
  add('theme.css', themeFile('theme.css'), 'text/css; charset=utf-8');
  for (const font of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2'])
    add(`fonts/${font}`, themeFile(`fonts/${font}`), 'font/woff2');
  for (const brand of [
    'openfolia-lockup-horizontal-color-light.svg',
    'openfolia-lockup-horizontal-color-dark.svg',
    'favicon.svg',
  ])
    add(`brand/${brand}`, themeFile(`brand/${brand}`), 'image/svg+xml');
  return assets;
}

/** A film file's name: `<film>-<lang>.<ext>`, as the films' folder holds them. */
export const FILM_FILE = new RegExp(
  `^(${FILM_NAMES.join('|')})-(en|de)\\.(jpg|mp4|webm)$`,
);

export const FILM_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * The films in `dir` for a language (its own, else the English one): each needs a poster and at
 * least one video. In the films' order; none when the folder is unset or missing.
 */
export function findFilms(dir: string | undefined, lang: PageLang): Film[] {
  if (!dir || !existsSync(dir)) return [];
  const files = new Set(
    readdirSync(dir).filter((name) => FILM_FILE.test(name)),
  );
  const films: Film[] = [];
  for (const name of FILM_NAMES) {
    for (const l of lang === 'en' ? ['en'] : [lang, 'en']) {
      const poster = `${name}-${l}.jpg`;
      const videos = (['webm', 'mp4'] as const).filter((ext) =>
        files.has(`${name}-${l}.${ext}`),
      );
      if (!files.has(poster) || videos.length === 0) continue;
      films.push({
        name,
        poster: `/_demo/films/${poster}`,
        sources: videos.map((ext) => ({
          src: `/_demo/films/${name}-${l}.${ext}`,
          type: FILM_TYPES[ext] ?? '',
        })),
      });
      break;
    }
  }
  return films;
}
