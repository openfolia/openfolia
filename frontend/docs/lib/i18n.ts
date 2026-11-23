import { defineI18n } from 'fumadocs-core/i18n';

/**
 * English without a prefix (`/api`), German under `/de/` with the same paths (`/de/api`). A page
 * without a German file (`page.de.mdx`) shows its English text under `/de/`, with German chrome
 * and a note; most generated catalogues are written in English only (`README.md`, "Languages").
 *
 * `hideLocale` only shapes the links the source makes: a static export has no middleware, so the
 * routes are laid out for it (`app/(en)/…` and `app/de/…`).
 */
export const i18n = defineI18n({
  languages: ['en', 'de'],
  defaultLanguage: 'en',
  hideLocale: 'default-locale',
  parser: 'dot',
});

export type Lang = (typeof i18n.languages)[number];

export const isLang = (value: string): value is Lang =>
  (i18n.languages as readonly string[]).includes(value);
