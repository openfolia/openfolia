import { escapeHtml as esc, safeUrl } from './escape.js';

/**
 * The offline package's pages (#59): static HTML documents around the fragments
 * `renderManualHtml` writes, opened from the file system without a server and
 * without network requests. Everything they link is relative and inside the
 * package (the stylesheets, the fonts, images, attachments and PDFs); the only
 * script is the index's small search (`OFFLINE_SEARCH_SCRIPT`, a file of the
 * package, never inline). Every text is escaped as the renderer escapes it, and
 * every link passes `safeUrl` and must be relative.
 */

/** The fixed texts of the offline pages, in the package's language. */
export interface OfflineLabels {
  readonly manuals: string;
  readonly search: string;
  readonly searchHint: string;
  readonly noResults: string;
  readonly allManuals: string;
  readonly downloadPdf: string;
  readonly noManuals: string;
  readonly offline: string;
}

/** The offline pages' texts by primary language: English, German, French; English for any other. */
export const OFFLINE_LABELS: Readonly<Record<string, OfflineLabels>> = {
  en: {
    manuals: 'Manuals',
    search: 'Search',
    searchHint: 'Search titles and headings',
    noResults: 'Nothing found.',
    allManuals: 'All manuals',
    downloadPdf: 'PDF',
    noManuals: 'This package holds no manuals.',
    offline: 'Offline documentation',
  },
  de: {
    manuals: 'Handbücher',
    search: 'Suchen',
    searchHint: 'Titel und Überschriften durchsuchen',
    noResults: 'Nichts gefunden.',
    allManuals: 'Alle Handbücher',
    downloadPdf: 'PDF',
    noManuals: 'Dieses Paket enthält keine Handbücher.',
    offline: 'Offline-Dokumentation',
  },
  fr: {
    manuals: 'Manuels',
    search: 'Rechercher',
    searchHint: 'Rechercher dans les titres',
    noResults: 'Aucun résultat.',
    allManuals: 'Tous les manuels',
    downloadPdf: 'PDF',
    noManuals: 'Ce paquet ne contient aucun manuel.',
    offline: 'Documentation hors ligne',
  },
};

/** The offline pages' texts in `lang` (its primary subtag), else English. */
export function offlineLabels(lang: string): OfflineLabels {
  const primary = lang.split('-')[0]?.toLowerCase() ?? '';
  return (
    Object.hasOwn(OFFLINE_LABELS, primary)
      ? OFFLINE_LABELS[primary]
      : OFFLINE_LABELS['en']
  ) as OfflineLabels;
}

/**
 * The Content Security Policy every offline page carries in a `<meta>`: nothing
 * but the package's own files (`'self'`), no `<style>` element and no inline
 * script; inline styles as attributes only, for the widths the renderer writes.
 * `script` allows the package's search script (the index); a manual page runs
 * none.
 */
export function offlineContentSecurityPolicy(script: boolean): string {
  return [
    "default-src 'none'",
    script ? "script-src 'self'" : "script-src 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The package's stylesheets, from its root: the theme (its fonts beside it, under
 * `fonts/`), its dark values for a viewer who prefers dark, the renderer's and the
 * pages' own (`OFFLINE_SITE_CSS`).
 */
export const OFFLINE_STYLESHEETS = {
  theme: 'assets/theme.css',
  themeDark: 'assets/theme-dark.css',
  content: 'assets/render-html.css',
  site: 'assets/site.css',
} as const;

/** The search script's path in the package, from its root. */
export const OFFLINE_SEARCH_PATH = 'assets/search.js';

/** A path inside the package, from a page `root` (`''` or `../../`): relative, or refused. */
function inside(root: string, path: string): string | undefined {
  const url = safeUrl(`${root}${path}`);
  // Relative only: no scheme, no host, no absolute path.
  if (url === undefined || /^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  if (url.startsWith('/') || url.startsWith('\\')) return undefined;
  return url;
}

/** ` href="…"` (or ` src="…"`) for a path inside the package; nothing for one refused. */
function href(root: string, path: string, name = 'href'): string {
  const url = inside(root, path);
  return url === undefined ? '' : ` ${name}="${esc(url)}"`;
}

/** The `<head>` of an offline page: charset, viewport, the policy, the stylesheets. */
function head(title: string, root: string, script: boolean): string {
  const css = (path: string, media?: string) =>
    `<link rel="stylesheet"${href(root, path)}${media ? ` media="${esc(media)}"` : ''}>`;
  return [
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${esc(offlineContentSecurityPolicy(script))}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(title)}</title>`,
    css(OFFLINE_STYLESHEETS.theme),
    css(OFFLINE_STYLESHEETS.themeDark, '(prefers-color-scheme: dark)'),
    css(OFFLINE_STYLESHEETS.content),
    css(OFFLINE_STYLESHEETS.site),
    '</head>',
  ].join('\n');
}

function html(lang: string, dir: 'ltr' | 'rtl', body: string): string {
  return `<!doctype html>\n<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}">\n${body}\n</html>\n`;
}

/** A manual page of the package: one manual in one variant. */
export interface OfflinePage {
  readonly lang: string;
  readonly dir: 'ltr' | 'rtl';
  /** The page's title: the manual's, and its variant's. */
  readonly title: string;
  /** From the page to the package's root: `../../` for `manuals/<id>/<variant>.html`. */
  readonly root: string;
  /** The manual as `renderManualHtml` wrote it, its links relative to the page. */
  readonly fragment: string;
  /** Its PDF, from the package's root (`pdf/…`); none when the package holds none. */
  readonly pdf?: string;
  /** The line at the foot of every page: the product and its revision. */
  readonly footer: string;
}

/** A manual page: a bar leading back to the index (and to its PDF), the manual, the footer. */
export function offlinePageHtml(page: OfflinePage): string {
  const labels = offlineLabels(page.lang);
  const pdf =
    page.pdf === undefined
      ? ''
      : `<a class="of-offline__pdf"${href(page.root, page.pdf)} type="application/pdf">${esc(labels.downloadPdf)}</a>`;
  return html(
    page.lang,
    page.dir,
    [
      head(page.title, page.root, false),
      '<body class="of-offline">',
      `<nav class="of-offline__bar" aria-label="${esc(labels.manuals)}"><a class="of-offline__home"${href(page.root, 'index.html')}>${esc(labels.allManuals)}</a>${pdf}</nav>`,
      `<main class="of-offline__main">${page.fragment}</main>`,
      `<footer class="of-offline__footer">${esc(page.footer)}</footer>`,
      '</body>',
    ].join('\n'),
  );
}

/** One variant of a manual on the index: its label, its page and its PDF (paths from the root). */
export interface OfflineIndexVariant {
  readonly label: string;
  readonly page: string;
  readonly pdf?: string;
}

export interface OfflineIndexManual {
  readonly title: string;
  readonly variants: readonly OfflineIndexVariant[];
}

/** A heading the search finds: its text, where it leads (from the root) and the manual and variant it is in. */
export interface OfflineSearchEntry {
  readonly text: string;
  readonly page: string;
  readonly context: string;
}

export interface OfflineIndex {
  readonly lang: string;
  readonly dir: 'ltr' | 'rtl';
  /** The package's title: the product and its revision. */
  readonly title: string;
  /** Under the title: the language and audience it is for. */
  readonly subtitle: string;
  readonly manuals: readonly OfflineIndexManual[];
  readonly search: readonly OfflineSearchEntry[];
  readonly footer: string;
}

/**
 * Data in a `<script type="application/json">` element: JSON with `<`, `>` and
 * `&` as escapes, so nothing in it can end the
 * element or start a comment. A data block is never run, so the policy's
 * `script-src` does not apply to it.
 */
function jsonData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * The package's `index.html`: its title, the search (hidden until its script
 * runs, so a browser without script shows only the list) and every manual with
 * its variants' pages and PDFs.
 */
export function offlineIndexHtml(index: OfflineIndex): string {
  const labels = offlineLabels(index.lang);
  const root = '';
  const manuals =
    index.manuals.length === 0
      ? `<p class="of-offline__empty">${esc(labels.noManuals)}</p>`
      : `<ul class="of-offline__manuals">${index.manuals
          .map(
            (m) =>
              `<li class="of-offline__manual"><h3 class="of-offline__manual-title">${esc(m.title)}</h3><ul class="of-offline__variants">${m.variants
                .map(
                  (v) =>
                    `<li class="of-offline__variant"><a class="of-offline__page"${href(root, v.page)}>${esc(v.label || m.title)}</a>${
                      v.pdf === undefined
                        ? ''
                        : ` <a class="of-offline__pdf"${href(root, v.pdf)} type="application/pdf">${esc(labels.downloadPdf)}</a>`
                    }</li>`,
                )
                .join('')}</ul></li>`,
          )
          .join('')}</ul>`;
  // Only entries whose page is inside the package; the script checks again.
  const entries = index.search
    .filter((e) => inside(root, e.page) !== undefined)
    .map((e) => [e.text, e.page, e.context]);
  return html(
    index.lang,
    index.dir,
    [
      head(index.title, root, true),
      '<body class="of-offline of-offline--index">',
      '<header class="of-offline__header">',
      `<p class="of-offline__kicker">${esc(labels.offline)}</p>`,
      `<h1 class="of-offline__title">${esc(index.title)}</h1>`,
      `<p class="of-offline__subtitle">${esc(index.subtitle)}</p>`,
      '</header>',
      `<main class="of-offline__main">`,
      `<div class="of-offline__search" role="search" hidden><label class="of-offline__search-label" for="of-search">${esc(labels.search)}</label><input class="of-offline__search-input" id="of-search" type="search" autocomplete="off" placeholder="${esc(labels.searchHint)}" data-no-results="${esc(labels.noResults)}"><ol class="of-offline__results" id="of-search-results" aria-live="polite"></ol></div>`,
      `<h2 class="of-offline__heading">${esc(labels.manuals)}</h2>`,
      manuals,
      '</main>',
      `<footer class="of-offline__footer">${esc(index.footer)}</footer>`,
      `<script type="application/json" id="of-search-index">${jsonData(entries)}</script>`,
      `<script${href(root, OFFLINE_SEARCH_PATH, 'src')}></script>`,
      '</body>',
    ].join('\n'),
  );
}

/**
 * The index's search (`assets/search.js`): a few lines, no framework. It reads
 * the headings from the index's data block, folds case and diacritics, and lists
 * the headings holding every word typed (at most 50), each a link to its page.
 * It writes text only through `textContent` and links only to pages inside the
 * package (`manuals/…`, no scheme), so nothing in the index becomes markup.
 */
export const OFFLINE_SEARCH_SCRIPT = `(function () {
  'use strict';
  var box = document.querySelector('.of-offline__search');
  var input = document.getElementById('of-search');
  var list = document.getElementById('of-search-results');
  var data = document.getElementById('of-search-index');
  if (!box || !input || !list || !data) return;
  var entries;
  try {
    entries = JSON.parse(data.textContent || '[]');
  } catch (e) {
    return;
  }
  if (!Array.isArray(entries)) return;
  var fold = function (s) {
    return String(s).normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
  };
  var folded = entries.map(function (e) {
    return fold(e[0]) + ' ' + fold(e[2]);
  });
  var inside = function (path) {
    return typeof path === 'string' && /^manuals\\/[^:\\\\]*$/.test(path);
  };
  box.hidden = false;
  input.addEventListener('input', function () {
    var words = fold(input.value).split(/\\s+/).filter(Boolean);
    list.textContent = '';
    if (words.length === 0) return;
    var shown = 0;
    for (var i = 0; i < entries.length && shown < 50; i++) {
      var text = folded[i];
      if (!words.every(function (w) { return text.indexOf(w) !== -1; })) continue;
      if (!inside(entries[i][1])) continue;
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.setAttribute('href', entries[i][1]);
      link.textContent = entries[i][0];
      var where = document.createElement('span');
      where.className = 'of-offline__result-context';
      where.textContent = entries[i][2];
      item.appendChild(link);
      item.appendChild(where);
      list.appendChild(item);
      shown++;
    }
    if (shown === 0) {
      var none = document.createElement('li');
      none.className = 'of-offline__no-results';
      none.textContent = input.getAttribute('data-no-results') || '';
      list.appendChild(none);
    }
  });
})();
`;

/**
 * The offline pages' own layout (`assets/site.css`), on the theme's variables
 * only: a readable column that fits a phone, the bar, the index's list and the
 * search. Every rule is scoped under `.of-offline`.
 */
export const OFFLINE_SITE_CSS = `html { background: var(--background); color: var(--foreground); }
.of-offline { margin: 0; font-family: var(--font-sans); line-height: 1.5; overflow-wrap: anywhere; }
.of-offline .of-offline__main { box-sizing: border-box; max-width: 52rem; margin: 0 auto; padding: 1rem; }
.of-offline .of-offline__bar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; padding: 0.5rem 1rem; background: var(--background); border-block-end: 1px solid var(--border); }
.of-offline .of-offline__header { box-sizing: border-box; max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 0; }
.of-offline .of-offline__kicker { margin: 0; color: var(--muted-foreground); font-size: 0.875rem; }
.of-offline .of-offline__title { margin: 0.25rem 0; font-size: 1.75rem; line-height: 1.2; }
.of-offline .of-offline__subtitle { margin: 0; color: var(--muted-foreground); }
.of-offline .of-offline__heading { margin: 1.5rem 0 0.5rem; font-size: 1.25rem; }
.of-offline a { color: var(--primary); }
.of-offline a:focus-visible, .of-offline input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.of-offline .of-offline__manuals, .of-offline .of-offline__variants, .of-offline .of-offline__results { list-style: none; margin: 0; padding: 0; }
.of-offline .of-offline__manual { padding: 0.75rem 0; border-block-end: 1px solid var(--border); }
.of-offline .of-offline__manual-title { margin: 0 0 0.25rem; font-size: 1rem; }
.of-offline .of-offline__variant { padding: 0.25rem 0; }
.of-offline .of-offline__pdf { margin-inline-start: 0.5rem; font-size: 0.875rem; }
.of-offline .of-offline__bar .of-offline__pdf { margin-inline-start: auto; }
.of-offline .of-offline__search { display: flex; flex-direction: column; gap: 0.5rem; margin: 1rem 0; }
.of-offline .of-offline__search[hidden] { display: none; }
.of-offline .of-offline__search-label { font-weight: 600; }
.of-offline .of-offline__search-input { box-sizing: border-box; width: 100%; padding: 0.5rem 0.75rem; font: inherit; color: var(--foreground); background: var(--background); border: 1px solid var(--input); border-radius: var(--radius); }
.of-offline .of-offline__results li { display: flex; flex-direction: column; padding: 0.25rem 0; }
.of-offline .of-offline__result-context, .of-offline .of-offline__no-results { color: var(--muted-foreground); font-size: 0.875rem; }
.of-offline .of-offline__footer { box-sizing: border-box; max-width: 52rem; margin: 2rem auto 0; padding: 1rem; color: var(--muted-foreground); font-size: 0.875rem; border-block-start: 1px solid var(--border); }
.of-offline img { max-width: 100%; height: auto; }
`;
