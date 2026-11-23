import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The changelog's Atom feed (#421): one entry per release, newest first, made from `changelog/<version>.json`
 * by `scripts/generate.mjs` with the site's address (`DOCS_SITE_URL`) in its links.
 */
export const revalidate = false;

export function GET() {
  return new Response(
    readFileSync(join(process.cwd(), 'generated/changelog.xml'), 'utf8'),
    { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } },
  );
}
