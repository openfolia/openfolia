import { docsLlms, siteUrl } from '@/lib/llms';

/** The index for language models (#423): the two ways in (#859), and every page, with its address. */
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
  // The two ways in (#859): a hosted user's agent uses the instance it was given and installs
  // nothing; only someone running OpenFolia themselves follows the install guide.
  const ways = [
    '',
    '## Two ways to use OpenFolia',
    '',
    `- **Use an OpenFolia that runs already** (hosted at an address like https://<team>.openfolia.com, or one an admin gives you): nothing to install. Sign in at that address; the API is the same address plus \`/api\`, called with a service account token made under Admin › Service accounts. Start with [Getting started](${siteUrl}/getting-started.md), [Authenticate with a service account token](${siteUrl}/guide/integrations/authentication.md), [The MCP server](${siteUrl}/guides/mcp.md) and [the user guide](${siteUrl}/guide.md).`,
    `- **Run it yourself**: [Self-hosting](${siteUrl}/self-hosting.md), or the agent install guide below.`,
    '',
    '## Pages',
    '',
  ].join('\n');
  // The guide a coding agent follows to install this release (#423), and every page's Markdown.
  const install = [
    '',
    '## Install with a coding agent (running it yourself)',
    '',
    `- [The agent install guide, as Markdown](${siteUrl}/agents.md): install and start OpenFolia on a machine you run, pinned to this release. Not for an OpenFolia that is hosted for you: there is nothing to install`,
    `- Every page is also served as Markdown at its address plus \`.md\` (${siteUrl}/index.md for the home page)`,
    '',
  ].join('\n');
  const index = (await docsLlms.index('en')).replace(
    /^(# [^\n]*\n(?:\n> [^\n]*\n)?)/,
    (title) => title + ways,
  );
  return new Response(index + install + documents, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
