import type { Lang } from './i18n';

/** The site's own texts (Fumadocs' chrome has its own, `uiTranslations`). */
const texts = {
  en: {
    displayName: 'English',
    englishOnly: 'This page is not translated yet; it is shown in English.',
    referenceEnglish:
      'Generated from the source code, this reference is written in English.',
    planned: 'Planned',
    plannedText: 'This page is a placeholder: its content comes with issue',
    apiInEnglish: 'The operation pages are in English:',
    copyright: 'Licensed under the AGPL-3.0.',
    theme: 'Theme',
    searchLoading: 'Loading the search index…',
    searchFailed: 'The search could not be loaded',
    searchFailedText: 'Check your connection and try again.',
    searchRetry: 'Try again',
  },
  de: {
    displayName: 'Deutsch',
    englishOnly:
      'Diese Seite ist noch nicht übersetzt; sie wird auf Englisch angezeigt.',
    referenceEnglish:
      'Diese Referenz wird aus dem Quellcode erzeugt und ist auf Englisch.',
    planned: 'Geplant',
    plannedText: 'Diese Seite ist ein Platzhalter: Ihr Inhalt kommt mit Issue',
    apiInEnglish: 'Die Seiten der einzelnen Operationen sind auf Englisch:',
    copyright: 'Lizenziert unter der AGPL-3.0.',
    theme: 'Darstellung',
    searchLoading: 'Suchindex wird geladen…',
    searchFailed: 'Die Suche konnte nicht geladen werden',
    searchFailedText: 'Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    searchRetry: 'Erneut versuchen',
  },
} satisfies Record<Lang, Record<string, string>>;

export type TextKey = keyof (typeof texts)['en'];

export const t = (lang: Lang, key: TextKey): string => texts[lang][key];
