import { docsLlms, siteUrl } from '@/lib/llms';

/** The index for language models (#423): every page, with its address. */
export const revalidate = false;

export async function GET() {
  // The API documents themselves, for a tool that reads OpenAPI rather than pages (#618).
  const documents = [
    '',
    '## OpenAPI documents',
    '',
    ...(['delivery', 'management'] as const).flatMap((api) =>
      (['yaml', 'json'] as const).map(
        (format) =>
          `- [${api === 'delivery' ? 'Delivery' : 'Management'} API, OpenAPI ${format.toUpperCase()}](${siteUrl}/openapi/${api}.${format})`,
      ),
    ),
    '',
  ].join('\n');
  // The guide a coding agent follows to install this release (#423), and every page's Markdown.
  const install = [
    '',
    '## Install with a coding agent',
    '',
    `- [The agent install guide, as Markdown](${siteUrl}/agents.md): install and start OpenFolia, pinned to this release`,
    `- Every page is also served as Markdown at its address plus \`.md\` (${siteUrl}/index.md for the home page)`,
    '',
  ].join('\n');
  return new Response((await docsLlms.index('en')) + install + documents, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
