import { isLang, type Lang } from './i18n';

/**
 * The texts of `<ServerSetting>` (`components/server-setting.tsx`, #859): a detail only the
 * operator of a server can change, on a page any user reads. The page says what a self-hosted
 * operator sets; the hosted line is always the same.
 */
export const SERVER_SETTING = {
  en: {
    label: 'Who changes this',
    selfHosted: 'Self-hosted',
    hosted: 'Hosted',
    ask: 'Ask your provider or your admin.',
  },
  de: {
    label: 'Wer das ändert',
    selfHosted: 'Selbst betrieben',
    hosted: 'Gehostet',
    ask: 'Fragen Sie Ihren Anbieter oder Ihren Admin.',
  },
} satisfies Record<Lang, Record<string, string>>;

export const serverSettingText = (lang: string | undefined) =>
  SERVER_SETTING[lang !== undefined && isLang(lang) ? lang : 'en'];

/**
 * A page's processed Markdown with each `<ServerSetting>` written out as a quote of its two
 * lines, so a page's Markdown and `llms-full.txt` carry no component. Its body is one paragraph:
 * it is written out on one line.
 */
export const withServerSettingText = (markdown: string): string =>
  markdown.replace(
    /<ServerSetting(?:\s+lang="([a-z]+)")?\s*>([\s\S]*?)<\/ServerSetting>/g,
    (_, lang: string | undefined, body: string) => {
      const text = serverSettingText(lang);
      const selfHosted = body.trim().replace(/\s*\n\s*/g, ' ');
      return `> **${text.selfHosted}:** ${selfHosted}\n>\n> **${text.hosted}:** ${text.ask}`;
    },
  );
