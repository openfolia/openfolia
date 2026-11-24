// Pages that moved (#820): a page keeps its old address with a redirect, in English and, under
// `/de/`, in German. A static export has no server to answer 301, so each old address is a small
// page of its own that sends the browser on (`<meta http-equiv="refresh">`, plus a canonical link
// for search engines and a visible link for everyone else). `scripts/redirect-pages.mjs` writes
// them after `next build`; `checkStablePaths` holds them to exist.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Old address to new address, English paths; each also holds under `/de/`. */
export const REDIRECTS = {
  '/guide/integrations/static-portal': '/guide/portal',
};

const TEXTS = {
  en: {
    title: 'This page has moved',
    text: 'This page has moved to',
  },
  de: {
    title: 'Diese Seite ist umgezogen',
    text: 'Diese Seite ist umgezogen nach',
  },
};

const german = (path) => `/de${path}`;

/** The address of a redirect page in a language. */
export const redirectAddress = (path, lang) =>
  lang === 'de' ? german(path) : path;

/** The text of one redirect page. `to` is a path of this site, which never holds markup. */
export function redirectPage(lang, to) {
  const target = redirectAddress(to, lang) + '/';
  const { title, text } = TEXTS[lang];
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=${target}">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 16px}</style>
</head>
<body>
<h1>${title}</h1>
<p>${text} <a href="${target}">${target}</a>.</p>
</body>
</html>
`;
}

/** Writes every redirect page into `outDir`; returns how many. */
export function writeRedirectPages(outDir) {
  let count = 0;
  for (const [from, to] of Object.entries(REDIRECTS))
    for (const lang of ['en', 'de']) {
      const dir = join(outDir, redirectAddress(from, lang));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), redirectPage(lang, to));
      count++;
    }
  return count;
}
