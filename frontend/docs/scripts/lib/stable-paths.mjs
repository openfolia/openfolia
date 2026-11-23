// The docs site's stable addresses (#420): the product's website, the README and the editor link to
// them, so each must exist in every build, in English and, for pages, in German under `/de/`. A
// path that moves keeps working through a redirect page; it never just disappears.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pages: each in English (`/x`) and German (`/de/x`). */
export const STABLE_PAGES = [
  '/',
  '/api',
  '/api/delivery',
  '/api/management',
  '/getting-started',
  '/demo',
  '/self-hosting',
  '/guides/rag',
  '/guides/mcp',
  '/changelog',
  '/agents',
  '/guide',
];

/** Files, at one address each. */
export const STABLE_FILES = [
  '/agents.md',
  '/llms.txt',
  '/llms-full.txt',
  '/guide-index.json',
  '/changelog.xml',
  '/openapi/delivery.yaml',
  '/openapi/delivery.json',
  '/openapi/management.yaml',
  '/openapi/management.json',
];

const german = (path) => (path === '/' ? '/de' : `/de${path}`);

/** The file a page's address is served from in the static export (`trailingSlash`). */
export const pageFile = (outDir, path) => join(outDir, path, 'index.html');

/** What is missing or wrong in the built site at `outDir`; empty when every stable address holds. */
export function checkStablePaths(outDir) {
  const problems = [];
  for (const path of STABLE_PAGES)
    for (const [lang, address] of [
      ['en', path],
      ['de', german(path)],
    ]) {
      const file = pageFile(outDir, address);
      if (!existsSync(file)) {
        problems.push(`${address}: no page (${file} is missing)`);
        continue;
      }
      if (!readFileSync(file, 'utf8').includes(`<html lang="${lang}"`))
        problems.push(
          `${address}: the page is not in ${lang === 'en' ? 'English' : 'German'}`,
        );
    }
  for (const path of STABLE_FILES) {
    const file = join(outDir, path);
    if (!existsSync(file))
      problems.push(`${path}: no file (${file} is missing)`);
    else if (readFileSync(file, 'utf8').trim() === '')
      problems.push(`${path}: the file is empty`);
  }
  const index = join(outDir, 'guide-index.json');
  if (existsSync(index)) {
    try {
      const { articles } = JSON.parse(readFileSync(index, 'utf8'));
      if (!Array.isArray(articles) || articles.length === 0)
        problems.push('/guide-index.json: lists no articles');
      // The editor links to these addresses (#221): each is a page of the built site.
      else
        for (const article of articles)
          for (const [lang, url] of Object.entries(article?.urls ?? {}))
            if (
              typeof url !== 'string' ||
              !url.startsWith('/') ||
              !existsSync(pageFile(outDir, url))
            )
              problems.push(
                `/guide-index.json: ${article?.id} (${lang}) names ${url}, which is no page`,
              );
    } catch {
      problems.push('/guide-index.json: not JSON');
    }
  }
  return problems;
}
