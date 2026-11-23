import { notFound } from 'next/navigation';
import { markdownPages, pageMarkdown } from '@/lib/markdown-pages';

/**
 * Every page as Markdown (#423), for language models and the pages' "Copy Markdown" action. A
 * static export can't put a route beside the pages' own, so the files are made under `/md/` and
 * moved to their page's address plus `.md` after the build (`scripts/markdown-pages.mjs`):
 * `/md/guide/writing.md` is served at `/guide/writing.md`, the agent guide at `/agents.md`.
 */
export const revalidate = false;
export const dynamicParams = false;

const pages = markdownPages();

export function generateStaticParams() {
  return [...pages.keys()].map((path) => ({
    slug: path.slice(1).split('/'),
  }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const page = pages.get(`/${slug.join('/')}`);
  if (!page) notFound();
  return new Response(await pageMarkdown(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
