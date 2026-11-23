import { isLang, type Lang } from './i18n';
import { docsSettings } from '../scripts/lib/settings.mjs';

const { siteUrl } = docsSettings(process.env);

/** The agent guide of these docs (`/agents`), which pins the release they belong to (#423). */
export const agentGuideUrl = `${siteUrl}/agents`;

/** The texts of the "Install with your coding agent" box (`components/agent-install.tsx`). */
export const AGENT_INSTALL = {
  en: {
    title: 'Install with your coding agent',
    line: `Install OpenFolia for me: fetch and follow this guide ${agentGuideUrl}`,
    note: 'Paste it into your coding agent. It checks what it needs, asks you where and how, and confirms before anything it changes.',
    copy: 'Copy',
    copied: 'Copied',
    guide: 'The guide it follows',
  },
  de: {
    title: 'Mit Ihrem Coding-Agenten installieren',
    line: `Installiere OpenFolia für mich: Lade diese Anleitung und folge ihr: ${agentGuideUrl}`,
    note: 'Fügen Sie die Zeile in Ihren Coding-Agenten ein. Er prüft, was er braucht, fragt Sie, wo und wie, und bestätigt alles, bevor er etwas ändert.',
    copy: 'Kopieren',
    copied: 'Kopiert',
    guide: 'Die Anleitung, der er folgt',
  },
} satisfies Record<Lang, Record<string, string>>;

export const agentInstallText = (lang: string | undefined) =>
  AGENT_INSTALL[lang !== undefined && isLang(lang) ? lang : 'en'];

/**
 * A page's processed Markdown with the box written out as text (`<AgentInstall lang="de" />`
 * becomes its line, quoted), so a page's Markdown and `llms-full.txt` carry no component.
 */
export const withAgentInstallText = (markdown: string): string =>
  markdown.replace(
    /<AgentInstall(?:\s+lang="([a-z]+)")?\s*\/>/g,
    (_, lang: string | undefined) => {
      const text = agentInstallText(lang);
      return `> **${text.title}:** ${text.line}`;
    },
  );
