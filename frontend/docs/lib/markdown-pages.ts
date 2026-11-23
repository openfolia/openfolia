import type { DocsPage } from './source';
import { i18n } from './i18n';
import { pagesOf } from './tree';
import { withAgentInstallText } from './agent-install';

/**
 * Where a page's Markdown is served (#423): its address plus `.md` (`/guide/writing.md`), the
 * home pages at `/index.md` and `/de/index.md`.
 */
export const markdownPath = (url: string): string =>
  url === '/' ? '/index.md' : url === '/de' ? '/de/index.md' : `${url}.md`;

/** Every page of the site, English and German, by its Markdown path. */
export function markdownPages(): Map<string, DocsPage> {
  return new Map(
    i18n.languages.flatMap((lang) =>
      pagesOf(lang).map((page) => [markdownPath(page.url), page] as const),
    ),
  );
}

/** A page as Markdown: its title, its description and its text after the MDX is processed. */
export async function pageMarkdown(page: DocsPage): Promise<string> {
  const description = page.data.description
    ? `\n\n${page.data.description}`
    : '';
  return `# ${page.data.title}${description}\n\n${withAgentInstallText(await page.data.getText('processed'))}`;
}
