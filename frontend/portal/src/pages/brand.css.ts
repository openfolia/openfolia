import { brandCss } from '../lib/site.ts';

/** The brand's colours (#784), a file of the site: the pages' policy takes no inline style. */
export function GET(): Response {
  return new Response(brandCss(), {
    headers: { 'Content-Type': 'text/css; charset=utf-8' },
  });
}
