import { llms } from 'fumadocs-core/source';
import { source, type DocsPage } from './source';
import { docsSettings } from '../scripts/lib/settings.mjs';
import { withAgentInstallText } from './agent-install';

export const { siteUrl } = docsSettings(process.env);

/** `llms.txt` and `llms-full.txt` (#423): the English pages, for language models. */
export const docsLlms = llms(source, {
  renderPage: async (page: DocsPage) =>
    `# ${page.data.title} (${siteUrl}${page.url})\n\n${withAgentInstallText(await page.data.getText('processed'))}`,
});
